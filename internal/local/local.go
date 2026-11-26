package local

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows/registry"
)

// Share 是一个已映射或已记住的网络共享。
type Share struct {
	Remote string `json:"remote"`
	Local  string `json:"local"`
	// Label 是资源管理器里为该映射设置的显示名称（_LabelFromReg），为空时由前端按共享名生成。
	Label string `json:"label"`
}

var (
	mpr                   = syscall.NewLazyDLL("mpr.dll")
	procWNetOpenEnumW     = mpr.NewProc("WNetOpenEnumW")
	procWNetEnumResourceW = mpr.NewProc("WNetEnumResourceW")
	procWNetCloseEnum     = mpr.NewProc("WNetCloseEnum")
)

const (
	resourceConnected  = 1
	resourceRemembered = 3
	resourceTypeDisk   = 1
	errorMoreData      = 234
)

type netResource struct {
	Scope       uint32
	Type        uint32
	DisplayType uint32
	Usage       uint32
	LocalName   *uint16
	RemoteName  *uint16
	Comment     *uint16
	Provider    *uint16
}

// NetworkShares 枚举已映射的网络共享（含断连但记住的盘符）。
func NetworkShares() []Share {
	seen := map[string]bool{}
	var result []Share
	for _, scope := range []uintptr{resourceConnected, resourceRemembered} {
		for _, share := range enumerateShares(scope) {
			key := strings.ToLower(share.Remote)
			if seen[key] {
				continue
			}
			seen[key] = true
			result = append(result, share)
		}
	}
	return result
}

func enumerateShares(scope uintptr) []Share {
	var handle syscall.Handle
	ret, _, _ := procWNetOpenEnumW.Call(scope, resourceTypeDisk, 0, 0, uintptr(unsafe.Pointer(&handle)))
	if ret != 0 {
		return nil
	}
	defer procWNetCloseEnum.Call(uintptr(handle))

	var result []Share
	buffer := make([]byte, 16*1024)
	for {
		count := uint32(0xFFFFFFFF)
		size := uint32(len(buffer))
		ret, _, _ := procWNetEnumResourceW.Call(
			uintptr(handle),
			uintptr(unsafe.Pointer(&count)),
			uintptr(unsafe.Pointer(&buffer[0])),
			uintptr(unsafe.Pointer(&size)),
		)
		if ret == errorMoreData {
			continue
		}
		if ret != 0 || count == 0 {
			break
		}
		items := unsafe.Slice((*netResource)(unsafe.Pointer(&buffer[0])), count)
		for index := 0; index < int(count); index++ {
			remote := utf16PtrString(items[index].RemoteName)
			if !strings.HasPrefix(remote, `\\`) {
				continue
			}
			result = append(result, Share{
				Remote: remote,
				Local:  utf16PtrString(items[index].LocalName),
				Label:  networkLabel(remote),
			})
		}
	}
	return result
}

func utf16PtrString(value *uint16) string {
	if value == nil {
		return ""
	}
	var chars []uint16
	for ptr := unsafe.Pointer(value); ; ptr = unsafe.Add(ptr, 2) {
		current := *(*uint16)(ptr)
		if current == 0 {
			break
		}
		chars = append(chars, current)
	}
	return syscall.UTF16ToString(chars)
}

// Entry 是本地目录中的一项。
type Entry struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"`
}

// Drive 是一个可浏览的本地盘符或网络位置。
type Drive struct {
	Root  string `json:"root"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
}

var (
	kernel32                  = syscall.NewLazyDLL("kernel32.dll")
	procGetLogicalDrives      = kernel32.NewProc("GetLogicalDrives")
	procGetDriveTypeW         = kernel32.NewProc("GetDriveTypeW")
	procGetVolumeInformationW = kernel32.NewProc("GetVolumeInformationW")
	procWNetGetConnectionW    = mpr.NewProc("WNetGetConnectionW")
)

// List 列出本地目录；路径支持盘符、UNC 共享与正反斜杠混写。
func List(path string) ([]Entry, error) {
	value := strings.TrimSpace(path)
	if value == "" {
		return nil, fmt.Errorf("路径为空")
	}
	value = filepath.Clean(value)
	items, err := os.ReadDir(value)
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(items))
	for _, item := range items {
		entry := Entry{Name: item.Name(), IsDir: item.IsDir()}
		if info, infoErr := item.Info(); infoErr == nil {
			if !entry.IsDir {
				entry.Size = info.Size()
			}
			entry.ModTime = info.ModTime().Format("2006-01-02 15:04")
		}
		entries = append(entries, entry)
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return entries, nil
}

// Drives 枚举当前存在的盘符及其卷标，网络盘标为 network。
func Drives() []Drive {
	mask, _, _ := procGetLogicalDrives.Call()
	var result []Drive
	for index := 0; index < 26; index++ {
		if mask&(1<<uint(index)) == 0 {
			continue
		}
		root := string(rune('A'+index)) + `:\`
		drive := Drive{Root: root, Label: string(rune('A' + index)), Kind: "fixed"}
		// Proc.Call 的 err 恒为非 nil，必须看第一个返回值，否则网络盘会被当成固定盘。
		if value, _, _ := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(root)))); value != 0 {
			switch value {
			case 2:
				drive.Kind = "removable"
			case 4:
				drive.Kind = "network"
			case 5:
				drive.Kind = "cdrom"
			case 6:
				drive.Kind = "ramdisk"
			}
		}
		if label := volumeLabel(root); label != "" {
			drive.Label = label
		}
		// 网络盘用资源管理器里设置的映射名称，与「此电脑」里显示的一致；没有设置时退回共享名。
		if drive.Kind == "network" {
			if unc := networkConnection(root); unc != "" {
				label := networkLabel(unc)
				if label == "" {
					label = shareBaseName(unc)
				}
				if label != "" {
					drive.Label = label
				}
			}
		}
		result = append(result, drive)
	}
	return result
}

// networkConnection 读取盘符对应的 UNC 共享路径；非映射盘返回空。
func networkConnection(root string) string {
	buffer := make([]uint16, syscall.MAX_PATH+1)
	size := uint32(len(buffer))
	ret, _, _ := procWNetGetConnectionW.Call(
		uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(strings.TrimSuffix(root, `\`)))),
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(unsafe.Pointer(&size)),
	)
	if ret != 0 {
		return ""
	}
	return syscall.UTF16ToString(buffer)
}

// shareBaseName 取 UNC 路径最后一段作为共享名称。
func shareBaseName(unc string) string {
	parts := strings.FieldsFunc(strings.TrimSpace(unc), func(r rune) bool { return r == '\\' || r == '/' })
	if len(parts) == 0 {
		return ""
	}
	return parts[len(parts)-1]
}

// networkLabel 读取资源管理器为网络映射保存的显示名称（_LabelFromReg），
// 该名称可在「此电脑」里重命名，读取后连接列表与盘符下拉才能与系统显示一致。
func networkLabel(remote string) string {
	key, err := registry.OpenKey(registry.CURRENT_USER, mountPointsKey(remote), registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer key.Close()
	value, _, err := key.GetStringValue("_LabelFromReg")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

// mountPointsKey 把 \\server\share 转成 MountPoints2 下的注册表路径。
func mountPointsKey(remote string) string {
	value := strings.TrimPrefix(strings.TrimSpace(remote), `\\`)
	value = strings.TrimPrefix(value, "//")
	value = strings.NewReplacer(`\`, "#", "/", "#").Replace(value)
	return `Software\Microsoft\Windows\CurrentVersion\Explorer\MountPoints2\##` + value
}

