package bundle

// 配置包：把设置、rclone 配置与挂载记录打包为单个 zip，用于换机迁移；
// 导入时逐项写回并在覆盖前保留 .bak 备份。

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"strings"
)

// Entry 描述配置包中的一个成员：包内文件名与目标磁盘路径；
// Path 为空表示该成员当前不存在（如从未挂载过时没有 mounts.txt），打包时跳过。
type Entry struct {
	Name string
	Path string
}

// Export 把 entries 写入 zipPath。
func Export(zipPath string, entries []Entry) error {
	out, err := os.Create(zipPath)
	if err != nil {
		return err
	}
	defer out.Close()
	w := zip.NewWriter(out)
	for _, entry := range entries {
		if entry.Path == "" {
			continue
		}
		data, err := os.ReadFile(entry.Path)
		if err != nil {
			_ = w.Close()
			return fmt.Errorf("读取 %s 失败：%w", entry.Name, err)
		}
		f, err := w.Create(entry.Name)
		if err != nil {
			_ = w.Close()
			return err
		}
		if _, err := f.Write(data); err != nil {
			_ = w.Close()
			return err
		}
	}
	return w.Close()
}

// Import 解包 zipPath 并把成员写回各自目标路径；返回写回的成员名列表。
func Import(zipPath string, entries []Entry) ([]string, error) {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	byName := make(map[string]Entry, len(entries))
	for _, entry := range entries {
		byName[strings.ToLower(entry.Name)] = entry
	}
	var restored []string
	for _, f := range r.File {
		entry, ok := byName[strings.ToLower(f.Name)]
		if !ok || entry.Path == "" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return restored, err
		}
		data, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			return restored, err
		}
		if err := backupAndWrite(entry.Path, data); err != nil {
			return restored, err
		}
		restored = append(restored, entry.Name)
	}
	if len(restored) == 0 {
		return nil, fmt.Errorf("配置包中没有可识别的成员文件")
	}
	return restored, nil
}

// backupAndWrite 覆盖目标文件；目标已存在时先改名为同名 .bak。
func backupAndWrite(path string, data []byte) error {
	if _, err := os.Stat(path); err == nil {
		if err := os.Rename(path, path+".bak"); err != nil {
			return err
		}
	}
	return os.WriteFile(path, data, 0o644)
}
