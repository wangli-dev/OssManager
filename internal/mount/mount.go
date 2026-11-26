package mount

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	_ "github.com/rclone/rclone/backend/ftp"
	_ "github.com/rclone/rclone/backend/local"
	_ "github.com/rclone/rclone/backend/s3"
	_ "github.com/rclone/rclone/backend/sftp"
	_ "github.com/rclone/rclone/backend/webdav"
	"github.com/rclone/rclone/cmd/cmount"
	"github.com/rclone/rclone/cmd/mountlib"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/config/configfile"
	"github.com/rclone/rclone/vfs"
	vfscommon "github.com/rclone/rclone/vfs/vfscommon"
	"github.com/winfsp/cgofuse/fuse"
)

// Options 是挂载高级参数，空值表示使用 rclone 默认。
type Options struct {
	CacheDirectory   string
	DirCacheTime     string
	VfsCacheMaxSize  string
	VfsCacheMaxAge   string
	BufferSize       string
	VolumeName       string
	UseServerModtime bool
}

type mountEntry struct {
	remote string
	drive  string
	host   *fuse.FileSystemHost
}

// Manager 维护进程内的挂载表。
type Manager struct {
	mu     sync.Mutex
	mounts map[string]*mountEntry
}

// NewManager 创建挂载管理器。
func NewManager() *Manager {
	return &Manager{mounts: map[string]*mountEntry{}}
}

var (
	configMu   sync.Mutex
	activeConf string
)

func ensureConfig(path string) error {
	configMu.Lock()
	defer configMu.Unlock()
	if activeConf == path {
		return nil
	}
	if err := config.SetConfigPath(path); err != nil {
		return err
	}
	configfile.Install()
	activeConf = path
	return nil
}

// Mount 把 remote 挂载到指定盘符，等待盘符出现后返回。
func (m *Manager) Mount(ctx context.Context, confPath, remote, drive string, opts Options) error {
	if err := ensureConfig(confPath); err != nil {
		return err
	}
	key := strings.ToUpper(drive)
	m.mu.Lock()
	if _, ok := m.mounts[key]; ok {
		m.mu.Unlock()
		return fmt.Errorf("%s 已经挂载", drive)
	}
	m.mu.Unlock()

	f, err := fs.NewFs(ctx, remote)
	if err != nil {
		return err
	}
	vfsOpt := vfscommon.Opt
	applyOptions(ctx, &vfsOpt, opts)
	v := vfs.New(ctx, f, &vfsOpt)
	mountOpt := mountlib.Opt
	mfs := cmount.NewFS(v, &mountOpt)
	host := fuse.NewFileSystemHost(mfs)
	flags := []string{}
	if opts.VolumeName != "" {
		flags = []string{"-o", "volname=" + opts.VolumeName}
	}
	go func() { host.Mount(drive, flags) }()

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(drive + `\`); err == nil {
			m.mu.Lock()
			m.mounts[key] = &mountEntry{remote: remote, drive: drive, host: host}
			m.mu.Unlock()
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	host.Unmount()
	return fmt.Errorf("挂载超时，请确认已安装 WinFsp")
}

// Unmount 卸载指定盘符并等待盘符释放。
func (m *Manager) Unmount(drive string) error {
	key := strings.ToUpper(drive)
	m.mu.Lock()
	entry, ok := m.mounts[key]
	delete(m.mounts, key)
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("%s 没有由本程序挂载", drive)
	}
	entry.host.Unmount()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(drive + `\`); err != nil {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("卸载超时，请手动检查 %s", drive)
}

// List 返回盘符到 remote 的映射。
func (m *Manager) List() map[string]string {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make(map[string]string, len(m.mounts))
	for drive, entry := range m.mounts {
		result[drive] = entry.remote
	}
	return result
}

func applyOptions(ctx context.Context, v *vfscommon.Options, opts Options) {
	cfg := fs.GetConfig(ctx)
	if opts.CacheDirectory != "" {
		_ = config.SetCacheDir(opts.CacheDirectory)
	}
	if opts.BufferSize != "" {
		var size fs.SizeSuffix
		if err := size.Set(opts.BufferSize); err == nil {
			cfg.BufferSize = size
		}
	}
	if opts.DirCacheTime != "" {
		if d, err := fs.ParseDuration(opts.DirCacheTime); err == nil {
			v.DirCacheTime = fs.Duration(d)
		}
	}
	if opts.VfsCacheMaxSize != "" {
		var size fs.SizeSuffix
		if err := size.Set(opts.VfsCacheMaxSize); err == nil {
			v.CacheMaxSize = size
		}
	}
	if opts.VfsCacheMaxAge != "" {
		if d, err := fs.ParseDuration(opts.VfsCacheMaxAge); err == nil {
			v.CacheMaxAge = fs.Duration(d)
		}
	}
	if opts.UseServerModtime {
		cfg.UseServerModTime = true
	}
}
