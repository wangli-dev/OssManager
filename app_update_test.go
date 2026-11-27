package main

// 自动更新完整性校验的单元测试：
// 用 httptest 模拟上游 .sha256 的三种情况（匹配/不匹配/未发布），域名白名单做正反用例。

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUpdateHostAllowed(t *testing.T) {
	allowed := []string{"github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "GITHUB.COM"}
	for _, host := range allowed {
		if !updateHostAllowed(host) {
			t.Fatalf("合法域名被拒绝：%s", host)
		}
	}
	denied := []string{"evil.com", "github.com.evil.com", "", "192.168.1.1"}
	for _, host := range denied {
		if updateHostAllowed(host) {
			t.Fatalf("非法域名被放行：%s", host)
		}
	}
}

func TestVerifyUpdateSHA256(t *testing.T) {
	// 准备被校验的本地"更新包"
	dir := t.TempDir()
	pkg := filepath.Join(dir, "OssManager.exe")
	content := strings.Repeat("A", 1<<20)
	if err := os.WriteFile(pkg, []byte(content), 0o644); err != nil {
		t.Fatalf("准备更新包失败：%v", err)
	}
	sum := fmt.Sprintf("%x", sha256.Sum256([]byte(content)))
	mux := http.NewServeMux()
	// 正常 .sha256（格式 "<hex>  <文件名>"）
	mux.HandleFunc("/good.exe.sha256", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s  OssManager.exe\n", sum)
	})
	// 内容被篡改的更新包（哈希对不上）
	mux.HandleFunc("/tampered.exe.sha256", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s  OssManager.exe\n", strings.Repeat("0", 64))
	})
	// 上游未发布 .sha256
	mux.HandleFunc("/nosum.exe.sha256", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	client := server.Client()
	if err := verifyUpdateSHA256(client, server.URL+"/good.exe", pkg); err != nil {
		t.Fatalf("哈希匹配时应通过：%v", err)
	}
	if err := verifyUpdateSHA256(client, server.URL+"/tampered.exe", pkg); err == nil {
		t.Fatalf("哈希不匹配时必须拒绝安装")
	}
	if err := verifyUpdateSHA256(client, server.URL+"/nosum.exe", pkg); err != nil {
		t.Fatalf("上游未发布 .sha256 时应跳过校验：%v", err)
	}
}
