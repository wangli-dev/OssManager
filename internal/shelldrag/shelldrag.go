package shelldrag

// Shell 拖拽导出：把本地文件以 CF_HDROP 数据对象交给 Windows 拖放循环（DoDragDrop），
// 用户按住鼠标把文件拖到资源管理器即完成复制落盘。
// 纯 syscall 实现 IDataObject / IEnumFORMATETC / IDropSource 三个 COM 接口的
// 最小可用子集，不引入第三方依赖。

import (
	"fmt"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32dll = windows.NewLazySystemDLL("kernel32.dll")
	ole32       = windows.NewLazySystemDLL("ole32.dll")
	user32dll   = windows.NewLazySystemDLL("user32.dll")

	procCoInitializeEx   = ole32.NewProc("CoInitializeEx")
	procCoUninitialize   = ole32.NewProc("CoUninitialize")
	procDoDragDrop       = ole32.NewProc("DoDragDrop")
	procGetAsyncKeyState = user32dll.NewProc("GetAsyncKeyState")

	procGlobalFree   = kernel32dll.NewProc("GlobalFree")
	procGlobalAlloc  = kernel32dll.NewProc("GlobalAlloc")
	procGlobalLock   = kernel32dll.NewProc("GlobalLock")
	procGlobalUnlock = kernel32dll.NewProc("GlobalUnlock")
)

// HRESULT 与相关常量。
const (
	sOK                        = 0
	sFalse                     = 1
	// DRAGDROP_S_* 是成功码（高位 0x0004）；写成 0x8004 开头会被外壳当成失败，
	// QueryContinueDrag/GiveFeedback 一被回调就中止，拖出必现“拖拽已取消”。
	dragdropSDrop              = 0x00040100 // DRAGDROP_S_DROP
	dragdropSCancel            = 0x00040101 // DRAGDROP_S_CANCEL
	dragdropSUseDefaultCursors = 0x00040102 // DRAGDROP_S_USEDEFAULTCURSORS
	oleEAdviseNotSupported     = 0x80040004
	dvEEtymed                  = 0x80040069
	dvEFormatetc               = 0x80040064
	eNotImpl                   = 0x80004001
	ePointer                   = 0x80004003
	coInitApartmentThreaded    = 2
	cfHDROP                    = 15
	dvAspectContent            = 1
	tymedHGlobal               = 1
	dropEffectCopy             = 1
	dropEffectMove             = 2
	mkRButton                  = 2
	vkEscape                   = 0x1B
	gmemMoveable               = 0x0002
	gmemZeroInit               = 0x0040
)

// IID 定义（x64 内存布局：Data1-4 低地址在前）。
var (
	iidIDataObject    = windows.GUID{Data1: 0x0000010e, Data2: 0x0000, Data3: 0x0000, Data4: [8]byte{0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}}
	iidIEnumFormatEtc = windows.GUID{Data1: 0x00000103, Data2: 0x0000, Data3: 0x0000, Data4: [8]byte{0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}}
	iidIDropSource    = windows.GUID{Data1: 0x00000121, Data2: 0x0000, Data3: 0x0000, Data4: [8]byte{0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}}
	iidIUnknown       = windows.GUID{Data1: 0x00000000, Data2: 0x0000, Data3: 0x0000, Data4: [8]byte{0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}}
)

// formatEtc 对应 Windows FORMATETC（x64，32 字节）。
type formatEtc struct {
	cfFormat int16
	_        [6]byte
	ptd      uintptr
	dwAspect uint32
	lindex   int32
	tymed    uint32
	_        [4]byte
}

// stgMedium 对应 Windows STGMEDIUM（x64，24 字节）。
type stgMedium struct {
	tymed          uint32
	_              [4]byte
	hGlobal        uintptr
	pUnkForRelease unsafe.Pointer
}

// dropFiles 对应 Windows DROPFILES 头；文件名列表从偏移 20 开始（UTF-16，双零结尾）。
type dropFiles struct {
	pFiles uint32
	ptX    int32
	ptY    int32
	fNC    uint32
}

// ---------- GUID / vtable 工具 ----------

func guidEqual(a *windows.GUID, b *windows.GUID) bool {
	return a.Data1 == b.Data1 && a.Data2 == b.Data2 && a.Data3 == b.Data3 && a.Data4 == b.Data4
}

// goCallback 包装 syscall.NewCallback；错误由各方法内处理，签名统一为 uintptr 返回 HRESULT。
var _ = syscall.NewCallback

// ---------- IDataObject ----------

type dataObject struct {
	vtbl    *dataObjectVTbl
	ref     int32
	hGlobal windows.Handle
}

