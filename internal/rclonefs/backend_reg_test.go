package rclonefs

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rclone/rclone/fs/config/obscure"
)

// TestWebBackendsRegistered 验证 UI 声称支持的 webdav/sftp/ftp 后端确实已注册：
// 失败必须是连接层错误（127.0.0.1 无服务），而不是 backend 未注册。
func TestWebBackendsRegistered(t *testing.T) {
	conf := filepath.Join(t.TempDir(), "rclone.conf")
	pass := obscure.MustObscure("dummy-pass")
	var sb strings.Builder
	for _, c := range []struct{ name, typ, host string }{
		{"t_sftp", "sftp", "host = 127.0.0.1"},
		{"t_webdav", "webdav", "url = http://127.0.0.1:1"},
		{"t_ftp", "ftp", "host = 127.0.0.1"},
	} {
		sb.WriteString("[" + c.name + "]\ntype = " + c.typ + "\n" + c.host + "\nuser = u\npass = " + pass + "\n\n")
	}
	if err := os.WriteFile(conf, []byte(sb.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"t_sftp", "t_webdav", "t_ftp"} {
		_, err := List(context.Background(), conf, name+":")
		if err == nil {
			t.Fatalf("%s: unexpected success against 127.0.0.1", name)
		}
		msg := err.Error()
		for _, bad := range []string{"couldn't find backend", "didn't find section", "unknown backend"} {
			if strings.Contains(msg, bad) {
				t.Fatalf("%s: backend not registered: %v", name, err)
			}
		}
	}
}
