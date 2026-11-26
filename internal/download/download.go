package download

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"OssManager/internal/config"
)

// Record 是一条下载记录，用于回看历史下载位置。
type Record struct {
	Time      string `json:"time"`
	Remote    string `json:"remote"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	LocalPath string `json:"localPath"`
	Size      int64  `json:"size"`
}

const maxRecords = 500

var mu sync.Mutex

func historyPath() string {
	return filepath.Join(config.DataDir(), "downloads.json")
}

func readLocked() []Record {
	data, err := os.ReadFile(historyPath())
	if err != nil {
		return nil
	}
	var records []Record
	if json.Unmarshal(data, &records) != nil {
		return nil
	}
	return records
}

func saveLocked(records []Record) {
	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return
	}
	path := historyPath()
	tmp := path + ".tmp"
	if os.WriteFile(tmp, data, 0o644) != nil {
		return
	}
	_ = os.Rename(tmp, path)
}

// Read 读取下载记录，最新的在前。
func Read() []Record {
	mu.Lock()
	defer mu.Unlock()
	return readLocked()
}

// Add 追加一条下载记录。
func Add(remotePath, localPath string, size int64) {
	mu.Lock()
	defer mu.Unlock()
	records := readLocked()
	record := Record{
		Time:      time.Now().Format("2006-01-02 15:04:05"),
		Path:      remotePath,
		LocalPath: localPath,
		Size:      size,
	}
	if colon := strings.Index(remotePath, ":"); colon > 0 {
		record.Remote = remotePath[:colon]
	}
	record.Name = remotePath
	if slash := strings.LastIndex(strings.ReplaceAll(remotePath, "\\", "/"), "/"); slash >= 0 {
		record.Name = remotePath[slash+1:]
	}
	records = append([]Record{record}, records...)
	if len(records) > maxRecords {
		records = records[:maxRecords]
	}
	saveLocked(records)
}

// RemoveByLocal 删除所有指向该本地路径的记录，返回删除条数。
func RemoveByLocal(localPath string) int {
	mu.Lock()
	defer mu.Unlock()
	records := readLocked()
	kept := make([]Record, 0, len(records))
	removed := 0
	for _, record := range records {
		if record.LocalPath == localPath {
			removed++
			continue
		}
		kept = append(kept, record)
	}
	if removed > 0 {
		saveLocked(kept)
	}
	return removed
}

// Clear 清空下载记录。
func Clear() error {
	mu.Lock()
	defer mu.Unlock()
	err := os.Remove(historyPath())
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
