package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"OssManager/internal/clipboard"
	"OssManager/internal/config"
	"OssManager/internal/connjson"
	"OssManager/internal/filemanager"
	"OssManager/internal/mount"
	"OssManager/internal/policy"
	"OssManager/internal/rclonefs"
	"OssManager/internal/remote"
	"OssManager/internal/transfer"
)

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
	go a.restoreMounts()
}

func (a *App) mountOptions() mount.Options {
	return mount.Options{
		CacheDirectory:  a.settings.CacheDirectory,
		DirCacheTime:    a.settings.DirCacheTime,
		VfsCacheMaxSize: a.settings.VfsCacheMaxSize,
		VfsCacheMaxAge:  a.settings.VfsCacheMaxAge,
		BufferSize:      a.settings.BufferSize,
	}
}

func (a *App) restoreMounts() {
	time.Sleep(3 * time.Second)
	seen := make(map[string]bool)
	for _, record := range config.ReadMountRecords() {
		remote := strings.TrimSuffix(record.Remote, ":") + ":"
		if seen[remote] {
			continue
		}
		seen[remote] = true
		if _, err := os.Stat(record.Drive + `\`); err == nil {
			continue
		}
		if err := a.mounter.Mount(a.ctx, a.settings.RcloneConfig, remote, record.Drive, a.mountOptions()); err != nil {
			logf("restore mount %s %s err=%v", remote, record.Drive, err)
		} else {
			logf("restore mount %s %s ok", remote, record.Drive)
		}
	}
	runtime.EventsEmit(a.ctx, "mounts-changed")
}

func (a *App) addMountRecord(remote, drive string) {
	remote = strings.TrimSuffix(remote, ":") + ":"
	records := config.ReadMountRecords()
	for _, record := range records {
		if strings.EqualFold(record.Drive, drive) && strings.TrimSuffix(record.Remote, ":")+":" == remote {
			return
		}
	}
	records = append(records, config.MountRecord{Remote: remote, Drive: drive})
	_ = config.WriteMountRecords(records)
}

func (a *App) removeMountRecord(remote string) {
	var kept []config.MountRecord
	for _, record := range config.ReadMountRecords() {
		if record.Remote != remote {
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
	remote = strings.TrimSuffix(remote, ":") + ":"
	logf("Mount remote=%s drive=%s volume=%s", remote, drive, volumeName)
	options := a.mountOptions()
	options.VolumeName = volumeName
	err := a.mounter.Mount(a.ctx, a.settings.RcloneConfig, remote, drive, options)
	logf("Mount result err=%v", err)
	if err == nil {
		a.addMountRecord(remote, drive)
		runtime.EventsEmit(a.ctx, "mounts-changed")
	}
	return err
}

// Unmount 卸载盘符。
func (a *App) Unmount(drive string) error {
	logf("Unmount drive=%s", drive)
	err := a.mounter.Unmount(drive)
	logf("Unmount err=%v", err)
	return err
}

// UnmountByRemote 按连接名卸载其所有挂载，避免前端挂载表不同步。
func (a *App) UnmountByRemote(remoteName string) error {
	target := strings.TrimSuffix(remoteName, ":") + ":"
	found := false
	for drive, remote := range a.mounter.List() {
		if strings.TrimSuffix(remote, ":")+":" != target {
			continue
		}
		found = true
		if err := a.mounter.Unmount(drive); err != nil {
			return err
		}
	}
	if !found {
		return fmt.Errorf("%s 没有挂载", remoteName)
	}
	a.removeMountRecord(target)
	runtime.EventsEmit(a.ctx, "mounts-changed")
	return nil
}

// ListMounts 返回盘符到 remote 的映射。
func (a *App) ListMounts() map[string]string {
	mounts := a.mounter.List()
	logf("ListMounts %v", mounts)
	return mounts
}

// FreeDrives 返回当前未被占用的盘符，按 Z 到 D 的顺序。
func (a *App) FreeDrives() []string {
	logf("FreeDrives called")
	result := []string{}
	for c := 'Z'; c >= 'D'; c-- {
		drive := string(c) + ":"
		if _, err := os.Stat(drive + `\`); err != nil {
			result = append(result, drive)
		}
	}
	logf("FreeDrives result=%v", result)
	return result
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

// SaveConnection 新增或更新连接。
func (a *App) SaveConnection(def remote.Definition, exists bool) error {
	err := remote.Save(a.settings.RcloneConfig, def, exists)
	logf("SaveConnection %s exists=%v err=%v", def.Name, exists, err)
	return err
}

// DeleteConnection 删除连接。
func (a *App) DeleteConnection(name string) error {
	return remote.Delete(a.settings.RcloneConfig, name)
}

// RenameConnection 修改内部连接名。
func (a *App) RenameConnection(oldName, newName string) error {
	return remote.Rename(a.settings.RcloneConfig, oldName, newName)
}

// TestConnection 通过列根目录验证连接可用。
func (a *App) TestConnection(name string) error {
	_, err := rclonefs.List(a.ctx, a.settings.RcloneConfig, name+":")
	return err
}

// Download 下载远程对象到本地目录。
func (a *App) Download(remotePath, localDir string) (string, error) {
	return transfer.Download(a.ctx, a.settings.RcloneConfig, remotePath, localDir)
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

// OpenFolder 用文件管理器打开目录。
func (a *App) OpenFolder(path string) error {
	return filemanager.Open(path, a.settings.FileManager)
}

// ExportConnections 导出连接 JSON；path 为空时返回文本。
func (a *App) ExportConnections(path string, includeSecrets bool) (string, error) {
	text, err := connjson.Export(a.settings.RcloneConfig, includeSecrets)
	if err != nil {
		return "", err
	}
	if path == "" {
		return text, nil
	}
	return text, os.WriteFile(path, []byte(text), 0o644)
}

// ImportConnections 从 JSON 导入连接。
func (a *App) ImportConnections(path string) (string, error) {
	return connjson.Import(a.settings.RcloneConfig, path)
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
		AppVersion:    "1.0.0",
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
