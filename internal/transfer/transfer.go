package transfer

import (
	"context"
	"fmt"
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
// 根目录下的对象形如 remote:file，没有斜杠，需要按连接名后的冒号切分。
func splitRemote(remotePath string) (string, string) {
	if index := strings.LastIndex(remotePath, "/"); index >= 0 {
		return remotePath[:index], remotePath[index+1:]
	}
	colon := strings.Index(remotePath, ":")
	if colon < 0 || colon == len(remotePath)-1 {
		return remotePath, ""
	}
	return remotePath[:colon+1], remotePath[colon+1:]
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
	if rclonefs.BucketListRoot(confPath, remoteDir) {
		return fmt.Errorf("S3 连接 %s 的根目录是桶列表，不能直接上传文件，请先进入某个桶再上传", rclonefs.RemoteName(remoteDir))
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

// FolderTarget 返回上传目录时在 remoteRoot 下使用的目标目录：保留目录本身的名字，
// 避免把目录里的内容平铺到目标目录。
func FolderTarget(remoteRoot, localDir string) string {
	return strings.TrimSuffix(remoteRoot, "/") + "/" + filepath.Base(filepath.Clean(localDir))
}

// UploadFolder 递归上传本地目录，在 remoteRoot 下建同名目录并保留相对结构。
func UploadFolder(ctx context.Context, confPath, localDir, remoteRoot string) error {
	if err := ensureConfig(confPath); err != nil {
		return err
	}
	if rclonefs.BucketListRoot(confPath, remoteRoot) {
		return fmt.Errorf("S3 连接 %s 的根目录是桶列表，不能直接上传文件夹，请先进入某个桶再上传", rclonefs.RemoteName(remoteRoot))
	}
	root := FolderTarget(remoteRoot, localDir)
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
		target := root
		if sub != "." && sub != "" {
			target = strings.TrimSuffix(root, "/") + "/" + sub
		}
		return Upload(ctx, confPath, path, target)
	})
}
