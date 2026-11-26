package rclonefs

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"

	_ "github.com/rclone/rclone/backend/ftp"
	_ "github.com/rclone/rclone/backend/local"
	_ "github.com/rclone/rclone/backend/s3"
	_ "github.com/rclone/rclone/backend/sftp"
	_ "github.com/rclone/rclone/backend/webdav"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/config/configfile"
	hashpkg "github.com/rclone/rclone/fs/hash"
	"github.com/rclone/rclone/fs/operations"
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

// Probe 用连接串直接测试连通性，不依赖 rclone 配置文件。
func Probe(ctx context.Context, remotePath string) error {
	f, err := fs.NewFs(ctx, remotePath)
	if err != nil {
		return err
	}
	_, err = f.List(ctx, "")
	return err
}

// List 列出 remote:path 下的对象；目录在前，其余按名称排序。
func List(ctx context.Context, confPath, remote string) ([]Entry, error) {
	if err := ensureConfig(confPath); err != nil {
		return nil, err
	}
	f, err := NewFs(ctx, confPath, remote)
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

func splitPath(remotePath string) (string, string) {
	index := strings.LastIndex(remotePath, "/")
	if index < 0 {
		return remotePath, ""
	}
	return remotePath[:index], remotePath[index+1:]
}

func objectOf(ctx context.Context, confPath, remotePath string) (fs.Fs, fs.Object, error) {
	parent, name := splitPath(remotePath)
	f, err := NewFs(ctx, confPath, parent)
	if err != nil {
		return nil, nil, err
	}
	obj, err := f.NewObject(ctx, name)
	if err != nil {
		return nil, nil, err
	}
	return f, obj, nil
}

// Mkdir 新建远程目录。
func Mkdir(ctx context.Context, confPath, remoteDir string) error {
	if err := ensureConfig(confPath); err != nil {
		return err
	}
	f, err := NewFs(ctx, confPath, remoteDir)
	if err != nil {
		return err
	}
	return f.Mkdir(ctx, "")
}

// Move 重命名或移动远程对象。
func Move(ctx context.Context, confPath, oldPath, newPath string) error {
	if err := ensureConfig(confPath); err != nil {
		return err
	}
	_, src, err := objectOf(ctx, confPath, oldPath)
	if err != nil {
		return err
	}
	parent, name := splitPath(newPath)
	dstFs, err := NewFs(ctx, confPath, parent)
	if err != nil {
		return err
	}
	_, err = operations.Move(ctx, dstFs, nil, name, src)
	return err
}

// Delete 删除远程文件或目录（目录会递归删除）。
func Delete(ctx context.Context, confPath, remotePath string, isDir bool) error {
	if err := ensureConfig(confPath); err != nil {
		return err
	}
	if isDir {
		f, err := NewFs(ctx, confPath, remotePath)
		if err != nil {
			return err
		}
		return operations.Purge(ctx, f, "")
	}
	_, obj, err := objectOf(ctx, confPath, remotePath)
	if err != nil {
		return err
	}
	return obj.Remove(ctx)
}

// Size 统计目录对象数量与总大小。
func Size(ctx context.Context, confPath, remotePath string) (int64, int64, error) {
	if err := ensureConfig(confPath); err != nil {
		return 0, 0, err
	}
	f, err := NewFs(ctx, confPath, remotePath)
	if err != nil {
		return 0, 0, err
	}
	objects, size, _, err := operations.Count(ctx, f)
	return objects, size, err
}

// ObjectInfo 返回对象的基本属性，供属性面板展示。
func ObjectInfo(ctx context.Context, confPath, remotePath string) (map[string]string, error) {
	if err := ensureConfig(confPath); err != nil {
		return nil, err
	}
	_, obj, err := objectOf(ctx, confPath, remotePath)
	if err != nil {
		return nil, err
	}
	info := map[string]string{
		"名称":   obj.Remote(),
		"大小":   fmt.Sprintf("%d", obj.Size()),
		"修改时间": obj.ModTime(ctx).Format("2006-01-02 15:04:05"),
	}
	if typer, ok := obj.(fs.MimeTyper); ok {
		if mime := typer.MimeType(ctx); mime != "" {
			info["MIME 类型"] = mime
		}
	}
	if hashType := obj.Fs().Hashes().GetOne(); hashType != hashpkg.None {
		if value, err := obj.Hash(ctx, hashType); err == nil && value != "" {
			info[strings.ToUpper(fmt.Sprintf("%v", hashType))] = strings.ToUpper(value)
		}
	}
	return info, nil
}
