package transfer

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"

	_ "github.com/rclone/rclone/backend/local"
	_ "github.com/rclone/rclone/backend/s3"
	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/config/configfile"
	"github.com/rclone/rclone/fs/operations"
)

var (
	mu         sync.Mutex
	activeConf string
)

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

// splitRemote 把 remote:bucket/dir/file 拆成父目录和文件名。
func splitRemote(remotePath string) (string, string) {
	index := strings.LastIndex(remotePath, "/")
	if index < 0 {
		return remotePath, ""
	}
	return remotePath[:index], remotePath[index+1:]
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
	srcFs, err := fs.NewFs(ctx, parent)
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
	dstFs, err := fs.NewFs(ctx, remoteDir)
	if err != nil {
		return err
	}
	_, err = operations.Copy(ctx, dstFs, nil, filepath.Base(localPath), srcObj)
	return err
}
