package bundle

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExportImportRoundTrip(t *testing.T) {
	dir := t.TempDir()
	fixtures := map[string]string{
		"settings.json": `{"rcloneConfig":"C:\x\rclone.conf","theme":"dark"}`,
		"rclone.conf":   "[minio-163]\ntype = s3\naccess_key_id = admin",
		"mounts.txt":    "minio-163|M:\n",
	}
	var entries []Entry
	for name, body := range fixtures {
		p := filepath.Join(dir, "src", name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		entries = append(entries, Entry{Name: name, Path: p})
	}
	zipPath := filepath.Join(dir, "bundle.zip")
	if err := Export(zipPath, entries); err != nil {
		t.Fatalf("export: %v", err)
	}
	// 导入到另一组目标文件，其中一个已存在（验证 .bak 备份）
	dest := map[string]string{"settings.json": filepath.Join(dir, "dst1.json"), "rclone.conf": filepath.Join(dir, "dst2.conf"), "mounts.txt": filepath.Join(dir, "dst3.txt")}
	var imports []Entry
	for name, p := range dest {
		if name == "rclone.conf" {
			if err := os.WriteFile(p, []byte("old-content"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		imports = append(imports, Entry{Name: name, Path: p})
	}
	restored, err := Import(zipPath, imports)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(restored) != 3 {
		t.Fatalf("restored = %v, want 3 items", restored)
	}
	for name, p := range dest {
		got, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != fixtures[name] {
			t.Fatalf("%s content mismatch", name)
		}
	}
	if _, err := os.ReadFile(dest["rclone.conf"] + ".bak"); err != nil {
		t.Fatalf("missing .bak backup: %v", err)
	}
}

func TestImportRejectsForeignZip(t *testing.T) {
	dir := t.TempDir()
	other := filepath.Join(dir, "other.txt")
	zipPath := filepath.Join(dir, "foreign.zip")
	if err := os.WriteFile(other, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Export(zipPath, []Entry{{Name: "other.txt", Path: other}}); err != nil {
		t.Fatal(err)
	}
	if _, err := Import(zipPath, []Entry{{Name: "settings.json", Path: filepath.Join(dir, "s.json")}}); err == nil {
		t.Fatal("expected error for zip without known members")
	}
}
