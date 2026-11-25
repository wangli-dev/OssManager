# OssManager

基于 Go + [Wails](https://wails.io/) + [rclone](https://rclone.org/) 库的 Windows OSS / S3 / MinIO 连接管理器。

用桌面界面管理 rclone 连接，把对象存储挂载成本地盘符，并浏览、下载、上传、导入导出连接，无需记忆命令行。

## 功能

- 连接管理：新增、编辑、删除、改名、测试，直接读写 rclone.conf
- 桶与文件浏览：双击进入目录，右键下载或编辑桶策略
- 盘符挂载：基于 rclone 库与 WinFsp，挂载成本地盘符；首次挂载后自动记录，启动时恢复
- 传输：上传文件、下载文件；支持 Ctrl+C 复制远程文件到系统剪贴板、Ctrl+V 上传剪贴板文件
- 权限：读取与编辑 Bucket Policy，显示 ACL 摘要
- 迁移：连接信息 JSON 导入导出（可选包含账号与密钥）
- 连接排序：拖拽调整顺序并保存
- 界面：明暗双主题、状态提示、运行日志查看
- 单实例：重复启动会提示

## 环境要求

- Windows 10 / 11（64 位）
- Go 1.22+
- Node.js 18+（构建前端）
- Wails CLI：`go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- CGO 编译器（MinGW-w64 gcc）
- WinFsp 运行时，挂载还需要 WinFsp SDK（`inc/fuse`、`lib/winfsp-x64.lib`）

## 构建

```cmd
cd frontend
npm install
npm run build

set CGO_ENABLED=1
set CC=gcc
set CGO_CFLAGS=-I<winfsp-sdk>\inc\fuse
set CGO_LDFLAGS=-L<winfsp-sdk>\lib
wails build -s -tags cmount -platform windows/amd64
```

产物在 `build\bin\OssManager.exe`。

## 开发自检

```cmd
OssManager.exe --autotest
```

不使用界面，直接验证连接列表、浏览、策略读取、挂载与卸载，结果写入 `%LOCALAPPDATA%\OssManager\go.log`。

## 配置

设置保存在 `%LOCALAPPDATA%\OssManager\settings.json`，首次启动会尝试从旧版 `RcloneOssManager` 迁移 rclone 配置路径。主要字段：

- `rcloneConfig`：rclone.conf 路径
- `fileManager`：打开目录使用的文件管理器，留空自动探测 Pulse / Directory Opus
- `theme`：`light` 或 `dark`
- `cacheDirectory`、`dirCacheTime`、`vfsCacheMaxSize`、`vfsCacheMaxAge`、`bufferSize`：挂载缓存参数

## 目录结构

```
app.go                 Wails 绑定的后端接口
internal/config        设置、rclone.conf 解析、挂载记录与排序
internal/remote        连接增删改
internal/rclonefs      列桶与目录（rclone 库）
internal/mount         挂载与卸载（cgofuse + WinFsp）
internal/transfer      上传与下载
internal/policy        Bucket Policy 与 ACL
internal/clipboard     系统剪贴板文件复制与读取
internal/connjson      JSON 导入导出
internal/filemanager   Pulse / Directory Opus 集成
internal/singleinstance 单实例
frontend               Wails 前端（Vite + 原生 JS）
```

## 许可

[MIT](LICENSE)。rclone 同样遵循 MIT License。
