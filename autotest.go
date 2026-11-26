package main

import (
	"context"
	"os"

	"OssManager/internal/config"
	"OssManager/internal/mount"
	"OssManager/internal/policy"
	"OssManager/internal/rclonefs"
)

func driveExists(drive string) bool {
	_, err := os.Stat(drive + `\`)
	return err == nil
}

// runAutotest 是开发期自检：不使用界面，直接验证连接、浏览、策略、挂载与卸载。
func runAutotest() {
	settings := config.LoadSettings()
	ctx := context.Background()
	logf("autotest start conf=%s", settings.RcloneConfig)
	connections, err := config.ListConnections(settings.RcloneConfig)
	if err != nil {
		logf("autotest list connections err=%v", err)
		return
	}
	logf("autotest connections=%d", len(connections))
	for _, external := range mount.CachedExternal() {
		logf("autotest external remote=%s drive=%s pid=%d present=%v", external.Remote, external.Drive, external.PID, mount.DrivePresent(external.Drive))
	}
	probe := NewApp()
	probe.settings = settings
	for _, drive := range probe.LocalDrives() {
		if drive.Kind == "rclone" {
			logf("autotest rclone drive %s label=%s", drive.Root, drive.Label)
		}
	}
	if len(connections) == 0 {
		return
	}
	name := connections[0].Name
	// 支持 --autotest <连接名> 指定连接，便于定位特定连接的挂载问题。
	if len(os.Args) > 2 {
		name = os.Args[2]
	}
	entries, err := rclonefs.List(ctx, settings.RcloneConfig, name+":")
	logf("autotest list %s entries=%d err=%v", name, len(entries), err)
	if len(entries) > 0 {
		bucket := entries[0].Name
		text, err := policy.Get(ctx, settings.RcloneConfig, name, bucket)
		logf("autotest policy %s bytes=%d err=%v", bucket, len(text), err)
	}
	manager := mount.NewManager()
	// 挂连接根目录（与生产 mounts.txt 的路径型记录一致），并做进程内 readdir 计数。
	if err := manager.Mount(ctx, settings.RcloneConfig, name+":/", "Z:", mount.Options{}); err != nil {
		logf("autotest mount err=%v", err)
		return
	}
	zed, zerr := os.ReadDir("Z:" + "\\")
	logf("autotest mount ok Z=%v readdir=%d err=%v", driveExists("Z:"), len(zed), zerr)
	if err := manager.Unmount("Z:"); err != nil {
		logf("autotest unmount err=%v", err)
	} else {
		logf("autotest unmount ok Z=%v", driveExists("Z:"))
	}
}
