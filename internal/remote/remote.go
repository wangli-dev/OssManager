package remote

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
)

// Definition 是新增或编辑连接时提交的字段。
type Definition struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Type        string `json:"type"`
	Endpoint    string `json:"endpoint"`
	Account     string `json:"account"`
	Secret      string `json:"secret"`
	Region      string `json:"region"`
}

type section struct {
	name  string
	pairs map[string]string
	order []string
}

func parse(data string) []*section {
	var result []*section
	var current *section
	for _, raw := range strings.Split(data, "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			current = &section{name: strings.TrimSpace(line[1 : len(line)-1]), pairs: map[string]string{}}
			result = append(result, current)
			continue
		}
		if current == nil {
			continue
		}
		if index := strings.Index(line, "="); index > 0 {
			key := strings.TrimSpace(line[:index])
			value := strings.TrimSpace(line[index+1:])
			if _, ok := current.pairs[key]; !ok {
				current.order = append(current.order, key)
			}
			current.pairs[key] = value
		}
	}
	return result
}

func render(sections []*section) string {
	var builder strings.Builder
	for _, item := range sections {
		builder.WriteString("[" + item.name + "]\n")
		for _, key := range item.order {
			builder.WriteString(key + " = " + item.pairs[key] + "\n")
		}
		builder.WriteString("\n")
	}
	return builder.String()
}

func indexOf(sections []*section, name string) int {
	for i, item := range sections {
		if strings.EqualFold(item.name, name) {
			return i
		}
	}
	return -1
}

func isS3(kind string) bool {
	kind = strings.ToLower(kind)
	return kind == "s3" || kind == "minio" || kind == "alibaba" || strings.Contains(kind, "s3 兼容") || strings.Contains(kind, "阿里云")
}

func isAlibaba(kind string) bool {
	kind = strings.ToLower(kind)
	return kind == "alibaba" || strings.Contains(kind, "阿里云")
}

func isMinio(kind string) bool {
	kind = strings.ToLower(kind)
	return kind == "minio" || strings.Contains(kind, "minio")
}

func apply(section *section, def Definition) {
	set := func(key, value string) {
		if _, ok := section.pairs[key]; !ok {
			section.order = append(section.order, key)
		}
		section.pairs[key] = value
	}
	switch {
	case isS3(def.Type):
		set("type", "s3")
		provider := "Other"
		if isMinio(def.Type) {
			provider = "Minio"
		} else if isAlibaba(def.Type) {
			provider = "Alibaba"
		} else if existing := section.pairs["provider"]; existing != "" {
			provider = existing
		}
		set("provider", provider)
		set("env_auth", "false")
		set("endpoint", def.Endpoint)
		set("access_key_id", def.Account)
		if def.Secret != "" {
			set("secret_access_key", def.Secret)
		}
		set("region", def.Region)
	case strings.EqualFold(def.Type, "webdav"):
		set("type", "webdav")
		set("url", def.Endpoint)
		set("user", def.Account)
		set("vendor", "other")
		if def.Secret != "" {
			set("pass", def.Secret)
		}
	case strings.EqualFold(def.Type, "ftp"):
		set("type", "ftp")
		set("host", def.Endpoint)
		set("user", def.Account)
		if def.Secret != "" {
			set("pass", def.Secret)
		}
	default:
		set("type", "sftp")
		set("host", def.Endpoint)
		set("user", def.Account)
		if def.Secret != "" {
			set("pass", def.Secret)
		}
	}
	if def.DisplayName != "" {
		set("description", def.DisplayName)
	}
}

func writeAtomic(path, content string) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Save 新增或更新连接；更新时保留未识别的字段。
func Save(confPath string, def Definition, exists bool) error {
	if strings.TrimSpace(def.Name) == "" || strings.TrimSpace(def.Endpoint) == "" || strings.TrimSpace(def.Account) == "" {
		return errors.New("名称、端点和账号不能为空")
	}
	data, _ := os.ReadFile(confPath)
	sections := parse(string(data))
	index := indexOf(sections, def.Name)
	if exists && index < 0 {
		return errors.New("连接不存在，请刷新列表")
	}
	if !exists && index >= 0 {
		return errors.New("连接名称已存在")
	}
	if !exists && strings.TrimSpace(def.Secret) == "" {
		return errors.New("新增连接必须填写密钥")
	}
	var target *section
	if index >= 0 {
		target = sections[index]
	} else {
		target = &section{name: def.Name, pairs: map[string]string{}}
		sections = append(sections, target)
	}
	apply(target, def)
	return writeAtomic(confPath, render(sections))
}

// Delete 删除连接。
func Delete(confPath, name string) error {
	data, _ := os.ReadFile(confPath)
	sections := parse(string(data))
	index := indexOf(sections, name)
	if index < 0 {
		return errors.New("连接不存在")
	}
	sections = append(sections[:index], sections[index+1:]...)
	return writeAtomic(confPath, render(sections))
}

// Rename 修改内部连接名；显示名保持不变。
func Rename(confPath, oldName, newName string) error {
	if strings.TrimSpace(newName) == "" || strings.ContainsAny(newName, "[] ") {
		return errors.New("新名称不能为空，也不能包含空格或方括号")
	}
	data, _ := os.ReadFile(confPath)
	sections := parse(string(data))
	index := indexOf(sections, oldName)
	if index < 0 {
		return errors.New("连接不存在")
	}
	if indexOf(sections, newName) >= 0 {
		return errors.New("新名称已存在")
	}
	sections[index].name = newName
	return writeAtomic(confPath, render(sections))
}

// Names 返回配置文件中的连接名，用于校验。
func Names(confPath string) []string {
	data, _ := os.ReadFile(confPath)
	sections := parse(string(data))
	result := make([]string, 0, len(sections))
	for _, item := range sections {
		result = append(result, item.name)
	}
	sort.Strings(result)
	return result
}

// Describe 返回用于错误提示的描述。
func Describe(name string) string {
	return fmt.Sprintf("连接 %s", name)
}
