package connjson

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"

	"OssManager/internal/config"
	"OssManager/internal/remote"
)

// Entry 是一条连接的可迁移信息。
type Entry struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Type        string `json:"type"`
	Endpoint    string `json:"endpoint"`
	Region      string `json:"region"`
	Account     string `json:"account,omitempty"`
	Secret      string `json:"secret,omitempty"`
}

// Document 是导出文件的根结构。
type Document struct {
	Version     int     `json:"version"`
	ExportedAt  string  `json:"exportedAt"`
	Connections []Entry `json:"connections"`
}

func first(values map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := values[key]; value != "" {
			return value
		}
	}
	return ""
}

// Export 生成连接信息 JSON；includeSecrets 决定是否附带账号与密钥原值。
func Export(confPath string, includeSecrets bool) (string, error) {
	connections, err := config.ListConnections(confPath)
	if err != nil {
		return "", err
	}
	document := Document{Version: 1, ExportedAt: time.Now().Format("2006-01-02 15:04:05")}
	for _, connection := range connections {
		options := config.RemoteOptions(confPath, connection.Name)
		entry := Entry{
			Name:        connection.Name,
			DisplayName: connection.DisplayName,
			Type:        connection.Type,
			Endpoint:    first(options, "endpoint", "url", "host"),
			Region:      first(options, "region"),
		}
		if includeSecrets {
			entry.Account = first(options, "access_key_id", "user")
			entry.Secret = first(options, "secret_access_key", "pass")
		}
		document.Connections = append(document.Connections, entry)
	}
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// Import 按名称新增或更新连接，返回结果说明。
func Import(confPath, path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var document Document
	if err := json.Unmarshal(data, &document); err != nil {
		return "", err
	}
	if len(document.Connections) == 0 {
		return "", errors.New("JSON 中没有连接信息")
	}
	created, updated, skipped := 0, 0, 0
	var problems []string
	for _, entry := range document.Connections {
		if strings.TrimSpace(entry.Name) == "" || strings.TrimSpace(entry.Endpoint) == "" {
			skipped++
			continue
		}
		exists := false
		for _, name := range remote.Names(confPath) {
			if strings.EqualFold(name, entry.Name) {
				exists = true
				break
			}
		}
		definition := remote.Definition{
			Name:        entry.Name,
			DisplayName: entry.DisplayName,
			Type:        entry.Type,
			Endpoint:    entry.Endpoint,
			Region:      entry.Region,
			Account:     entry.Account,
			Secret:      entry.Secret,
		}
		if err := remote.Save(confPath, definition, exists); err != nil {
			problems = append(problems, entry.Name+"："+err.Error())
			skipped++
			continue
		}
		if exists {
			updated++
		} else {
			created++
		}
	}
	message := "导入完成：新增 " + itoa(created) + " 个，更新 " + itoa(updated) + " 个，跳过 " + itoa(skipped) + " 个。"
	if len(problems) > 0 {
		message += " 未导入：" + strings.Join(problems, "；")
	}
	return message, nil
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
