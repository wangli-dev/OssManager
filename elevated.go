package main

// 管理员令牌检测与提醒：UAC 下管理员与标准令牌属于不同登录会话，
// WinFsp 本地盘模式挂载的盘符仅对创建它的登录会话可见。从管理员终端启动时
// 挂载虽成功，标准权限的资源管理器（含开机自启）看不到盘符。双击快捷方式
// 与开机自启均为标准令牌，不受影响。

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32          = windows.NewLazySystemDLL("user32.dll")
	procMessageBoxW = user32.NewProc("MessageBoxW")
)

// isElevated 报告当前进程是否以管理员（提升）令牌运行；检测失败按非管理员处理。
func isElevated() bool {
	var elevation uint32
	var returned uint32
	err := windows.GetTokenInformation(
		windows.GetCurrentProcessToken(),
		windows.TokenElevation,
		(*byte)(unsafe.Pointer(&elevation)),
		uint32(unsafe.Sizeof(elevation)),
		&returned,
	)
	return err == nil && elevation != 0
}

// warnIfElevated 管理员令牌启动时弹窗提醒盘符会话隔离问题；用户选择退出则结束进程。
// 仅主界面路径调用，--autotest 与单实例激活分支不经过这里。
func warnIfElevated() {
	if !isElevated() {
		return
	}
	const (
		mbYesNo       = 0x4
		mbIconWarning = 0x30
		mbDefButton2  = 0x100 // 默认聚焦"退出"，防回车误继续
		idYes         = 6
	)
	text, _ := windows.UTF16PtrFromString("当前正以管理员身份运行。\n\n" +
		"UAC 下管理员令牌挂载的本地盘符只对管理员会话可见，标准权限的资源管理器（含开机自启）将看不到挂载的盘符。\n\n" +
		"建议改为普通方式启动（例如双击桌面快捷方式）。\n\n" +
		"确定仍要继续吗？")
	caption, _ := windows.UTF16PtrFromString("OssManager")
	ret, _, _ := procMessageBoxW.Call(
		0,
		uintptr(unsafe.Pointer(text)),
		uintptr(unsafe.Pointer(caption)),
		uintptr(mbYesNo|mbIconWarning|mbDefButton2),
	)
	if ret != idYes {
		os.Exit(0)
	}
}
