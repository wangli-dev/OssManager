package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/log"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"OssManager/internal/bundle"
	"OssManager/internal/clipboard"
	"OssManager/internal/config"
	"OssManager/internal/connjson"
	"OssManager/internal/download"
	"OssManager/internal/filemanager"
	"OssManager/internal/local"
	"OssManager/internal/mount"
	"OssManager/internal/policy"
	"OssManager/internal/rclonefs"
	"OssManager/internal/remote"
	"OssManager/internal/shelldrag"
	"OssManager/internal/transfer"
)

const appVersion = "1.3.0"

func logf(format string, args ...interface{}) {
	_ = os.MkdirAll(config.DataDir(), 0o755)
	f, err := os.OpenFile(filepath.Join(config.DataDir(), "go.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
}

// App 是 Wails 暴露给前端的后端。
type App struct {
	ctx      context.Context
	settings config.Settings
	mounter  *mount.Manager
}

// NewApp 创建应用实例。
func NewApp() *App {
	return &App{mounter: mount.NewManager()}
}

// startup 由 Wails 在启动时调用。
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.settings = config.LoadSettings()
	transfer.SetConcurrency(a.settings.MaxConcurrentTransfers)
	// rclone 库运行日志落盘：挂载会话断线、目录列表失败等错误此前静默丢失，无法排查。
	log.Opt.File = filepath.Join(config.DataDir(), "rclone-lib.log")
	// 两层都要设置：fs.Debugf 入口按 fs.Config.LogLevel 过滤，slog handler 按 SetLevel 过滤。
	fs.GetConfig(ctx).LogLevel = fs.LogLevelDebug
	log.InitLogging()
	log.Handler.SetLevel(fs.LogLevelToSlog(fs.LogLevelDebug))
	go a.restoreMounts()
}

func (a *App) mountOptions(remote string) mount.Options {
	// ServerModtimeRemotes 中的连接使用服务器修改时间，避免浏览目录时逐个请求对象元数据。
	useServerModtime := false
	// 连接名取冒号前部分，路径型 remote（host:/）也要能匹配设置里的名单。
	name := config.RemoteName(remote)
	for _, item := range a.settings.ServerModtimeRemotes {
		if strings.EqualFold(strings.TrimSpace(item), name) {
			useServerModtime = true
			break
		}
	}
	return mount.Options{
		CacheDirectory:   a.settings.CacheDirectory,
		DirCacheTime:     a.settings.DirCacheTime,
		VfsCacheMaxSize:  a.settings.VfsCacheMaxSize,
		VfsCacheMaxAge:   a.settings.VfsCacheMaxAge,
		BufferSize:       a.settings.BufferSize,
		UseServerModtime: useServerModtime,
	}
}

func (a *App) restoreMounts() {
	time.Sleep(3 * time.Second)
	// 先登记系统上已有的外部 rclone 挂载，避免前端看不到旧版本留下的盘符。
	externalRemotes := map[string]bool{}
	for _, entry := range mount.CachedExternal() {
		externalRemotes[strings.ToLower(strings.TrimSuffix(entry.Remote, ":"))] = true
		if mount.DrivePresent(entry.Drive) {
			logf("external mount %s %s pid=%d", entry.Remote, entry.Drive, entry.PID)
		}
	}
	seen := make(map[string]bool)
	// 挂载记录里没写卷标时用连接显示名（conf 的 description），避免卷标露出 oss_xxx 这类内部 ID。
	displayNames := a.connectionDisplayNames()
	for _, record := range config.ReadMountRecords() {
		// 记录已带完整 remote（连接名: 或 连接名:/路径），直接使用，不再二次补冒号。
		remote := config.NormalizeRemote(record.Remote)
		if remote == "" {
			continue
		}
		if seen[remote] {
			continue
		}
		seen[remote] = true
		// 该连接已由独立 rclone 进程挂载时不再重复挂载，并清掉本程序的旧记录。
		if externalRemotes[strings.ToLower(config.RemoteName(remote))] {
			a.removeMountRecordByDrive(record.Drive)
			continue
		}
		if mount.DrivePresent(record.Drive) {
			continue
		}
		options := a.mountOptions(remote)
		options.VolumeName = record.VolumeName
		if options.VolumeName == "" {
			options.VolumeName = a.volumeLabel(remote, displayNames)
		}
		if err := a.mounter.Mount(a.ctx, a.settings.RcloneConfig, remote, record.Drive, options); err != nil {
			logf("restore mount %s %s err=%v", remote, record.Drive, err)
		} else {
			// 挂载成功后立即在进程内读一次目录：区分「进程内列表为空」与「外部读取侧问题」。
			entries, readErr := os.ReadDir(record.Drive + "\\")
			logf("restore mount %s %s ok, in-proc readdir=%d err=%v", remote, record.Drive, len(entries), readErr)
			if len(entries) == 0 {
				// vfs 目录为空时用 backend 直读对照：区分 backend 层与 fuse/vfs 层的问题。
				items, listErr := rclonefs.List(a.ctx, a.settings.RcloneConfig, remote)
				logf("restore mount %s backend list=%d err=%v", remote, len(items), listErr)
			}
		}
	}
	runtime.EventsEmit(a.ctx, "mounts-changed")
}

func (a *App) addMountRecord(remote, drive, volumeName string) {
	remote = config.NormalizeRemote(remote)
	if volumeName == "" {
		volumeName = a.volumeLabel(remote, a.connectionDisplayNames())
	}
	records := config.ReadMountRecords()
	for _, record := range records {
		if strings.EqualFold(record.Drive, drive) && config.NormalizeRemote(record.Remote) == remote {
			return
		}
	}
	records = append(records, config.MountRecord{Remote: remote, Drive: drive, VolumeName: volumeName})
	_ = config.WriteMountRecords(records)
}

// volumeLabel 返回挂载卷标：连接显示名（conf 的 description）优先，其次连接名；
// 不会带出 host:/ 这类路径，也不会露出 oss_xxx 之外的内部拼接串。
func (a *App) volumeLabel(remote string, displayNames map[string]string) string {
	name := config.RemoteName(remote)
	if label := displayNames[strings.ToLower(name)]; label != "" {
		return label
	}
	return name
}

// connectionDisplayNames 返回小写连接名到显示名（conf 的 description）的映射。
func (a *App) connectionDisplayNames() map[string]string {
	result := map[string]string{}
	connections, err := config.ListConnections(a.settings.RcloneConfig)
	if err != nil {
		return result
	}
	for _, item := range connections {
		if item.DisplayName != "" && item.DisplayName != item.Name {
			result[strings.ToLower(item.Name)] = item.DisplayName
		}
	}
	return result
}

func (a *App) removeMountRecordByDrive(drive string) {
	var kept []config.MountRecord
	for _, record := range config.ReadMountRecords() {
		if !strings.EqualFold(record.Drive, drive) {
			kept = append(kept, record)
		}
	}
	_ = config.WriteMountRecords(kept)
}

// GetSettings 返回当前设置。
func (a *App) GetSettings() config.Settings {
	return a.settings
}

// SaveSettings 保存设置并立即生效。
func (a *App) SaveSettings(value config.Settings) error {
	if err := config.SaveSettings(value); err != nil {
		return err
	}
	a.settings = value
	transfer.SetConcurrency(value.MaxConcurrentTransfers)
	return nil
}

// ListConnections 读取 rclone.conf 中的连接，并按保存的顺序排列。
func (a *App) ListConnections() ([]config.Connection, error) {
	connections, err := config.ListConnections(a.settings.RcloneConfig)
	if err != nil {
		return nil, err
	}
	return config.ApplyOrder(connections, config.ReadOrder()), nil
}

// GetConnection 返回编辑所需的连接字段；密钥不回传，留空表示不修改。
func (a *App) GetConnection(name string) (remote.Definition, error) {
	options := config.RemoteOptions(a.settings.RcloneConfig, name)
	def := remote.Definition{
		Name:        name,
		DisplayName: options["description"],
		Endpoint:    firstOption(options, "endpoint", "url", "host"),
		Region:      options["region"],
		Account:     firstOption(options, "access_key_id", "user"),
	}
	kind := options["type"]
	provider := options["provider"]
	switch {
	case kind == "s3" && strings.EqualFold(provider, "minio"):
		def.Type = "minio"
	case kind == "s3" && strings.EqualFold(provider, "alibaba"):
		def.Type = "alibaba"
	case kind == "s3":
		def.Type = "s3"
	default:
		def.Type = kind
	}
	return def, nil
}

func firstOption(values map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := values[key]; value != "" {
			return value
		}
	}
	return ""
}

