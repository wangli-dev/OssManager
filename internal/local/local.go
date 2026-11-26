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
)

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
		if value, _, err := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(root)))); err == nil {
			switch value {
			case 2:
				drive.Kind = "removable"
			case 4:
				drive.Kind = "network"
			case 5:
				drive.Kind = "cdrom"
			}
		}
		if label := volumeLabel(root); label != "" {
			drive.Label = label
		}
		result = append(result, drive)
	}
	return result
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

// Exists 判断本地路径是否存在。
func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