type dataObjectVTbl struct {
	queryInterface        uintptr
	addRef                uintptr
	release               uintptr
	getData               uintptr
	getDataHere           uintptr
	queryGetData          uintptr
	getCanonicalFormatEtc uintptr
	setData               uintptr
	enumFormatEtc         uintptr
	dAdvise               uintptr
	dUnadvise             uintptr
	enumDAdvise           uintptr
}

var dataObjectVtblPtr *dataObjectVTbl

func buildDataObjectVtbl() *dataObjectVTbl {
	return &dataObjectVTbl{
		queryInterface:        syscall.NewCallback(dataObjectQueryInterface),
		addRef:                syscall.NewCallback(dataObjectAddRef),
		release:               syscall.NewCallback(dataObjectRelease),
		getData:               syscall.NewCallback(dataObjectGetData),
		getDataHere:           syscall.NewCallback(dataObjectNotImpl3),
		queryGetData:          syscall.NewCallback(dataObjectQueryGetData),
		getCanonicalFormatEtc: syscall.NewCallback(dataObjectNotImpl3),
		setData:               syscall.NewCallback(dataObjectNotImpl3),
		enumFormatEtc:         syscall.NewCallback(dataObjectEnumFormatEtc),
		dAdvise:               syscall.NewCallback(dataObjectNoAdvise5),
		dUnadvise:             syscall.NewCallback(dataObjectNoAdvise2),
		enumDAdvise:           syscall.NewCallback(dataObjectNoAdvise2),
	}
}

func dataObjectQueryInterface(this, riid, ppv uintptr) uintptr {
	if ppv == 0 {
		return ePointer
	}
	riidGUID := (*windows.GUID)(unsafe.Pointer(riid))
	var out uintptr
	switch {
	case guidEqual(riidGUID, &iidIDataObject):
		out = this
	case guidEqual(riidGUID, &iidIUnknown):
		out = this
	default:
		*(*uintptr)(unsafe.Pointer(ppv)) = 0
		return eNotImpl
	}
	obj := (*dataObject)(unsafe.Pointer(this))
	atomic.AddInt32(&obj.ref, 1)
	*(*uintptr)(unsafe.Pointer(ppv)) = out
	return sOK
}

func dataObjectAddRef(this uintptr) uintptr {
	obj := (*dataObject)(unsafe.Pointer(this))
	return uintptr(atomic.AddInt32(&obj.ref, 1))
}

func dataObjectRelease(this uintptr) uintptr {
	obj := (*dataObject)(unsafe.Pointer(this))
	left := atomic.AddInt32(&obj.ref, -1)
	if left == 0 {
		procGlobalFree.Call(uintptr(obj.hGlobal))
	}
	return uintptr(left)
}

func dataObjectGetData(this, pfmtetc, pmedium uintptr) uintptr {
	if pfmtetc == 0 || pmedium == 0 {
		return ePointer
	}
	fe := (*formatEtc)(unsafe.Pointer(pfmtetc))
	if fe.cfFormat != cfHDROP || fe.dwAspect != dvAspectContent || fe.tymed != tymedHGlobal {
		return dvEFormatetc
	}
	obj := (*dataObject)(unsafe.Pointer(this))
	if obj.hGlobal == 0 {
		return dvEFormatetc
	}
	pm := (*stgMedium)(unsafe.Pointer(pmedium))
	pm.tymed = tymedHGlobal
	pm.hGlobal = uintptr(obj.hGlobal)
	pm.pUnkForRelease = nil
	return sOK
}

func dataObjectQueryGetData(this, pfmtetc uintptr) uintptr {
	if pfmtetc == 0 {
		return ePointer
	}
	fe := (*formatEtc)(unsafe.Pointer(pfmtetc))
	if fe.cfFormat == cfHDROP && fe.dwAspect == dvAspectContent && (fe.tymed == tymedHGlobal || fe.tymed == 0) {
		return sOK
	}
	return dvEFormatetc
}

func dataObjectEnumFormatEtc(this, direction, ppenum uintptr) uintptr {
	if ppenum == 0 {
		return ePointer
	}
	if direction != 1 { // DATADIR_GET
		*(*uintptr)(unsafe.Pointer(ppenum)) = 0
		return eNotImpl
	}
	enum := newEnumFormatEtc()
	*(*uintptr)(unsafe.Pointer(ppenum)) = uintptr(unsafe.Pointer(enum))
	return sOK
}

func dataObjectNotImpl3(this, _, _ uintptr) uintptr { return eNotImpl }
func dataObjectNoAdvise5(this, _, _, _, _ uintptr) uintptr {
	return oleEAdviseNotSupported
}
func dataObjectNoAdvise2(this, _ uintptr) uintptr {
	return oleEAdviseNotSupported
}

