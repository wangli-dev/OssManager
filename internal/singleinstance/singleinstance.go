package singleinstance

import (
	"golang.org/x/sys/windows"
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
