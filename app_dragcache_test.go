package main

// DragOutFiles 缓存清理的单元测试：
// go test 运行时 os.Executable 指向临时目录里的测试二进制，
// config.DataDir() 因此落在临时目录，可直接验证 cleanupDragCache 的行为。

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"OssManager/internal/config"
)

func TestCleanupDragCache(t *testing.T) {
	root := filepath.Join(config.DataDir(), "drag-cache")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("创建 drag-cache 失败：%v", err)
	}
	// 场景1：26 小时前的旧目录应被清理；1 小时内的目录必须保留（拖拽成功后外壳可能仍在复制）
	oldDir := filepath.Join(root, "1700000000000000000")
	newDir := filepath.Join(root, "1799999999999999999")
	for _, d := range []string{oldDir, newDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("准备测试目录失败：%v", err)
		}
	}
	oldTime := time.Now().Add(-26 * time.Hour)
	if err := os.Chtimes(oldDir, oldTime, oldTime); err != nil {
		t.Fatalf("改旧目录时间戳失败：%v", err)
	}
	cleanupDragCache()
	if _, err := os.Stat(oldDir); !os.IsNotExist(err) {
		t.Fatalf("超过 24 小时的旧目录未被清理（stat err=%v）", err)
	}
	if _, err := os.Stat(newDir); err != nil {
		t.Fatalf("24 小时内的目录被误删：%v", err)
	}
	// 场景2：普通文件不应被碰，只清目录
	stray := filepath.Join(root, "keep.txt")
	os.WriteFile(stray, []byte("x"), 0o644)
	oldTime2 := time.Now().Add(-30 * time.Hour)
	os.Chtimes(stray, oldTime2, oldTime2)
	cleanupDragCache()
	if _, err := os.Stat(stray); err != nil {
		t.Fatalf("drag-cache 下的普通文件被误删：%v", err)
	}
	// 清理测试产物
	os.RemoveAll(root)
	os.Remove(stray)
}