// List 列出 remote:path 下的对象。
func (a *App) List(remote string) ([]rclonefs.Entry, error) {
	return rclonefs.List(a.ctx, a.settings.RcloneConfig, remote)
}

// Mount 把连接挂载到盘符，volumeName 为空时使用连接显示名。
func (a *App) Mount(remote, drive, volumeName string) error {
	remote = config.NormalizeRemote(remote)
	logf("Mount remote=%s drive=%s volume=%s", remote, drive, volumeName)
	options := a.mountOptions(remote)
	options.VolumeName = volumeName
	if options.VolumeName == "" {
		// 前端未填卷标时用连接显示名，避免卷标显示内部连接 ID。
		options.VolumeName = a.volumeLabel(remote, a.connectionDisplayNames())
	}
	err := a.mounter.Mount(a.ctx, a.settings.RcloneConfig, remote, drive, options)
	logf("Mount result err=%v", err)
	if err == nil {
		a.addMountRecord(remote, drive, volumeName)
		mount.InvalidateExternal()
		runtime.EventsEmit(a.ctx, "mounts-changed")
	}
	return err
}

// Unmount 卸载盘符，本程序挂载失败时回退为结束外部 rclone 进程。
func (a *App) Unmount(drive string) error {
	logf("Unmount drive=%s", drive)
	err := a.mounter.Unmount(drive)
	if err != nil {
		if externalErr := mount.StopExternal(drive); externalErr != nil {
			logf("Unmount err=%v external=%v", err, externalErr)
			return err
		}
		mount.InvalidateExternal()
		mount.WaitDriveGone(drive, 10*time.Second)
		a.removeMountRecordByDrive(drive)
		runtime.EventsEmit(a.ctx, "mounts-changed")
		return nil
	}
	a.removeMountRecordByDrive(drive)
	mount.InvalidateExternal()
	runtime.EventsEmit(a.ctx, "mounts-changed")
	return nil
}

