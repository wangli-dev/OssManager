package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Settings 是程序级设置；字段与 C# 版本保持兼容，便于从旧版本迁移。
type Settings struct {
	RcloneConfig           string   `json:"rcloneConfig"`
	FileManager            string   `json:"fileManager"`
	Theme                  string   `json:"theme"`
	CacheDirectory         string   `json:"cacheDirectory"`
	DirCacheTime           string   `json:"dirCacheTime"`
	VfsCacheMaxSize        string   `json:"vfsCacheMaxSize"`
	VfsCacheMaxAge         string   `json:"vfsCacheMaxAge"`
	BufferSize             string   `json:"bufferSize"`
	MaxConcurrentTransfers int      `json:"maxConcurrentTransfers"`
	DownloadStreams        int      `json:"downloadStreams"`
	DownloadDirectory      string   `json:"downloadDirectory"`
	DragMode               string   `json:"dragMode"`
	AutoSizeEnabled        bool     `json:"autoSizeEnabled"`
	AutoSizeDelay          int      `json:"autoSizeDelay"`
	AutoSizeInterval       int      `json:"autoSizeInterval"`
	ServerModtimeRemotes   []string `json:"serverModtimeRemotes"`
}

// Connection 是 rclone.conf 中一个连接的公开信息，不含密钥。
type Connection struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Type        string `json:"type"`
	Endpoint    string `json:"endpoint"`
}

// DataDir 返回本程序的用户数据目录。
func DataDir() string {
	if exe, err := os.Executable(); err == nil {
		return filepath.Dir(exe)
	}
	if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
		return filepath.Join(dir, "OssManager")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".oss-manager")
}

// SettingsPath 返回设置文件路径。
func SettingsPath() string {
	return filepath.Join(DataDir(), "settings.json")
}

// LoadSettings 读取设置；首次启动时尝试从 C# 版本迁移 rclone 配置路径。
func LoadSettings() Settings {
	value := Settings{Theme: "light", AutoSizeEnabled: true, AutoSizeDelay: 5, AutoSizeInterval: 2}
	if data, err := os.ReadFile(SettingsPath()); err == nil {
		_ = json.Unmarshal(data, &value)
	} else if old := legacySettingsPath(); old != "" {
		if data, err := os.ReadFile(old); err == nil {
			var modern Settings
			if json.Unmarshal(data, &modern) == nil && strings.TrimSpace(modern.RcloneConfig) != "" {
				// 旧 Go 版本使用小驼峰字段，直接按新结构读取。
				value = modern
			} else {
				var legacy struct {
					RcloneConfiguration   string   `json:"RcloneConfiguration"`
					FileManagerExecutable string   `json:"FileManagerExecutable"`
					Theme                 string   `json:"Theme"`
					CacheDirectory        string   `json:"CacheDirectory"`
					DirCacheTime          string   `json:"DirCacheTime"`
					VfsCacheMaxSize       string   `json:"VfsCacheMaxSize"`
					VfsCacheMaxAge        string   `json:"VfsCacheMaxAge"`
					BufferSize            string   `json:"BufferSize"`
					ServerModtimeRemotes  []string `json:"ServerModtimeRemotes"`
				}
				if json.Unmarshal(data, &legacy) == nil {
					value.RcloneConfig = legacy.RcloneConfiguration
					value.FileManager = legacy.FileManagerExecutable
					if legacy.Theme != "" {
						value.Theme = legacy.Theme
					}
					value.DirCacheTime = legacy.DirCacheTime
					value.VfsCacheMaxSize = legacy.VfsCacheMaxSize
					value.VfsCacheMaxAge = legacy.VfsCacheMaxAge
					value.BufferSize = legacy.BufferSize
					value.ServerModtimeRemotes = legacy.ServerModtimeRemotes
				}
			}
		}
	}
	if strings.TrimSpace(value.RcloneConfig) == "" {
		value.RcloneConfig = defaultRcloneConfig()
	}
	if value.Theme != "dark" {
		value.Theme = "light"
	}
	if strings.TrimSpace(value.CacheDirectory) == "" {
		value.CacheDirectory = executableDir()
	}
	if value.MaxConcurrentTransfers <= 0 {
		value.MaxConcurrentTransfers = 4
	}
	if value.DownloadStreams <= 0 {
		value.DownloadStreams = 4
	}
	if value.DownloadStreams > 16 {
		value.DownloadStreams = 16
	}
	if strings.TrimSpace(value.DirCacheTime) == "" {
		value.DirCacheTime = "12h"
	}
	if strings.TrimSpace(value.VfsCacheMaxSize) == "" {
		value.VfsCacheMaxSize = "10G"
	}
	if strings.TrimSpace(value.VfsCacheMaxAge) == "" {
		value.VfsCacheMaxAge = "24h"
	}
	if strings.TrimSpace(value.BufferSize) == "" {
		value.BufferSize = "64M"
	}
	if value.DragMode != "shell" {
		value.DragMode = "panes"
	}
	if value.AutoSizeDelay < 0 {
		value.AutoSizeDelay = 0
	}
	if value.AutoSizeInterval < 0 {
		value.AutoSizeInterval = 0
	}
	// 数据目录没有设置文件时立即落盘一份，保证配置文件固定与 exe 同目录。
	if _, err := os.Stat(SettingsPath()); err != nil {
		_ = SaveSettings(value)
	}
	return value
}

