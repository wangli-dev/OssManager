package transfer

import "testing"

// 根目录下的对象（remote:file，无斜杠）也要能拆出父 remote 与文件名，
// 否则 Download/DragOut 会返回 os.ErrInvalid（invalid argument）。
func TestSplitRemote(t *testing.T) {
	cases := []struct {
		input string
		dir   string
		name  string
	}{
		{"ssh-donghui:.gitconfig", "ssh-donghui:", ".gitconfig"},
		{"minio:bucket", "minio:", "bucket"},
		{"ssh-a:dir/file.txt", "ssh-a:dir", "file.txt"},
		{"minio:bucket/a/b/c.txt", "minio:bucket/a/b", "c.txt"},
		{"ssh-a:", "ssh-a:", ""},
		{"plainfile.txt", "plainfile.txt", ""},
	}
	for _, item := range cases {
		dir, name := splitRemote(item.input)
		if dir != item.dir || name != item.name {
			t.Errorf("splitRemote(%q) = (%q, %q), 期望 (%q, %q)", item.input, dir, name, item.dir, item.name)
		}
	}
}

// 上传目录要保留目录名，否则内容会被平铺到目标目录。
func TestFolderTarget(t *testing.T) {
	cases := []struct{ root, local, want string }{
		{"ssh-a:", `C:\Users\I\Documents\a`, "ssh-a:/a"},
		{"ssh-a:Documents/My Music", `C:\Users\I\Documents\a`, "ssh-a:Documents/My Music/a"},
		{"ssh-a:/", "D:/photos/b/", "ssh-a:/b"},
		{"minio:bucket/dir", `D:\x\c`, "minio:bucket/dir/c"},
	}
	for _, item := range cases {
		if got := FolderTarget(item.root, item.local); got != item.want {
			t.Errorf("FolderTarget(%q, %q) = %q, 期望 %q", item.root, item.local, got, item.want)
		}
	}
}

// S3 连接的根是桶列表（remote 只写连接名、路径为空、类型 s3 且未内置桶名），
// 不能作为上传目标；rclone 会报 Key must not be empty 这类天书错误。
func TestSplitRemotePath(t *testing.T) {
	// 这里只验证 RemoteOptions 依赖的解析路径，桶列表根判定走 rclonefs.BucketListRoot（需 conf）。
	dir, name := splitRemote("minio:bucket/file.txt")
	if dir != "minio:bucket" || name != "file.txt" {
		t.Fatalf("splitRemote 结果不符: %q %q", dir, name)
	}
}