func newDataObject(paths []string) (*dataObject, error) {
	h, err := makeHDrop(paths)
	if err != nil {
		return nil, err
	}
	if dataObjectVtblPtr == nil {
		dataObjectVtblPtr = buildDataObjectVtbl()
	}
	return &dataObject{vtbl: dataObjectVtblPtr, ref: 1, hGlobal: h}, nil
}

// makeHDrop 分配 HGLOBAL 并填充 DROPFILES + UTF-16 路径表。
func makeHDrop(paths []string) (windows.Handle, error) {
	if len(paths) == 0 {
		return 0, fmt.Errorf("没有可拖拽的文件")
	}
	var total int = 20 // DROPFILES 头之后文件名区起始偏移
	for _, p := range paths {
		total += (len(p) + 1) * 2
	}
	total += 2 // 终止双零
	hAlloc, _, errAlloc := procGlobalAlloc.Call(uintptr(gmemMoveable|gmemZeroInit), uintptr(total))
	if hAlloc == 0 {
		return 0, fmt.Errorf("GlobalAlloc 失败：%v", errAlloc)
	}
	ptr, _, errLock := procGlobalLock.Call(hAlloc)
	if ptr == 0 {
		procGlobalFree.Call(hAlloc)
		return 0, fmt.Errorf("GlobalLock 失败：%v", errLock)
	}
	h := windows.Handle(hAlloc)
	buf := (*[1 << 20]uint16)(unsafe.Pointer(ptr))[: total/2 : total/2]
	// DROPFILES 头
	buf[0] = 20           // pFiles
	buf[2], buf[3] = 0, 0 // pt
	buf[4] = 0            // fNC
	// 文件名区
	out := buf[10:]
	for _, p := range paths {
		win := strings.ReplaceAll(p, "/", "\\")
		utf16, err := windows.UTF16FromString(win)
		if err != nil {
			procGlobalFree.Call(uintptr(h))
			return 0, err
		}
		copy(out, utf16)
		out = out[len(utf16):]
	}
	out[0] = 0
	procGlobalUnlock.Call(hAlloc)
	return h, nil
}

// ---------- IEnumFORMATETC ----------

type enumFormatEtc struct {
	vtbl *enumFormatEtcVTbl
	ref  int32
	pos  int
}

type enumFormatEtcVTbl struct {
	queryInterface uintptr
	addRef         uintptr
	release        uintptr
	next           uintptr
	skip           uintptr
	reset          uintptr
	clone          uintptr
}

var enumFormatEtcVtblPtr *enumFormatEtcVTbl

func newEnumFormatEtc() *enumFormatEtc {
	if enumFormatEtcVtblPtr == nil {
		enumFormatEtcVtblPtr = &enumFormatEtcVTbl{
			queryInterface: syscall.NewCallback(enumQueryInterface),
			addRef:         syscall.NewCallback(enumAddRef),
			release:        syscall.NewCallback(enumRelease),
			next:           syscall.NewCallback(enumNext),
			skip:           syscall.NewCallback(enumSkip),
			reset:          syscall.NewCallback(enumReset),
			clone:          syscall.NewCallback(enumNotImpl),
		}
	}
	return &enumFormatEtc{vtbl: enumFormatEtcVtblPtr, ref: 1}
}

func enumQueryInterface(this, riid, ppv uintptr) uintptr {
	if ppv == 0 {
		return ePointer
	}
	riidGUID := (*windows.GUID)(unsafe.Pointer(riid))
	if !guidEqual(riidGUID, &iidIEnumFormatEtc) && !guidEqual(riidGUID, &iidIUnknown) {
		*(*uintptr)(unsafe.Pointer(ppv)) = 0
		return eNotImpl
	}
	obj := (*enumFormatEtc)(unsafe.Pointer(this))
	atomic.AddInt32(&obj.ref, 1)
	*(*uintptr)(unsafe.Pointer(ppv)) = this
	return sOK
}

func enumAddRef(this uintptr) uintptr {
	obj := (*enumFormatEtc)(unsafe.Pointer(this))
	return uintptr(atomic.AddInt32(&obj.ref, 1))
}

func enumRelease(this uintptr) uintptr {
	return uintptr(atomic.AddInt32(&(*enumFormatEtc)(unsafe.Pointer(this)).ref, -1))
}