// executableDir 返回当前程序所在目录，作为默认缓存目录。
func executableDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Dir(exe)
}

// SaveSettings 原子保存设置。
func SaveSettings(value Settings) error {
	if err := os.MkdirAll(DataDir(), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	tmp := SettingsPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, SettingsPath())
}

// ListConnections 解析 rclone.conf，返回按文件顺序排列的连接列表。
func ListConnections(confPath string) ([]Connection, error) {
	data, err := os.ReadFile(confPath)
	if err != nil {
		return nil, err
	}
	var result []Connection
	current := -1
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			name := strings.TrimSpace(line[1 : len(line)-1])
			result = append(result, Connection{Name: name, DisplayName: name})
			current = len(result) - 1
			continue
		}
		if current < 0 {
			continue
		}
		index := strings.Index(line, "=")
		if index <= 0 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(line[:index]))
		val := strings.TrimSpace(line[index+1:])
		switch key {
		case "description":
			if val != "" {
				result[current].DisplayName = val
			}
		case "type":
			result[current].Type = val
		case "provider":
			if result[current].Endpoint == "" {
				result[current].Endpoint = ""
			}
			if strings.EqualFold(val, "minio") {
				result[current].Type = "minio"
			} else if strings.EqualFold(val, "alibaba") {
				result[current].Type = "alibaba"
			}
		case "endpoint", "url", "host":
			if result[current].Endpoint == "" {
				result[current].Endpoint = val
			}
		}
	}
	return result, nil
}

// remoteOptions 返回指定连接的非敏感配置项，供挂载与策略读取使用。
func RemoteOptions(confPath, name string) map[string]string {
	result := map[string]string{}
	data, err := os.ReadFile(confPath)
	if err != nil {
		return result
	}
	section := ""
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.TrimSpace(line[1 : len(line)-1])
			continue
		}
		if section != name {
			continue
		}
		if index := strings.Index(line, "="); index > 0 {
			result[strings.ToLower(strings.TrimSpace(line[:index]))] = strings.TrimSpace(line[index+1:])
		}
	}
	return result
}

func defaultRcloneConfig() string {
	if value := os.Getenv("RCLONE_CONFIG"); value != "" {
		return value
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "AppData", "Roaming", "rclone", "rclone.conf")
}

func legacySettingsPath() string {
	if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
		for _, name := range []string{"OssManager", "RcloneOssManager"} {
			path := filepath.Join(dir, name, "settings.json")
			if _, err := os.Stat(path); err == nil {
				return path
			}
		}
	}
	return ""
}

// legacyFile 返回旧用户数据目录中的指定文件。
func legacyFile(name string) string {
	if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
		for _, folder := range []string{"OssManager", "RcloneOssManager"} {
			path := filepath.Join(dir, folder, name)
			if _, err := os.Stat(path); err == nil {
				return path
			}
		}
	}
	return ""
}

// MountRecord 是一条开机恢复挂载记录。
type MountRecord struct {
	Remote     string
	Drive      string
	VolumeName string
}

// MountRecordPath 返回挂载记录文件路径。
func MountRecordPath() string {
	return filepath.Join(DataDir(), "mounts.txt")
}

// mountRecordSources 返回挂载记录的读取顺序：新文件优先，其次旧版本留下的文件。
func mountRecordSources() []string {
	var result []string
	result = append(result, MountRecordPath(), filepath.Join(DataDir(), "rclone-mounts.txt"))
	for _, name := range []string{"mounts.txt", "rclone-mounts.txt"} {
		if legacy := legacyFile(name); legacy != "" {
			result = append(result, legacy)
		}
	}
	return result
}

// NormalizeRemote 规范化 remote 写法：只写连接名时补尾冒号，带路径的（host:/path）保持原样。
// 早期实现无条件拼冒号，把 host:/ 变成 host:/:，导致挂载到不存在的路径。
func NormalizeRemote(remote string) string {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return ""
	}
	if !strings.Contains(remote, ":") {
		return remote + ":"
	}
	return remote
}

// RemoteName 返回 remote 的连接名部分（冒号之前）。
func RemoteName(remote string) string {
	remote = strings.TrimSpace(remote)
	if index := strings.Index(remote, ":"); index >= 0 {
		return remote[:index]
	}
	return remote
}

