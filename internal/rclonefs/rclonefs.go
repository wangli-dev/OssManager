package rclonefs

import (
	"context"
	"sort"
	"sync"

	_ "github.com/rclone/rclone/backend/local"
	_ "github.com/rclone/rclone/backend/s3"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/config/configfile"
)

// Entry 是目录中的一项，供前端展示。
type Entry struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"`
}

var (
	mu         sync.Mutex
	activeConf string
)

// ensureConfig 让 rclone 库切换到指定配置文件；同一进程只安装一次。
func ensureConfig(path string) error {
	mu.Lock()
	defer mu.Unlock()
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

// List 列出 remote:path 下的对象；目录在前，其余按名称排序。
func List(ctx context.Context, confPath, remote string) ([]Entry, error) {
	if err := ensureConfig(confPath); err != nil {
		return nil, err
	}
	f, err := fs.NewFs(ctx, remote)
	if err != nil {
		return nil, err
	}
	entries, err := f.List(ctx, "")
	if err != nil {
		return nil, err
	}
	result := make([]Entry, 0, len(entries))
	for _, entry := range entries {
		modTime := ""
		if !entry.ModTime(ctx).IsZero() {
			modTime = entry.ModTime(ctx).Format("2006-01-02 15:04:05")
		}
		_, isDir := entry.(fs.Directory)
		result = append(result, Entry{
			Name:    entry.Remote(),
			IsDir:   isDir,
			Size:    entry.Size(),
			ModTime: modTime,
		})
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return result[i].Name < result[j].Name
	})
	return result, nil
}
