package filemanager

import (
	"os"
	"os/exec"
)

var candidates = []string{
	`D:\Program Files\Pulse\pulse.exe`,
	`C:\Program Files\Pulse\pulse.exe`,
	`D:\tools\Directory Opus\dopus.exe`,
	`C:\Program Files\Directory Opus\dopus.exe`,
	`C:\Program Files (x86)\Directory Opus\dopus.exe`,
}

// Open 用配置的程序打开目录；未配置时自动探测 Pulse 与 Directory Opus，最后回退资源管理器。
func Open(path, configured string) error {
	if configured != "" {
		if _, err := os.Stat(configured); err == nil {
			return exec.Command(configured, path).Start()
		}
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return exec.Command(candidate, path).Start()
		}
	}
	return exec.Command("explorer.exe", path).Start()
}

// Preview 用系统默认程序打开文件。
func Preview(path string) error {
	return exec.Command("cmd", "/c", "start", "", `"`+path+`"`).Start()
}
