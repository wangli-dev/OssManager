package main

// 恢复挂载筛选逻辑（selectMountTasks）的表驱动单测，覆盖：
// 正常恢复 / remote 去重 / 外部进程已挂载跳过并清记录 / 盘符已存在跳过 / 空 remote 跳过 / 默认卷标回填。

import (
	"strings"
	"testing"

	"OssManager/internal/config"
	"OssManager/internal/mount"
)

func TestSelectMountTasks(t *testing.T) {
	records := []config.MountRecord{
		{Remote: "conn-a:", Drive: "F:", VolumeName: "卷A"},
		{Remote: "conn-b:", Drive: "G:"},
		{Remote: "conn-c:", Drive: "H:"},  // 外部已挂载 → 跳过并清记录
		{Remote: "conn-d:", Drive: "I:"},  // 盘符已存在 → 跳过
		{Remote: "", Drive: "J:"},         // 空 remote → 跳过
		{Remote: "conn-a:", Drive: "K:"},  // remote 重复 → 跳过（先到先得）
	}
	external := map[string]bool{"conn-c": true}
	present := func(drive string) bool { return drive == "I:" }
	var removed []string
	tasks := selectMountTasks(records, external, present,
		func(drive string) { removed = append(removed, drive) },
		func(remote string) mount.Options { return mount.Options{} },
		func(remote string) string { return strings.TrimSuffix(remote, ":") })

	if len(tasks) != 2 {
		t.Fatalf("应恢复 2 个盘符，实际 %d：%+v", len(tasks), tasks)
	}
	if tasks[0].drive != "F:" || tasks[0].remote != "conn-a:" || tasks[0].options.VolumeName != "卷A" {
		t.Fatalf("已保存卷标应保留，实际 %+v", tasks[0])
	}
	if tasks[1].drive != "G:" || tasks[1].remote != "conn-b:" || tasks[1].options.VolumeName != "conn-b" {
		t.Fatalf("无卷标时应回填默认卷标，实际 %+v", tasks[1])
	}
	if len(removed) != 1 || removed[0] != "H:" {
		t.Fatalf("外部已挂载连接的旧记录应被清理，实际清理：%v", removed)
	}
}