// volumeLabel 读取卷标；网络盘无响应时按空处理，避免拖慢界面。
func volumeLabel(root string) string {
	type result struct{ text string }
	done := make(chan result, 1)
	go func() {
		buffer := make([]uint16, syscall.MAX_PATH+1)
		nameBuffer := make([]uint16, syscall.MAX_PATH+1)
		_, _, _ = procGetVolumeInformationW.Call(
			uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(root))),
			uintptr(unsafe.Pointer(&buffer[0])),
			uintptr(len(buffer)),
			0, 0, 0,
			uintptr(unsafe.Pointer(&nameBuffer[0])),
			uintptr(len(nameBuffer)),
		)
		done <- result{text: syscall.UTF16ToString(buffer)}
	}()
	select {
	case value := <-done:
		return strings.TrimSpace(value.text)
	case <-time.After(1500 * time.Millisecond):
		return ""
	}
}

// IsUNC 判断路径是否为 \\server\share 形式。
func IsUNC(path string) bool {
	value := strings.TrimSpace(path)
	return strings.HasPrefix(value, `\\`) || strings.HasPrefix(value, "//")
}

// MountNetwork 用系统凭据连接局域网共享目录，凭据为空时使用当前用户身份。
func MountNetwork(unc, user, password string) error {
	value := strings.TrimSpace(unc)
	if !IsUNC(value) {
		return fmt.Errorf("路径应为 \\\\服务器\\共享 形式")
	}
	args := []string{"use", value, "/persistent:no"}
	if strings.TrimSpace(user) != "" {
		args = append(args, "/user:"+strings.TrimSpace(user))
		if password != "" {
			args = append(args, password)
		}
	}
	command := exec.Command("net", args...)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if output, err := command.CombinedOutput(); err != nil {
		text := strings.TrimSpace(string(output))
		if text == "" {
			return err
		}
		return fmt.Errorf("%s", text)
	}
	return nil
}

// UnmountNetwork 断开局域网共享连接。
func UnmountNetwork(unc string) error {
	command := exec.Command("net", "use", strings.TrimSpace(unc), "/delete", "/y")
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(string(output)))
	}
	return nil
}

// RemapNetwork 把已映射的共享改挂到新盘符：先断开旧映射，再按新盘符建立映射。
func RemapNetwork(unc, drive string) error {
	value := strings.TrimSpace(unc)
	if !IsUNC(value) {
		return fmt.Errorf("路径应为 \\\\服务器\\共享 形式")
	}
	target := strings.ToUpper(strings.TrimSpace(drive))
	if len(target) != 2 || target[1] != ':' {
		return fmt.Errorf("盘符应为 D: 形式")
	}
	current := ""
	for _, share := range NetworkShares() {
		if strings.EqualFold(share.Remote, value) {
			current = strings.ToUpper(strings.TrimSpace(share.Local))
			break
		}
	}
	if current == target {
		return nil
	}
	if current != "" {
		if err := UnmountNetwork(value); err != nil {
			return err
		}
	}
	command := exec.Command("net", "use", target, value, "/persistent:no")
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if output, err := command.CombinedOutput(); err != nil {
		text := strings.TrimSpace(string(output))
		if text == "" {
			return err
		}
		return fmt.Errorf("%s", text)
	}
	return nil
}

// Exists 判断本地路径是否存在。
func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
