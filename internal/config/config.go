package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Settings 是程序级设置；字段与 C# 版本保持兼容，便于从旧版本迁移。
type Settings struct {
	RcloneConfig         string   `json:"rcloneConfig"`
	FileManager          string   `json:"fileManager"`
	Theme                string   `json:"theme"`
	CacheDirectory       string   `json:"cacheDirectory"`
	DirCacheTime         string   `json:"dirCacheTime"`
	VfsCacheMaxSize      string   `json:"vfsCacheMaxSize"`
	VfsCacheMaxAge       string   `json:"vfsCacheMaxAge"`
	BufferSize           string   `json:"bufferSize"`
	MaxConcurrentTransfers int    `json:"maxConcurrentTransfers"`
	ServerModtimeRemotes []string `json:"serverModtimeRemotes"`
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
	value := Settings{Theme: "light"}
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
	Remote string
	Drive  string
}

// MountRecordPath 返回挂载记录文件路径。
func MountRecordPath() string {
	return filepath.Join(DataDir(), "mounts.txt")
}

// ReadMountRecords 读取挂载记录；新目录没有时回退读取旧用户目录，便于迁移。
func ReadMountRecords() []MountRecord {
	path := MountRecordPath()
	if _, err := os.Stat(path); err != nil {
		if legacy := legacyFile("mounts.txt"); legacy != "" {
			path = legacy
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var records []MountRecord
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 2)
		if len(parts) != 2 {
			continue
		}
		records = append(records, MountRecord{Remote: parts[0], Drive: parts[1]})
	}
	return records
}

// WriteMountRecords 保存挂载记录。
func WriteMountRecords(records []MountRecord) error {
	var builder strings.Builder
	for _, record := range records {
		builder.WriteString(record.Remote + "|" + record.Drive + "\n")
	}
	return os.WriteFile(MountRecordPath(), []byte(builder.String()), 0o644)
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