// ReadMountRecords 按 remote 合并读取挂载记录，兼容旧版两段与三段格式。
func ReadMountRecords() []MountRecord {
	var records []MountRecord
	seen := map[string]bool{}
	for _, path := range mountRecordSources() {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
			if line == "" {
				continue
			}
			parts := strings.Split(line, "|")
			if len(parts) < 2 {
				continue
			}
			// 保留记录里的路径部分，只在缺冒号时补齐。
			remote := NormalizeRemote(parts[0])
			drive := strings.TrimSpace(parts[1])
			if RemoteName(remote) == "" || !isDriveLetter(drive) {
				continue
			}
			// 同一连接的不同路径是不同挂载，去重键必须用完整 remote。
			key := strings.ToLower(remote)
			if seen[key] {
				continue
			}
			seen[key] = true
			// 卷标留空时由调用方按连接显示名填充，不再退化成内部连接名。
			volume := ""
			if len(parts) >= 3 && strings.TrimSpace(parts[2]) != "" {
				volume = strings.TrimSpace(parts[2])
			}
			records = append(records, MountRecord{Remote: remote, Drive: strings.ToUpper(drive), VolumeName: volume})
		}
	}
	return records
}

// RemoveMountRecords 删除指定连接（含其所有路径）的挂载记录，返回是否发生改动。
func RemoveMountRecords(name string) bool {
	target := strings.ToLower(RemoteName(NormalizeRemote(name)))
	records := ReadMountRecords()
	kept := make([]MountRecord, 0, len(records))
	for _, record := range records {
		if strings.ToLower(RemoteName(record.Remote)) == target {
			continue
		}
		kept = append(kept, record)
	}
	if len(kept) == len(records) {
		return false
	}
	_ = WriteMountRecords(kept)
	return true
}

// RenameMountRecords 把记录里的连接名改成新名，保留路径与卷标，返回是否发生改动。
func RenameMountRecords(oldName, newName string) bool {
	oldTarget := strings.ToLower(RemoteName(NormalizeRemote(oldName)))
	nextName := RemoteName(NormalizeRemote(newName))
	if oldTarget == "" || nextName == "" {
		return false
	}
	records := ReadMountRecords()
	changed := false
	for index := range records {
		current := records[index].Remote
		colon := strings.Index(current, ":")
		if colon < 0 || strings.ToLower(current[:colon]) != oldTarget {
			continue
		}
		// 冒号后的部分（空或 /path）保持不变。
		records[index].Remote = nextName + current[colon:]
		changed = true
	}
	if changed {
		_ = WriteMountRecords(records)
	}
	return changed
}

// isDriveLetter 判断形如 D: 的盘符。
func isDriveLetter(value string) bool {
	if len(value) != 2 || value[1] != ':' {
		return false
	}
	c := value[0]
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
}

// WriteMountRecords 保存挂载记录，统一写三段格式以保留挂载名称。
func WriteMountRecords(records []MountRecord) error {
	var builder strings.Builder
	for _, record := range records {
		volume := record.VolumeName
		line := record.Remote + "|" + record.Drive
		// 卷标留空时只写两段，保持“未指定”语义，让恢复时能重新按显示名取名。
		if volume != "" {
			line += "|" + volume
		}
		builder.WriteString(line + "\n")
	}
	if err := os.WriteFile(MountRecordPath(), []byte(builder.String()), 0o644); err != nil {
		return err
	}
	// 新文件写入成功后移除旧版本记录，避免删除后又被旧文件读回来。
	_ = os.Remove(filepath.Join(DataDir(), "rclone-mounts.txt"))
	for _, name := range []string{"OssManager", "RcloneOssManager"} {
		if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
			_ = os.Remove(filepath.Join(dir, name, "rclone-mounts.txt"))
		}
	}
	return nil
}

// OrderPath 返回连接排序文件路径。
func OrderPath() string {
	return filepath.Join(DataDir(), "connection-order.txt")
}

// ReadOrder 读取连接排序；新目录没有时回退读取旧用户目录。
func ReadOrder() []string {
	path := OrderPath()
	if _, err := os.Stat(path); err != nil {
		if legacy := legacyFile("connection-order.txt"); legacy != "" {
			path = legacy
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var result []string
	for _, line := range strings.Split(string(data), "\n") {
		if value := strings.TrimSpace(line); value != "" {
			result = append(result, value)
		}
	}
	return result
}

// WriteOrder 保存连接排序。
func WriteOrder(names []string) error {
	var builder strings.Builder
	for _, name := range names {
		builder.WriteString(name + "\n")
	}
	return os.WriteFile(OrderPath(), []byte(builder.String()), 0o644)
}

// ApplyOrder 按保存的顺序排列连接，未记录的连接保持原相对顺序。
func ApplyOrder(connections []Connection, order []string) []Connection {
	if len(order) == 0 {
		return connections
	}
	remaining := make([]Connection, len(connections))
	copy(remaining, connections)
	var result []Connection
	for _, name := range order {
		for i, connection := range remaining {
			if strings.EqualFold(connection.Name, name) {
				result = append(result, connection)
				remaining = append(remaining[:i], remaining[i+1:]...)
				break
			}
		}
	}
	result = append(result, remaining...)
	return result
}
