package shelldrag

import (
	"os"
	"testing"
	"unsafe"
	"golang.org/x/sys/windows"
)

// makeHDrop 生成的内存块应含 DROPFILES 头与双零结尾的 UTF-16 路径表。
func TestMakeHDrop(t *testing.T) {
	paths := []string{`C:\tmp\a.txt`, `C:\tmp\图片 b.png`}
	h, err := makeHDrop(paths)
	if err != nil {
		t.Fatalf("makeHDrop: %v", err)
	}
	defer procGlobalFree.Call(uintptr(h))
	ptr, _, _ := procGlobalLock.Call(uintptr(h))
	if ptr == 0 {
		t.Fatal("GlobalLock failed")
	}
	defer procGlobalUnlock.Call(uintptr(h))
	head := (*dropFiles)(unsafe.Pointer(ptr))
	if head.pFiles != 20 {
		t.Fatalf("pFiles = %d, want 20", head.pFiles)
	}
	// 从偏移 20 读 UTF-16 路径串，按双零截断
	raw := (*[1 << 16]uint16)(unsafe.Pointer(uintptr(ptr) + 20))[:]
	var names []string
	var cur []uint16
	for _, c := range raw {
		if c == 0 {
			if len(cur) == 0 {
				break
			}
			names = append(names, windows.UTF16ToString(cur))
			cur = nil
			continue
		}
		cur = append(cur, c)
	}
	if len(names) != 2 || names[0] != paths[0] || names[1] != paths[1] {
		t.Fatalf("names = %v", names)
	}
}

// 无鼠标按下时 DoDragDrop 应立即返回（不阻塞不崩溃），验证 COM 调用链。
func TestDragOutWithoutMouseReturns(t *testing.T) {
	p := filepath_or_tmp(t)
	dropped, err := DragOut([]string{p})
	if err != nil {
		t.Fatalf("DragOut: %v", err)
	}
	if dropped {
		t.Log("unexpectedly dropped (interactive environment?)")
	}
}

func filepath_or_tmp(t *testing.T) string {
	p, err := os.CreateTemp("", "drag*.txt")
	if err != nil {
		t.Fatal(err)
	}
	p.Close()
	return p.Name()
}
