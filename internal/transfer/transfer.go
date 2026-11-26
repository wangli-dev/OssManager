package transfer

import (
	"context"
	iofs "io/fs"
	"os"
	"path/filepath"
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
	"github.com/rclone/rclone/fs/operations"
	"OssManager/internal/rclonefs"
	rwalk "github.com/rclone/rclone/fs/walk"
)

var (
	mu         sync.Mutex
	activeConf string
	transfers  int
)

// SetConcurrency 设置传输并发数；0 表示使用 rclone 默认。
func SetConcurrency(value int) {
	mu.Lock()
	transfers = value
	mu.Unlock()
	if value > 0 {
		fs.GetConfig(context.Background()).Transfers = value
	}
}

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

// DownloadFolder 递归下载远程目录到本地目录。
func DownloadFolder(ctx context.Context, confPath, remoteDir, localDir string) error {
	if err := ensureConfig(confPath); err != nil {
		return err
	}
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		return err
	}
	srcFs, err := rclonefs.NewFs(ctx, confPath, remoteDir)
	if err != nil {
		return err
	}
	return rwalk.Walk(ctx, srcFs, "", false, -1, func(path string, entries fs.DirEntries, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		for _, entry := range entries {
			obj, ok := entry.(fs.Object)
			if !ok {
				continue
			}
			relative := obj.Remote()
			target := localDir
			if dir := filepath.Dir(relative); dir != "." {
				target = filepath.Join(localDir, dir)
			}
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			dstFs, err := fs.NewFs(ctx, target)
			if err != nil {
				return err
			}
			if _, err := operations.Copy(ctx, dstFs, nil, filepath.Base(relative), obj); err != nil {
				return err
			}
		}
		return nil
	})
}

// splitRemote 把 remote:bucket/dir/file 拆成父目录和文件名。
func splitRemote(remotePath string) (string, string) {
	index := strings.LastIndex(remotePath, "/")
	if index < 0 {
		return remotePath, ""
	}
	return remotePath[:index], remotePath[index+1:]
}

// CopyRemote 把远程对象复制到另一个远程目录，支持跨连接复制。
func CopyRemote(ctx context.Context, confPath, srcPath, dstDir string) (string, error) {
	if err := ensureConfig(confPath); err != nil {
		return "", err
	}
	parent, name := splitRemote(srcPath)
	if name == "" {
		return "", os.ErrInvalid
	}
	srcFs, err := rclonefs.NewFs(ctx, confPath, parent)
	if err != nil {
		return "", err
	}
	srcObj, err := srcFs.NewObject(ctx, name)
	if err != nil {
		return "", err
	}
	dstFs, err := rclonefs.NewFs(ctx, confPath, dstDir)
	if err != nil {
		return "", err
	}
	if _, err := operations.Copy(ctx, dstFs, nil, name, srcObj); err != nil {
		return "", err
	}
	return dstDir + "/" + name, nil
}

// Download 把远程对象下载到本地目录，返回本地完整路径。
func Download(ctx context.Context, confPath, remotePath, localDir string) (string, error) {
	if err := ensureConfig(confPath); err != nil {
		return "", err
	}
	parent, name := splitRemote(remotePath)
	if name == "" {
		return "", os.ErrInvalid
	}
	srcFs, err := rclonefs.NewFs(ctx, confPath, parent)
	if err != nil {
		return "", err
	}
	srcObj, err := srcFs.NewObject(ctx, name)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		return "", err
	}
	dstFs, err := fs.NewFs(ctx, localDir)
	if err != nil {
		return "", err
	}
	if _, err := operations.Copy(ctx, dstFs, nil, name, srcObj); err != nil {
		return "", err
	}
	return filepath.Join(localDir, name), nil
}

// Upload 把本地文件上传到远程目录。
func Upload(ctx context.Context, confPath, localPath, remoteDir string) error {
	if err := ensureConfig(confPath); err != nil {
		return err
	}
	srcFs, err := fs.NewFs(ctx, filepath.Dir(localPath))
	if err != nil {
		return err
	}
	srcObj, err := srcFs.NewObject(ctx, filepath.Base(localPath))
	if err != nil {
		return err
	}
	dstFs, err := rclonefs.NewFs(ctx, confPath, remoteDir)
	if err != nil {
		return err
	}
	_, err = operations.Copy(ctx, dstFs, nil, filepath.Base(localPath), srcObj)
	return err
}

// UploadFolder 递归上传本地目录，保留相对目录结构。
func UploadFolder(ctx context.Context, confPath, localDir, remoteRoot string) error {
	if err := ensureConfig(confPath); err != nil {
		return err
	}
	return filepath.WalkDir(localDir, func(path string, entry iofs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		relative, relErr := filepath.Rel(localDir, path)
		if relErr != nil {
			return relErr
		}
		sub := filepath.ToSlash(filepath.Dir(relative))
		target := remoteRoot
		if sub != "." && sub != "" {
			target = strings.TrimSuffix(remoteRoot, "/") + "/" + sub
		}
		return Upload(ctx, confPath, path, target)
	})
}
