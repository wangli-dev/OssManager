package config

import (
	"os"
	"strings"
	"testing"
)

// writeTestMounts 把挂载记录写进当前测试进程的数据目录，并在用例结束时清理。
func writeTestMounts(t *testing.T, content string) {
	t.Helper()
	t.Setenv("LOCALAPPDATA", t.TempDir())
	if err := os.WriteFile(MountRecordPath(), []byte(content), 0o644); err != nil {
		t.Fatalf("写入挂载记录失败: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(MountRecordPath()) })
}

// readTestMounts 返回当前记录文件内容，便于断言写回结果。
func readTestMounts(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(MountRecordPath())
	if err != nil {
		t.Fatalf("读取挂载记录失败: %v", err)
	}
	return string(data)
}

// 路径型记录必须保留路径，不能补成 host:/:（曾经的 SFTP 挂载全空就是这里造成的）。
func TestReadMountRecordsKeepsPath(t *testing.T) {
	writeTestMounts(t, "ssh-a:/|G:\nminio|M:\nssh-b:/|K:|自定义卷标\nssh-a:/root|N:\nssh-a:/|Q:\n")

	records := ReadMountRecords()
	want := []MountRecord{
		{Remote: "ssh-a:/", Drive: "G:", VolumeName: ""},
		{Remote: "minio:", Drive: "M:", VolumeName: ""},
		{Remote: "ssh-b:/", Drive: "K:", VolumeName: "自定义卷标"},
		{Remote: "ssh-a:/root", Drive: "N:", VolumeName: ""},
	}
	if len(records) != len(want) {
		t.Fatalf("记录条数 = %d, 期望 %d: %+v", len(records), len(want), records)
	}
	for index, expected := range want {
		if records[index] != expected {
			t.Errorf("第 %d 条 = %+v, 期望 %+v", index, records[index], expected)
		}
	}
}

// 删除连接要能清掉该连接的所有路径记录，其他连接不受影响。
func TestRemoveMountRecords(t *testing.T) {
	writeTestMounts(t, "ssh-a:/|G:\nminio|M:\nssh-a:/root|N:\n")

	if !RemoveMountRecords("ssh-a") {
		t.Fatal("RemoveMountRecords 应返回改动")
	}
	left := readTestMounts(t)
	if strings.Contains(left, "ssh-a") {
		t.Errorf("ssh-a 的记录未清干净: %q", left)
	}
	if !strings.Contains(left, "minio") {
		t.Errorf("其他连接的记录被误删: %q", left)
	}
	// 再次删除不应产生改动。
	if RemoveMountRecords("ssh-a") {
		t.Error("重复删除应返回无改动")
	}
}

// 改名要保留路径与卷标，保证重启后还能按新名字恢复挂载。
func TestRenameMountRecords(t *testing.T) {
	writeTestMounts(t, "ssh-a:/|G:|卷标A\nssh-a:/root|N:\nminio|M:\n")

	if !RenameMountRecords("ssh-a", "ssh-z") {
		t.Fatal("RenameMountRecords 应返回改动")
	}
	records := ReadMountRecords()
	want := []MountRecord{
		{Remote: "ssh-z:/", Drive: "G:", VolumeName: "卷标A"},
		{Remote: "ssh-z:/root", Drive: "N:", VolumeName: ""},
		{Remote: "minio:", Drive: "M:", VolumeName: ""},
	}
	if len(records) != len(want) {
		t.Fatalf("记录条数 = %d, 期望 %d: %+v", len(records), len(want), records)
	}
	for index, expected := range want {
		if records[index] != expected {
			t.Errorf("第 %d 条 = %+v, 期望 %+v", index, records[index], expected)
		}
	}
}
