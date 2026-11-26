# OssManager

基于 Go + [Wails](https://wails.io/) + [rclone](https://rclone.org/) 库的 Windows OSS / S3 / MinIO 连接管理器。

用桌面界面管理 rclone 连接，把对象存储挂载成本地盘符，并浏览、下载、上传、导入导出连接，无需记忆命令行。

## 功能

- 连接管理：新增、编辑、删除、改名、测试；新建/编辑时可先「测试连接」验证参数，密钥支持显示/隐藏
- 连接列表：本地文件与已映射网络共享与 OSS 连接统一显示；支持收起、悬浮选择、拖拽排序
- 多页签：远程连接、本地目录与网络共享都以页签打开，各自保留路径与列表状态
- 桶与文件浏览：双击进入目录，支持关键字筛选、点表头排序、名称列宽拖动、横向滚动
- 目录大小：可在文件列表页一键开关自动统计，延迟与目录间隔可在设置中配置（默认关闭）
- 盘符挂载：基于 rclone 库与 WinFsp，挂载成本地盘符；首次挂载后自动记录，启动时恢复
- 传输：上传文件、下载文件、下载到本地栏；支持单文件多线程分片下载（线程数可配置）
- 拖拽：可拖到本地栏做页内传输，或拖到资源管理器复制落盘（设置中切换）
- 权限：读取与编辑 Bucket Policy，显示 ACL 摘要
- 迁移：连接信息 JSON 导入导出（可选包含账号与密钥）；设置、rclone 配置与挂载记录的配置包导出导入
- 阿里云 OSS：自动识别 bucket 实际地域并切换端点，跨地域桶也能打开
- 界面：明暗双主题、工具栏分组、右键菜单分组、状态提示、运行日志查看
- 单实例：重复启动会激活已有窗口

## 环境要求

- Windows 10 / 11（64 位）
- Go 1.26+
- Node.js 18+（构建前端）
- Wails CLI：`go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1`
- CGO 编译器（MinGW-w64 gcc）
- WinFsp 运行时，挂载还需要 WinFsp SDK（`inc/fuse`、`lib/winfsp-x64.lib`）

## 构建

```cmd
cd frontend
npm install
npm run build

set CGO_ENABLED=1
set CGO_CFLAGS=-I<winfsp-sdk>\inc\fuse
set CGO_LDFLAGS=-L<winfsp-sdk>\lib -lwinfsp-x64
wails build -m -skipbindings -tags cmount -platform windows/amd64 -o OssManager.exe
```

产物在 `build\bin\OssManager.exe`。`-m` 跳过 `go mod tidy`，`-skipbindings` 使用仓库内已提交的前端绑定；运行时绑定由 Wails 反射生成。

## 自动构建与发布

`.github/workflows/build.yml` 在 Windows runner 上自动完成依赖安装、WinFsp SDK 解包、CGO 构建与产物上传：

- 手动触发：Actions → 构建与发布 → Run workflow
- 发布：推送 `v*` 标签会自动创建 Release 并附带 `OssManager.exe`


## 开发自检

```cmd
OssManager.exe --autotest
```

不使用界面，直接验证连接列表、浏览、策略读取、挂载与卸载，结果写入程序目录下的 `go.log`。

## 配置

设置固定保存在程序所在目录的 `settings.json`（与 exe 同目录），首次启动会尝试从旧版 `RcloneOssManager` 迁移 rclone 配置路径。主要字段：

- `rcloneConfig`：rclone.conf 路径
- `fileManager`：打开目录使用的文件管理器，留空自动探测 Pulse / Directory Opus
- `theme`：`light` 或 `dark`
- `cacheDirectory`、`dirCacheTime`、`vfsCacheMaxSize`、`vfsCacheMaxAge`、`bufferSize`：挂载缓存参数
- `maxConcurrentTransfers`：并发传输文件数；`downloadStreams`：单文件分片下载线程数（1 为不分片）
- `downloadDirectory`：默认下载目录；`dragMode`：`panes`（拖到本地栏）或 `shell`（拖到资源管理器）
- `autoSizeEnabled`、`autoSizeDelay`、`autoSizeInterval`：目录大小自动统计的开关、延迟与间隔


## 目录结构

```
app.go                 Wails 绑定的后端接口
internal/config        设置、rclone.conf 解析、挂载记录与排序
internal/remote        连接增删改
internal/rclonefs      列桶与目录（rclone 库）
internal/rclonefs/region.go 阿里云跨地域 bucket 端点自动切换
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

本项目使用 [MIT](LICENSE) 许可。程序静态链接了 rclone（MIT）等第三方组件，许可均与本项目兼容；分发二进制时请保留 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中的声明。