// UnmountByRemote 按连接名卸载其所有挂载，避免前端挂载表不同步。
func (a *App) UnmountByRemote(remoteName string) error {
	target := config.RemoteName(config.NormalizeRemote(remoteName))
	found := false
	for drive, remote := range a.mounter.List() {
		if !strings.EqualFold(config.RemoteName(remote), target) {
			continue
		}
		found = true
		if err := a.mounter.Unmount(drive); err != nil {
			return err
		}
		a.removeMountRecordByDrive(drive)
	}
	if !found {
		if entry, ok := mount.FindExternalByRemote(target); ok {
			found = true
			if err := mount.StopExternal(entry.Drive); err != nil {
				return err
			}
			mount.WaitDriveGone(entry.Drive, 10*time.Second)
			a.removeMountRecordByDrive(entry.Drive)
		}
	}
	if !found {
		return fmt.Errorf("%s 没有挂载", remoteName)
	}
	mount.InvalidateExternal()
	runtime.EventsEmit(a.ctx, "mounts-changed")
	return nil
}

// ListMounts 返回盘符到 remote 的映射，包含本程序挂载与外部 rclone 进程挂载。
func (a *App) ListMounts() map[string]string {
	mounts := a.mounter.List()
	for _, entry := range mount.CachedExternal() {
		if _, exists := mounts[entry.Drive]; exists {
			continue
		}
		if mount.DrivePresent(entry.Drive) {
			mounts[entry.Drive] = strings.TrimSuffix(entry.Remote, ":") + ":"
		}
	}
	return mounts
}

// FreeDrives 返回当前未被占用的盘符，按 Z 到 D 的顺序。
func (a *App) FreeDrives() []string {
	result := []string{}
	for c := 'Z'; c >= 'D'; c-- {
		drive := string(c) + ":"
		if !mount.DrivePresent(drive) {
			result = append(result, drive)
		}
	}
	return result
}

// ListLocal 列出本地目录内容，用于双栏浏览。
func (a *App) ListLocal(path string) ([]local.Entry, error) {
	return local.List(path)
}

// NetworkShares 返回已映射的网络共享，供连接列表统一展示。
func (a *App) NetworkShares() []local.Share {
	return local.NetworkShares()
}

