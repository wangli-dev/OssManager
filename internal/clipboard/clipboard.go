package clipboard

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	cfHDrop      = 15
	gmemMoveable = 0x0002
)

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")
	shell32  = windows.NewLazySystemDLL("shell32.dll")

	procOpenClipboard              = user32.NewProc("OpenClipboard")
	procCloseClipboard             = user32.NewProc("CloseClipboard")
	procEmptyClipboard             = user32.NewProc("EmptyClipboard")
	procSetClipboardData           = user32.NewProc("SetClipboardData")
	procGetClipboardData           = user32.NewProc("GetClipboardData")
	procIsClipboardFormatAvailable = user32.NewProc("IsClipboardFormatAvailable")
	procGlobalAlloc                = kernel32.NewProc("GlobalAlloc")
	procGlobalLock                 = kernel32.NewProc("GlobalLock")
	procGlobalUnlock               = kernel32.NewProc("GlobalUnlock")
	procGlobalFree                 = kernel32.NewProc("GlobalFree")
	procDragQueryFileW             = shell32.NewProc("DragQueryFileW")
)

type point struct{ x, y int32 }

type dropFiles struct {
	pFiles uint32
	pt     point
	fNC    int32
	fWide  int32
}

func build(paths []string) []byte {
	var text []uint16
	for _, path := range paths {
		for _, r := range path {
			text = append(text, uint16(r))
		}
		text = append(text, 0)
	}
	text = append(text, 0)
	size := int(unsafe.Sizeof(dropFiles{}))
	buf := make([]byte, size+len(text)*2)
	*(*uint32)(unsafe.Pointer(&buf[0])) = uint32(size)
	*(*int32)(unsafe.Pointer(&buf[16])) = 1
	for i, c := range text {
		*(*uint16)(unsafe.Pointer(&buf[size+i*2])) = c
	}
	return buf
}

// CopyFiles 把本地文件路径写入剪贴板（CF_HDROP），可直接粘贴到资源管理器或本程序。
func CopyFiles(paths []string) error {
	if len(paths) == 0 {
		return errors.New("没有可复制的文件")
	}
	buf := build(paths)
	if result, _, _ := procOpenClipboard.Call(0); result == 0 {
		return errors.New("无法打开剪贴板")
	}
	defer procCloseClipboard.Call()
	procEmptyClipboard.Call()
	handle, _, _ := procGlobalAlloc.Call(gmemMoveable, uintptr(len(buf)))
	if handle == 0 {
		return errors.New("分配剪贴板内存失败")
	}
	pointer, _, _ := procGlobalLock.Call(handle)
	if pointer == 0 {
		procGlobalFree.Call(handle)
		return errors.New("锁定剪贴板内存失败")
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(pointer)), len(buf)), buf)
	procGlobalUnlock.Call(handle)
	if result, _, _ := procSetClipboardData.Call(cfHDrop, handle); result == 0 {
		procGlobalFree.Call(handle)
		return errors.New("写入剪贴板失败")
	}
	return nil
}

// PasteFiles 读取剪贴板中的文件路径。
func PasteFiles() ([]string, error) {
	if result, _, _ := procIsClipboardFormatAvailable.Call(cfHDrop); result == 0 {
		return nil, errors.New("剪贴板中没有文件")
	}
	if result, _, _ := procOpenClipboard.Call(0); result == 0 {
		return nil, errors.New("无法打开剪贴板")
	}
	defer procCloseClipboard.Call()
	handle, _, _ := procGetClipboardData.Call(cfHDrop)
	if handle == 0 {
		return nil, errors.New("读取剪贴板失败")
	}
	count, _, _ := procDragQueryFileW.Call(handle, 0xFFFFFFFF, 0, 0)
	if count == 0 {
		return nil, errors.New("剪贴板中没有文件")
	}
	var result []string
	for i := uintptr(0); i < count; i++ {
		length, _, _ := procDragQueryFileW.Call(handle, i, 0, 0)
		if length == 0 {
			continue
		}
		buffer := make([]uint16, length+1)
		procDragQueryFileW.Call(handle, i, uintptr(unsafe.Pointer(&buffer[0])), length+1)
		result = append(result, windows.UTF16ToString(buffer))
	}
	return result, nil
}
