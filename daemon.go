package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows/registry"

	"OssManager/internal/config"
	"OssManager/internal/mount"
	"OssManager/internal/singleinstance"
)

// 后台挂载进程：独立于主窗口运行，轮询 mounts.txt 并维护盘符，
// 这样关闭主界面后挂载仍然可用。使用独立互斥体，可与主程序同时运行。
const mountDaemonMutex = "OssManagerMountDaemon"

func daemonLogf(format string, args ...interface{}) {
	_ = os.MkdirAll(config.DataDir(), 0o755)
	file, err := os.OpenFile(filepath.Join(config.DataDir(), "mount-daemon.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer file.Close()
	fmt.Fprintf(file, "%s %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
}

// runMountDaemon 是无界面后台挂载循环；主程序通过 mounts.txt 增删挂载记录。
func runMountDaemon() {
	acquired, err := singleinstance.Acquire(mountDaemonMutex)
	if err != nil || !acquired {
		return
	}
	rotateLog(filepath.Join(config.DataDir(), "mount-daemon.log"), 2<<20)
	settings := config.LoadSettings()
	ctx := context.Background()
	manager := mount.NewManager()
	lastAttempt := map[string]time.Time{}
	lastProblem := map[string]string{}
	idleSince := time.Now()
	daemonLogf("start conf=%s", settings.RcloneConfig)

	for {
		records := config.ReadMountRecords()
		desired := map[string]config.MountRecord{}
		for _, record := range records {
			desired[strings.ToUpper(record.Drive)] = record
		}
		// 记录被删除或换了连接时卸载。
		for drive, remote := range manager.List() {
			key := strings.ToUpper(drive)
			record, ok := desired[key]
			if ok && strings.EqualFold(config.NormalizeRemote(record.Remote), remote) {
				continue
			}
			if err := manager.Unmount(drive); err != nil {
				daemonLogf("unmount %s err=%v", drive, err)
			} else {
				daemonLogf("unmount %s (%s)", drive, remote)
			}
		}
		// 挂载缺失的记录；失败后 30 秒重试，避免日志刷屏。
		mounted := manager.List()
		for drive, record := range desired {
			if _, ok := mounted[drive]; ok {
				continue
			}
			if mount.DrivePresent(drive) {
				problem := "盘符被其他程序占用"
				if lastProblem[drive] != problem {
					daemonLogf("skip %s %s: %s", record.Remote, drive, problem)
					lastProblem[drive] = problem
				}
				continue
			}
			if last, ok := lastAttempt[drive]; ok && time.Since(last) < 30*time.Second {
				continue
			}
			lastAttempt[drive] = time.Now()
			settings = config.LoadSettings()
			options := mountOptionsFor(settings, record.Remote)
			if record.VolumeName != "" {
				options.VolumeName = record.VolumeName
			} else {
				options.VolumeName = config.RemoteName(record.Remote)
			}
			if err := manager.Mount(ctx, settings.RcloneConfig, record.Remote, drive, options); err != nil {
				problem := err.Error()
				if lastProblem[drive] != problem {
					daemonLogf("mount %s %s err=%v", record.Remote, drive, err)
					lastProblem[drive] = problem
				}
			} else {
				daemonLogf("mount %s %s ok volume=%s", record.Remote, drive, options.VolumeName)
				delete(lastProblem, drive)
			}
		}
		// 没有挂载需求时进程自行退出，避免长期占着 exe。
		if len(desired) == 0 && len(manager.List()) == 0 {
			if time.Since(idleSince) > 60*time.Second {
				daemonLogf("exit idle")
				return
			}
		} else {
			idleSince = time.Now()
		}
		time.Sleep(2 * time.Second)
	}
}

// ensureMountDaemon 启动后台挂载进程；已有实例时新进程会因互斥体直接退出。
func ensureMountDaemon() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	command := exec.Command(exe, "--mount-daemon")
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return command.Start()
}

// syncAutoStart 在 HKCU\...\Run 写入或移除后台挂载服务，登录后无需打开主窗口。
func syncAutoStart(enabled bool) {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE)
	if err != nil {
		logf("autostart open key err=%v", err)
		return
	}
	defer key.Close()
	if !enabled {
		_ = key.DeleteValue("OssManager")
		return
	}
	exe, err := os.Executable()
	if err != nil {
		logf("autostart exe err=%v", err)
		return
	}
	value := fmt.Sprintf("\"%s\" --mount-daemon", exe)
	if err := key.SetStringValue("OssManager", value); err != nil {
		logf("autostart set err=%v", err)
		return
	}
	logf("autostart set %s", value)
}

func waitForDrives(drives []string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		ready := true
		for _, drive := range drives {
			if !mount.DrivePresent(drive) {
				ready = false
				break
			}
		}
		if ready {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func waitForDrivesGone(drives []string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		gone := true
		for _, drive := range drives {
			if mount.DrivePresent(drive) {
				gone = false
				break
			}
		}
		if gone {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(500 * time.Millisecond)
	}
}