// LocalDrives 返回本地盘符与网络位置，rclone 挂载的盘符用连接名作为名称。
func (a *App) LocalDrives() []local.Drive {
	drives := local.Drives()
	external := map[string]mount.External{}
	for _, entry := range mount.CachedExternal() {
		external[strings.ToUpper(entry.Drive)] = entry
	}
	for index := range drives {
		key := strings.ToUpper(strings.TrimSuffix(drives[index].Root, `\`))
		entry, ok := external[key]
		if !ok {
			continue
		}
		if entry.Volume != "" {
			drives[index].Label = entry.Volume
		} else {
			drives[index].Label = strings.TrimSuffix(entry.Remote, ":")
		}
		drives[index].Kind = "rclone"
	}
	return drives
}

// MountNetworkLocation 连接局域网共享目录，凭据为空时使用当前登录身份。
func (a *App) MountNetworkLocation(unc, user, password string) error {
	logf("MountNetwork %s user=%s", unc, user)
	return local.MountNetwork(unc, user, password)
}

// UnmountNetworkLocation 断开局域网共享连接。
func (a *App) UnmountNetworkLocation(unc string) error {
	return local.UnmountNetwork(unc)
}

// DownloadHistory 返回历史下载记录，最新的在前。
func (a *App) DownloadHistory() []download.Record {
	return download.Read()
}

// ClearDownloadHistory 清空历史下载记录。
func (a *App) ClearDownloadHistory() error {
	return download.Clear()
}

// OpenDownloadFolder 打开下载文件所在目录。
func (a *App) OpenDownloadFolder(localPath string) error {
	dir := localPath
	if info, err := os.Stat(localPath); err == nil && !info.IsDir() {
		dir = filepath.Dir(localPath)
	}
	if dir == "" {
		dir = config.DataDir()
	}
	return filemanager.Open(dir, a.settings.FileManager)
}

// GetPolicy 读取桶策略。
func (a *App) GetPolicy(remote, bucket string) (string, error) {
	return policy.Get(a.ctx, a.settings.RcloneConfig, remote, bucket)
}

// PutPolicy 写入桶策略。
func (a *App) PutPolicy(remoteName, bucket, text string) error {
	return policy.Put(a.ctx, a.settings.RcloneConfig, remoteName, bucket, text)
}

// GetACL 读取桶 ACL 摘要。
func (a *App) GetACL(remoteName, bucket string) (policy.ACL, error) {
	return policy.GetACL(a.ctx, a.settings.RcloneConfig, remoteName, bucket)
}

// SetACL 设置桶的 canned ACL（private / public-read）；自定义授权请编辑桶策略。
func (a *App) SetACL(remoteName, bucket, acl string) error {
	logf("SetACL remote=%s bucket=%s acl=%s", remoteName, bucket, acl)
	err := policy.SetCannedACL(a.ctx, a.settings.RcloneConfig, remoteName, bucket, acl)
	logf("SetACL err=%v", err)
	return err
}

// SaveConnection 新增或更新连接。
func (a *App) SaveConnection(def remote.Definition, exists bool) error {
	err := remote.Save(a.settings.RcloneConfig, def, exists)
	logf("SaveConnection %s exists=%v err=%v", def.Name, exists, err)
	return err
}

// DeleteConnection 删除连接，并卸载其挂载、清理开机恢复记录。
// 只删配置不卸载会让盘符残留，访问时卡住，且下次启动继续尝试恢复已不存在的连接。
func (a *App) DeleteConnection(name string) error {
	// 没挂载时 UnmountByRemote 会报「没有挂载」，不能因此阻止删除。
	if err := a.UnmountByRemote(name); err != nil {
		logf("DeleteConnection unmount %s err=%v", name, err)
	}
	if err := remote.Delete(a.settings.RcloneConfig, name); err != nil {
		return err
	}
	// 兼底清理残留记录（存在记录但当前未挂载的情况）。
	if config.RemoveMountRecords(name) {
		mount.InvalidateExternal()
		runtime.EventsEmit(a.ctx, "mounts-changed")
	}
	return nil
}

// RenameConnection 修改内部连接名。
func (a *App) RenameConnection(oldName, newName string) error {
	if err := remote.Rename(a.settings.RcloneConfig, oldName, newName); err != nil {
		return err
	}
	// 挂载表与开机恢复记录也要换成新名字，否则改名后无法按新名卸载、重启也恢复不了。
	a.mounter.RenameRemote(oldName, newName)
	if config.RenameMountRecords(oldName, newName) {
		runtime.EventsEmit(a.ctx, "mounts-changed")
	}
	return nil
}

// TestConnection 通过列根目录验证连接可用。
func (a *App) TestConnection(name string) error {
	_, err := rclonefs.List(a.ctx, a.settings.RcloneConfig, name+":")
	return err
}

// TestConnectionInput 测试尚未保存的连接参数，用于新建/编辑时校验输入。
func (a *App) TestConnectionInput(def remote.Definition) error {
	connString, err := remote.ConnectionString(def)
	if err != nil {
		return err
	}
	return rclonefs.Probe(a.ctx, connString)
}

// downloadStreams 返回单文件分片数，非法值退回默认 4。
func (a *App) downloadStreams() int {
	streams := a.settings.DownloadStreams
	if streams <= 0 {
		streams = 4
	}
	if streams > 16 {
		streams = 16
	}
	return streams
}

// Download 下载远程对象到本地目录，并登记实时进度。
func (a *App) Download(remotePath, localDir string) (string, error) {
	local, err := transfer.DownloadWithProgress(a.ctx, a.settings.RcloneConfig, remotePath, localDir, a.downloadStreams())
	if err != nil {
		return "", err
	}
	size := int64(0)
	if info, statErr := os.Stat(local); statErr == nil {
		size = info.Size()
	}
	download.Add(remotePath, local, size)
	return local, nil
}

// DownloadTasks 返回正在下载与最近完成的下载任务。
func (a *App) DownloadTasks() []transfer.Task {
	return transfer.ListTasks()
}

// ClearDownloadTasks 清除已完成与失败的下载任务。
func (a *App) ClearDownloadTasks() {
	transfer.ClearFinishedTasks()
}

// DragOutFiles 把远程文件下载到缓存后发起系统拖拽：用户按住鼠标拖到资源管理器即落盘复制。
// 阻塞直到拖拽结束；前端应在按住鼠标的 dragstart 中调用，并保持鼠标按下直到提示就绪。
func (a *App) DragOutFiles(remotePaths []string) (string, error) {
	if len(remotePaths) == 0 {
		return "", fmt.Errorf("没有可拖拽的文件")
	}
	cache := filepath.Join(config.DataDir(), "drag-cache", fmt.Sprintf("%d", time.Now().UnixNano()))
	var localPaths []string
	for _, rp := range remotePaths {
		local, err := transfer.Download(a.ctx, a.settings.RcloneConfig, rp, cache)
		if err != nil {
			logf("DragOut download %s err=%v", rp, err)
			return "", fmt.Errorf("下载 %s 失败：%w", rp, err)
		}
		localPaths = append(localPaths, local)
	}
	dropped, err := shelldrag.DragOut(localPaths)
	logf("DragOut files=%d dropped=%v err=%v", len(localPaths), dropped, err)
	if err != nil {
		return "", err
	}
	if !dropped {
		return "拖拽已取消", nil
	}
	return fmt.Sprintf("已拖出 %d 个文件", len(localPaths)), nil
}

// CopyRemoteToClipboard 下载远程对象到临时目录并写入剪贴板。
func (a *App) CopyRemoteToClipboard(remotePath string) (string, error) {
	local, err := transfer.Download(a.ctx, a.settings.RcloneConfig, remotePath, filepath.Join(config.DataDir(), "clipboard"))
	if err != nil {
		return "", err
	}
	if err := clipboard.CopyFiles([]string{local}); err != nil {
		return "", err
	}
	return local, nil
}

// PasteFromClipboard 把剪贴板中的文件上传到远程目录。
func (a *App) PasteFromClipboard(remoteDir string) (string, error) {
	files, err := clipboard.PasteFiles()
	if err != nil {
		return "", err
	}
	uploaded := 0
	for _, file := range files {
		info, statErr := os.Stat(file)
		if statErr != nil || info.IsDir() {
			continue
		}
		if err := transfer.Upload(a.ctx, a.settings.RcloneConfig, file, remoteDir); err != nil {
			return "", err
		}
		uploaded++
	}
	if uploaded == 0 {
		return "", fmt.Errorf("剪贴板中没有可上传的文件")
	}
	return fmt.Sprintf("已上传 %d 个文件", uploaded), nil
}

// Upload 上传本地文件到远程目录。
func (a *App) Upload(remoteDir, localFile string) error {
	return transfer.Upload(a.ctx, a.settings.RcloneConfig, localFile, remoteDir)
}

// UploadPath 自动判断文件或目录后上传。
func (a *App) UploadPath(remoteDir, localPath string) error {
	info, err := os.Stat(localPath)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return transfer.UploadFolder(a.ctx, a.settings.RcloneConfig, localPath, remoteDir)
	}
	return transfer.Upload(a.ctx, a.settings.RcloneConfig, localPath, remoteDir)
}

// OpenFolder 用文件管理器打开目录。
func (a *App) OpenFolder(path string) error {
	return filemanager.Open(path, a.settings.FileManager)
}

// ExportConnections 导出连接 JSON；includeSettings 为真时同时导出程序设置。
func (a *App) ExportConnections(path string, includeSecrets, includeSettings bool) (string, error) {
	var settings *config.Settings
	if includeSettings {
		value := a.settings
		settings = &value
	}
	text, err := connjson.Export(a.settings.RcloneConfig, includeSecrets, settings)
	if err != nil {
		return "", err
	}
	if path == "" {
		return text, nil
	}
	return text, os.WriteFile(path, []byte(text), 0o644)
}

// ExportBundle 把设置、rclone 配置与挂载记录打包为 zip 配置包，用于换机迁移。
func (a *App) ExportBundle(zipPath string) (string, error) {
	entries := []bundle.Entry{
		{Name: "settings.json", Path: config.SettingsPath()},
		{Name: "rclone.conf", Path: a.settings.RcloneConfig},
		{Name: "mounts.txt", Path: config.MountRecordPath()},
	}
	err := bundle.Export(zipPath, entries)
	logf("ExportBundle path=%s err=%v", zipPath, err)
	if err != nil {
		return "", err
	}
	return "配置包已导出（rclone 配置含连接密钥，请妥善保管）", nil
}

// ImportBundle 导入配置包：成员写回前备份 .bak，随后立即重载设置与传输并发数。
func (a *App) ImportBundle(zipPath string) (string, error) {
	entries := []bundle.Entry{
		{Name: "settings.json", Path: config.SettingsPath()},
		{Name: "rclone.conf", Path: a.settings.RcloneConfig},
		{Name: "mounts.txt", Path: config.MountRecordPath()},
	}
	restored, err := bundle.Import(zipPath, entries)
	logf("ImportBundle path=%s err=%v", zipPath, err)
	if err != nil {
		return "", err
	}
	value := config.LoadSettings()
	a.settings = value
	transfer.SetConcurrency(value.MaxConcurrentTransfers)
	return "已导入：" + strings.Join(restored, "、"), nil
}

// ImportConnections 从 JSON 导入连接；applySettings 为真时同时恢复文件中的程序设置。
func (a *App) ImportConnections(path string, applySettings bool) (string, error) {
	message, err := connjson.Import(a.settings.RcloneConfig, path, applySettings)
	if err == nil && applySettings {
		a.settings = config.LoadSettings()
		transfer.SetConcurrency(a.settings.MaxConcurrentTransfers)
	}
	return message, err
}

// PickFile 打开文件选择框。
func (a *App) PickFile() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{})
}

// PickFolder 打开目录选择框。
func (a *App) PickFolder() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{})
}

// PickSaveFile 打开保存对话框。
func (a *App) PickSaveFile(defaultName string) (string, error) {
	return runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{DefaultFilename: defaultName})
}

// AboutInfo 是“关于”对话框展示的信息。
type AboutInfo struct {
	AppVersion    string `json:"appVersion"`
	RcloneVersion string `json:"rcloneVersion"`
	ConfigPath    string `json:"configPath"`
	DataDir       string `json:"dataDir"`
	LogPath       string `json:"logPath"`
}

// GetAbout 返回版本与路径信息。
func (a *App) GetAbout() AboutInfo {
	return AboutInfo{
		AppVersion:    appVersion,
		RcloneVersion: fs.VersionTag,
		ConfigPath:    a.settings.RcloneConfig,
		DataDir:       config.DataDir(),
		LogPath:       filepath.Join(config.DataDir(), "go.log"),
	}
}

// GetLog 返回最近的运行日志，只读取文件尾部避免大日志占用内存。
func (a *App) GetLog() string {
	file, err := os.Open(filepath.Join(config.DataDir(), "go.log"))
	if err != nil {
		return ""
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return ""
	}
	const tail = 256 * 1024
	start := int64(0)
	if info.Size() > tail {
		start = info.Size() - tail
	}
	buffer := make([]byte, info.Size()-start)
	if _, err := file.ReadAt(buffer, start); err != nil {
		return ""
	}
	lines := strings.Split(string(buffer), "\n")
	if len(lines) > 200 {
		lines = lines[len(lines)-200:]
	}
	return strings.Join(lines, "\n")
}

// OpenDataDir 用文件管理器打开数据目录。
func (a *App) OpenDataDir() error {
	return filemanager.Open(config.DataDir(), a.settings.FileManager)
}

// SaveConnectionOrder 保存连接排序。
func (a *App) SaveConnectionOrder(names []string) error {
	return config.WriteOrder(names)
}

// Mkdir 新建远程目录。
func (a *App) Mkdir(remotePath string) error {
	return rclonefs.Mkdir(a.ctx, a.settings.RcloneConfig, remotePath)
}

// Move 重命名远程对象。
func (a *App) Move(oldPath, newPath string) error {
	return rclonefs.Move(a.ctx, a.settings.RcloneConfig, oldPath, newPath)
}

// Delete 删除远程对象或目录。
func (a *App) Delete(remotePath string, isDir bool) error {
	return rclonefs.Delete(a.ctx, a.settings.RcloneConfig, remotePath, isDir)
}

// ObjectInfo 返回对象属性。
func (a *App) ObjectInfo(remotePath string) (map[string]string, error) {
	return rclonefs.ObjectInfo(a.ctx, a.settings.RcloneConfig, remotePath)
}

// DirSize 返回目录递归大小（字节），供文件列表自动统计使用。
func (a *App) DirSize(remotePath string) (int64, error) {
	_, bytes, err := rclonefs.Size(a.ctx, a.settings.RcloneConfig, remotePath)
	return bytes, err
}

// Size 统计目录占用。
func (a *App) Size(remotePath string) (string, error) {
	objects, bytes, err := rclonefs.Size(a.ctx, a.settings.RcloneConfig, remotePath)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("对象 %d 个，总大小 %.1f MB", objects, float64(bytes)/1024/1024), nil
}

// Presign 生成 7 天有效的下载链接。
func (a *App) Presign(remotePath string) (string, error) {
	colon := strings.Index(remotePath, ":")
	if colon <= 0 {
		return "", fmt.Errorf("路径格式应为 连接:桶/对象")
	}
	remoteName := remotePath[:colon]
	rest := strings.TrimPrefix(remotePath[colon+1:], "/")
	slash := strings.Index(rest, "/")
	if slash <= 0 || slash == len(rest)-1 {
		return "", fmt.Errorf("请选择桶内的文件")
	}
	bucket := rest[:slash]
	key := rest[slash+1:]
	return policy.Presign(a.ctx, a.settings.RcloneConfig, remoteName, bucket, key, 7*24*time.Hour)
}

// UploadFolder 递归上传本地目录。
func (a *App) UploadFolder(remoteDir, localDir string) error {
	return transfer.UploadFolder(a.ctx, a.settings.RcloneConfig, localDir, remoteDir)
}

// PreviewRemote 下载对象到临时目录并用系统默认程序打开。
func (a *App) PreviewRemote(remotePath string) (string, error) {
	local, err := transfer.Download(a.ctx, a.settings.RcloneConfig, remotePath, filepath.Join(config.DataDir(), "preview"))
	if err != nil {
		return "", err
	}
	return local, filemanager.Preview(local)
}

// SetClipboard 写入文本到剪贴板。
func (a *App) SetClipboard(text string) {
	runtime.ClipboardSetText(a.ctx, text)
}

// TextFile 是文本编辑结果。
type TextFile struct {
	Text      string `json:"text"`
	LocalPath string `json:"localPath"`
}

// ReadObjectText 下载对象并作为文本返回，超过 2MB 拒绝。
func (a *App) ReadObjectText(remotePath string) (TextFile, error) {
	local, err := transfer.Download(a.ctx, a.settings.RcloneConfig, remotePath, filepath.Join(config.DataDir(), "edit"))
	if err != nil {
		return TextFile{}, err
	}
	data, err := os.ReadFile(local)
	if err != nil {
		return TextFile{}, err
	}
	if len(data) > 2*1024*1024 {
		return TextFile{}, fmt.Errorf("文件超过 2MB，不适合文本编辑")
	}
	return TextFile{Text: string(data), LocalPath: local}, nil
}

// SaveObjectText 保存文本并上传覆盖原对象。
func (a *App) SaveObjectText(remotePath, localPath, text string) error {
	if localPath == "" {
		return fmt.Errorf("缺少本地临时文件")
	}
	if err := os.WriteFile(localPath, []byte(text), 0o644); err != nil {
		return err
	}
	index := strings.LastIndex(remotePath, "/")
	parent := remotePath
	if index > 0 {
		parent = remotePath[:index]
	}
	return transfer.Upload(a.ctx, a.settings.RcloneConfig, localPath, parent)
}

// SetExpiry 设置对象过期天数。
func (a *App) SetExpiry(remotePath string, days int) error {
	colon := strings.Index(remotePath, ":")
	if colon <= 0 {
		return fmt.Errorf("路径格式应为 连接:桶/对象")
	}
	remoteName := remotePath[:colon]
	rest := strings.TrimPrefix(remotePath[colon+1:], "/")
	slash := strings.Index(rest, "/")
	if slash <= 0 || slash == len(rest)-1 {
		return fmt.Errorf("请选择桶内的文件")
	}
	return policy.SetExpiry(a.ctx, a.settings.RcloneConfig, remoteName, rest[:slash], rest[slash+1:], days)
}

// DownloadBatch 并发下载多个对象。
func (a *App) DownloadBatch(remotePaths []string, localDir string) (string, error) {
	if len(remotePaths) == 0 {
		return "", fmt.Errorf("没有要下载的文件")
	}
	limit := a.settings.MaxConcurrentTransfers
	if limit <= 0 {
		limit = 4
	}
	sem := make(chan struct{}, limit)
	var wg sync.WaitGroup
	var mu sync.Mutex
	success, failed := 0, 0
	var problems []string
	for _, path := range remotePaths {
		wg.Add(1)
		sem <- struct{}{}
		go func(target string) {
			defer wg.Done()
			defer func() { <-sem }()
			local, err := transfer.DownloadWithProgress(a.ctx, a.settings.RcloneConfig, target, localDir, a.downloadStreams())
			mu.Lock()
			if err != nil {
				failed++
				problems = append(problems, filepath.Base(target)+"："+err.Error())
			} else {
				success++
				size := int64(0)
				if info, statErr := os.Stat(local); statErr == nil {
					size = info.Size()
				}
				download.Add(target, local, size)
			}
			mu.Unlock()
		}(path)
	}
	wg.Wait()
	message := fmt.Sprintf("下载完成：成功 %d 个，失败 %d 个", success, failed)
	if len(problems) > 0 {
		message += "；" + strings.Join(problems, "；")
	}
	return message, nil
}

// DownloadFolder 递归下载远程目录。
func (a *App) DownloadFolder(remoteDir, localDir string) error {
	if err := transfer.DownloadFolder(a.ctx, a.settings.RcloneConfig, remoteDir, localDir); err != nil {
		return err
	}
	download.Add(remoteDir, localDir, 0)
	return nil
}

// CreateBucket 新建桶。
func (a *App) CreateBucket(remoteName, bucket string) error {
	return policy.CreateBucket(a.ctx, a.settings.RcloneConfig, remoteName, bucket)
}

// UpdateInfo 是更新检查结果。
type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	URL       string `json:"url"`
	HasUpdate bool   `json:"hasUpdate"`
}

// CheckUpdate 查询 GitHub 最新版本。
func (a *App) CheckUpdate() (UpdateInfo, error) {
	info := UpdateInfo{Current: appVersion}
	request, err := http.NewRequest("GET", "https://api.github.com/repos/wangli-dev/OssManager/releases/latest", nil)
	if err != nil {
		return info, err
	}
	request.Header.Set("User-Agent", "OssManager")
	client := &http.Client{Timeout: 15 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return info, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return info, fmt.Errorf("GitHub 返回 %d", response.StatusCode)
	}
	var release struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(response.Body).Decode(&release); err != nil {
		return info, err
	}
	info.Latest = release.TagName
	for _, asset := range release.Assets {
		if strings.HasSuffix(strings.ToLower(asset.Name), ".exe") {
			info.URL = asset.BrowserDownloadURL
			break
		}
	}
	info.HasUpdate = compareVersion(strings.TrimPrefix(info.Latest, "v"), info.Current) > 0
	return info, nil
}

func compareVersion(left, right string) int {
	parse := func(value string) []int {
		parts := strings.Split(strings.TrimPrefix(value, "v"), ".")
		result := make([]int, len(parts))
		for i, part := range parts {
			fmt.Sscanf(part, "%d", &result[i])
		}
		return result
	}
	a, b := parse(left), parse(right)
	for i := 0; i < len(a) || i < len(b); i++ {
		var x, y int
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			if x > y {
				return 1
			}
			return -1
		}
	}
	return 0
}

// DownloadUpdate 下载新版本并启动替换脚本，随后退出程序。
func (a *App) DownloadUpdate(url string) error {
	if url == "" {
		return fmt.Errorf("没有可下载的更新包")
	}
	response, err := http.Get(url)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("下载失败：HTTP %d", response.StatusCode)
	}
	dir := config.DataDir()
	updateExe := filepath.Join(dir, "update.exe")
	file, err := os.Create(updateExe)
	if err != nil {
		return err
	}
	if _, err := file.ReadFrom(response.Body); err != nil {
		file.Close()
		return err
	}
	file.Close()
	script := filepath.Join(dir, "update.cmd")
	current := filepath.Join(dir, "OssManager.exe")
	content := "@echo off\r\n" +
		"timeout /t 3 /nobreak >nul\r\n" +
		"copy /y \"" + updateExe + "\" \"" + current + "\" >nul\r\n" +
		"start \"\" \"" + current + "\"\r\n" +
		"del \"" + updateExe + "\"\r\n" +
		"del \"%~f0\"\r\n"
	if err := os.WriteFile(script, []byte(content), 0o644); err != nil {
		return err
	}
	if err := exec.Command("cmd", "/c", "start", "", script).Start(); err != nil {
		return err
	}
	runtime.Quit(a.ctx)
	return nil
}
