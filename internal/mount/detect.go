package mount

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
)

// External 描述一条由独立 rclone.exe 进程挂载的盘符。
type External struct {
	Drive  string
	Remote string
	Volume string
	PID    int
}

// hiddenWindow 让子进程不弹出控制台窗口。
func hiddenWindow() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

// encodeCommand 把 PowerShell 脚本转成 -EncodedCommand 需要的 Base64(UTF-16LE)，
// 避免脚本中的引号在参数传递时被 Windows 命令行重新转义。
func encodeCommand(script string) string {
	units := utf16.Encode([]rune(script))
	buffer := make([]byte, len(units)*2)
	for index, unit := range units {
		buffer[index*2] = byte(unit)
		buffer[index*2+1] = byte(unit >> 8)
	}
	return base64.StdEncoding.EncodeToString(buffer)
}

// DetectExternal 通过 rclone.exe 进程命令行识别本程序之外的挂载。
// 没有 rclone.exe 或查询失败时返回空列表，不视为错误。
func DetectExternal() []External {
	script := "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \"Name='rclone.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"
	command := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand(script))
	command.SysProcAttr = hiddenWindow()
	type result struct{ data []byte }
	done := make(chan result, 1)
	go func() {
		data, _ := command.Output()
		done <- result{data: data}
	}()
	var output []byte
	select {
	case value := <-done:
		output = value.data
	case <-time.After(6 * time.Second):
		if command.Process != nil {
			_ = command.Process.Kill()
		}
		return nil
	}
	var entries []External
	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, "\t", 2)
		if len(fields) != 2 {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(fields[0]))
		if err != nil {
			continue
		}
		remote, drive, volume, ok := parseMountCommand(fields[1])
		if !ok {
			continue
		}
		entries = append(entries, External{Drive: drive, Remote: remote, Volume: volume, PID: pid})
	}
	return entries
}

// splitArgs 按空格切分命令行，双引号内的空格保留。
func splitArgs(line string) []string {
	var result []string
	var current strings.Builder
	inQuote := false
	for _, char := range line {
		switch {
		case char == '"':
			inQuote = !inQuote
		case char == ' ' && !inQuote:
			if current.Len() > 0 {
				result = append(result, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(char)
		}
	}
	if current.Len() > 0 {
		result = append(result, current.String())
	}
	return result
}

// parseMountCommand 从 rclone mount 命令行解析 remote、盘符与卷标。
func parseMountCommand(line string) (remote, drive, volume string, ok bool) {
	args := splitArgs(line)
	mountIndex := -1
	for index, arg := range args {
		if arg == "mount" {
			mountIndex = index
			break
		}
	}
	if mountIndex < 0 || mountIndex+2 >= len(args) {
		return "", "", "", false
	}
	source := args[mountIndex+1]
	target := args[mountIndex+2]
	colon := strings.Index(source, ":")
	if colon <= 0 || len(target) != 2 || target[1] != ':' {
		return "", "", "", false
	}
	remote = source[:colon]
	drive = strings.ToUpper(target)
	for index, arg := range args {
		if strings.HasPrefix(arg, "--volname=") {
			volume = strings.TrimPrefix(arg, "--volname=")
		} else if arg == "--volname" && index+1 < len(args) {
			volume = args[index+1]
		}
	}
	if volume == "" {
		volume = remote
	}
	return remote, drive, volume, true
}

// StopExternal 结束挂载指定盘符的 rclone.exe 进程。
func StopExternal(drive string) error {
	for _, entry := range DetectExternal() {
		if !strings.EqualFold(entry.Drive, drive) {
			continue
		}
		command := exec.Command("taskkill", "/PID", strconv.Itoa(entry.PID), "/T", "/F")
		command.SysProcAttr = hiddenWindow()
		if output, err := command.CombinedOutput(); err != nil {
			return fmt.Errorf("结束 rclone 进程失败：%v %s", err, strings.TrimSpace(string(output)))
		}
		return nil
	}
	return errors.New("没有找到挂载该盘符的 rclone 进程")
}

// FindExternalByRemote 返回指定连接对应的外部挂载。
func FindExternalByRemote(remote string) (External, bool) {
	target := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(remote)), ":")
	for _, entry := range CachedExternal() {
		if strings.TrimSuffix(strings.ToLower(entry.Remote), ":") == target {
			return entry, true
		}
	}
	return External{}, false
}

// DrivePresent 判断盘符当前是否可访问，超时按不可用处理，避免断开的网络盘卡住界面。
func DrivePresent(drive string) bool {
	done := make(chan bool, 1)
	go func() {
		_, err := os.Stat(drive + `\`)
		done <- err == nil
	}()
	select {
	case value := <-done:
		return value
	case <-time.After(3 * time.Second):
		return false
	}
}

// WaitDriveGone 等待盘符释放，最多等待 timeout。
func WaitDriveGone(drive string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !DrivePresent(drive) {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

var (
	externalMu    sync.Mutex
	externalCache []External
	externalAt    time.Time
)

// CachedExternal 返回缓存的进程外挂载，避免每次刷新界面都启动一次 PowerShell。
func CachedExternal() []External {
	externalMu.Lock()
	defer externalMu.Unlock()
	if externalCache != nil && time.Since(externalAt) < 20*time.Second {
		return externalCache
	}
	externalCache = DetectExternal()
	externalAt = time.Now()
	return externalCache
}

// InvalidateExternal 清空缓存，在挂载或卸载后调用。
func InvalidateExternal() {
	externalMu.Lock()
	defer externalMu.Unlock()
	externalCache = nil
	externalAt = time.Time{}
}
