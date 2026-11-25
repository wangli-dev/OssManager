package singleinstance

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32                  = windows.NewLazySystemDLL("user32.dll")
	procFindWindowW         = user32.NewProc("FindWindowW")
	procShowWindow          = user32.NewProc("ShowWindow")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
)

// Acquire 获取命名互斥体；返回 false 表示已有实例在运行。
func Acquire(name string) (bool, error) {
	handle, err := windows.CreateMutex(nil, false, windows.StringToUTF16Ptr(name))
	if err != nil {
		return false, err
	}
	if windows.GetLastError() == windows.ERROR_ALREADY_EXISTS {
		windows.CloseHandle(handle)
		return false, nil
	}
	return true, nil
}

// Activate 按窗口标题查找已运行实例，恢复并置前；失败时静默返回。
func Activate(title string) {
	pointer, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	handle, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(pointer)))
	if handle == 0 {
		return
	}
	procShowWindow.Call(handle, 9)
	procSetForegroundWindow.Call(handle)
}