func enumNext(this, celt, rgelt, fetched uintptr) uintptr {
	obj := (*enumFormatEtc)(unsafe.Pointer(this))
	if obj.pos >= 1 {
		if fetched != 0 {
			*(*uint32)(unsafe.Pointer(fetched)) = 0
		}
		return sFalse
	}
	if rgelt == 0 {
		return ePointer
	}
	fe := (*formatEtc)(unsafe.Pointer(rgelt))
	*fe = formatEtc{cfFormat: cfHDROP, dwAspect: dvAspectContent, lindex: -1, tymed: tymedHGlobal}
	if fetched != 0 {
		*(*uint32)(unsafe.Pointer(fetched)) = 1
	}
	obj.pos++
	if celt == 1 {
		return sOK
	}
	return sFalse
}

func enumSkip(this, count uintptr) uintptr {
	obj := (*enumFormatEtc)(unsafe.Pointer(this))
	if obj.pos+int(count) <= 1 {
		obj.pos += int(count)
		return sOK
	}
	return sFalse
}

func enumReset(this uintptr) uintptr {
	(*enumFormatEtc)(unsafe.Pointer(this)).pos = 0
	return sOK
}

func enumNotImpl(this, _ uintptr) uintptr { return eNotImpl }

// ---------- IDropSource ----------

type dropSource struct {
	vtbl *dropSourceVTbl
	ref  int32
}

type dropSourceVTbl struct {
	queryInterface uintptr
	addRef         uintptr
	release        uintptr
	queryContinue  uintptr
	giveFeedback   uintptr
}

var dropSourceVtblPtr *dropSourceVTbl

func newDropSource() *dropSource {
	if dropSourceVtblPtr == nil {
		dropSourceVtblPtr = &dropSourceVTbl{
			queryInterface: syscall.NewCallback(dropQueryInterface),
			addRef:         syscall.NewCallback(dropAddRef),
			release:        syscall.NewCallback(dropRelease),
			queryContinue:  syscall.NewCallback(dropQueryContinue),
			giveFeedback:   syscall.NewCallback(dropGiveFeedback),
		}
	}
	return &dropSource{vtbl: dropSourceVtblPtr, ref: 1}
}

func dropQueryInterface(this, riid, ppv uintptr) uintptr {
	if ppv == 0 {
		return ePointer
	}
	riidGUID := (*windows.GUID)(unsafe.Pointer(riid))
	if !guidEqual(riidGUID, &iidIDropSource) && !guidEqual(riidGUID, &iidIUnknown) {
		*(*uintptr)(unsafe.Pointer(ppv)) = 0
		return eNotImpl
	}
	obj := (*dropSource)(unsafe.Pointer(this))
	atomic.AddInt32(&obj.ref, 1)
	*(*uintptr)(unsafe.Pointer(ppv)) = this
	return sOK
}

func dropAddRef(this uintptr) uintptr {
	obj := (*dropSource)(unsafe.Pointer(this))
	return uintptr(atomic.AddInt32(&obj.ref, 1))
}

func dropRelease(this uintptr) uintptr {
	return uintptr(atomic.AddInt32(&(*dropSource)(unsafe.Pointer(this)).ref, -1))
}

func dropQueryContinue(this, escapePressed, keyState uintptr) uintptr {
	if escapePressed != 0 {
		return dragdropSCancel
	}
	state, _, _ := procGetAsyncKeyState.Call(vkEscape)
	if int16(state) < 0 {
		return dragdropSCancel
	}
	if keyState&mkRButton != 0 {
		return dragdropSDrop
	}
	return sOK
}

func dropGiveFeedback(this, _ uintptr) uintptr {
	return dragdropSUseDefaultCursors
}

// ---------- 对外入口 ----------

// DragOut 阻塞执行一次系统拖拽，paths 为已就绪的本地文件路径；
// 返回用户是否把文件放到了目标（或拖拽被接受）。
func DragOut(paths []string) (bool, error) {
	if len(paths) == 0 {
		return false, fmt.Errorf("没有可拖拽的文件")
	}
	// DoDragDrop 与 OLE 初始化必须在同一线程；锁定 goroutine 的 OS 线程。
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	hrInit, _, _ := procCoInitializeEx.Call(0, coInitApartmentThreaded)
	if hrInit == 1 /*RPC_E_CHANGED_MODE*/ {
		return false, fmt.Errorf("当前线程 OLE 模式冲突，无法发起拖拽")
	}
	if hrInit == sOK {
		defer procCoUninitialize.Call()
	}

	obj, err := newDataObject(paths)
	if err != nil {
		return false, err
	}
	src := newDropSource()
	var effect uint32
	hr, _, _ := procDoDragDrop.Call(
		uintptr(unsafe.Pointer(obj)),
		uintptr(unsafe.Pointer(src)),
		uintptr(dropEffectCopy|dropEffectMove),
		uintptr(unsafe.Pointer(&effect)),
	)
	accepted := (hr == sOK || hr == dragdropSDrop) && effect&(dropEffectCopy|dropEffectMove) != 0
	return accepted, nil
}
