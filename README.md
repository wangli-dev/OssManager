# OssManager

基于 Go + [Wails](https://wails.io/) 与内置对象存储内核（[rclone](https://rclone.org/) 库）的 Windows OSS / S3 / MinIO 连接管理器。

用桌面界面管理对象存储连接，把连接挂载成本地盘符，并浏览、下载、上传、导入导出连接，无需命令行工具。

## 功能

- 连接管理：左上角「新建连接」「新建共享」、编辑、删除、测试；名称用于界面显示，连接标识保持不变；新建/编辑时可先「测试连接」验证参数，密钥支持显示/隐藏
- 连接列表：此电脑与已映射网络共享和 OSS 连接统一显示；单击选中、双击打开，避免误触；支持收起（收起后顶部显示连接下拉与展开按钮）、拖拽排序；网络共享可改盘符、名称或断开映射
- 目录收藏：路径栏星标一键收藏当前目录，收藏项显示在连接栏底部，可点击直达或右键移除；目录树节点也可右键收藏
- 多页签：远程连接、此电脑与网络共享都以页签打开，各自保留路径与列表状态；页签可拖动排序，切换页签会回到之前的目录
- 桶与文件浏览：双击进入目录；关键字筛选、点表头排序、名称列宽拖动、横向滚动；复选框多选、Shift 连选，删除前弹窗确认
- 目录树：路径栏左侧按钮展开目录树，按需加载子目录，点击节点直接跳转；目录树与文件列表无缝贴合；此电脑默认打开用户目录
- 路径栏：面包屑层级过多时省略中间部分（点「…」可展开）；点击地址栏直接进入编辑并全选，右键可复制地址
- 目录占用：顶部「统计占用」一键开关自动统计，延迟与间隔可在设置中配置（默认关闭）
- 盘符挂载：基于内置挂载引擎与 WinFsp；新建/编辑连接时可选择盘符与磁盘名称，填写即自动挂载；首次挂载后自动记录，启动时恢复
- 传输：多选上传、多选下载；「复制到」统一选择目标连接与目录（已打开页签默认当前目录，未打开连接默认根目录），支持远程↔远程、远程↔此电脑；支持单文件多线程分片下载（线程数可配置）
- 传输速度：顶部实时显示上传/下载速度
- 传输记录：常驻顶部入口、固定高度、右上角可关闭；可一键在对应连接中打开并定位到文件
- 拖拽：在应用内拖到其他页签或此电脑完成复制/上传，也可拖到资源管理器复制落盘（设置中切换）
- 在线预览：图片、文本、PDF 与音视频在应用内打开，较大的文件可回退到系统程序
- 自动更新：启动后自动检查并在后台下载新版本，右上角出现「重启安装」按钮，确认后自动替换并重启
- 权限：读取与编辑 Bucket Policy，显示 ACL 摘要
- 迁移：连接信息 JSON 导入导出（可选包含账号与密钥）；设置、连接配置与挂载记录的配置包导出导入
- 阿里云 OSS：自动识别 bucket 实际地域并切换端点，跨地域桶也能打开
- 界面：明暗双主题、顶部运行入口、右键菜单分组、斑马纹列表、状态栏信息、运行日志查看
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

设置固定保存在程序所在目录的 `settings.json`（与 exe 同目录），首次启动会尝试从旧版 `RcloneOssManager` 迁移配置路径；已有的 `rclone.conf` 会自动复制为程序目录下的 `ossManage.conf`。主要字段：

- `rcloneConfig`：连接配置文件路径（默认 `ossManage.conf`，与 exe 同目录）
- `fileManager`：打开目录使用的文件管理器，留空自动探测 Pulse / Directory Opus
- `theme`：`light` 或 `dark`
- `cacheDirectory`、`dirCacheTime`、`vfsCacheMaxSize`、`vfsCacheMaxAge`、`bufferSize`：挂载缓存参数
- `maxConcurrentTransfers`：并发传输文件数；`downloadStreams`：单文件分片下载线程数（1 为不分片）
- `downloadDirectory`：默认下载目录；`dragMode`：`panes`（在应用内拖到页签/此电脑）或 `shell`（拖到资源管理器）
- `autoSizeEnabled`、`autoSizeDelay`、`autoSizeInterval`：目录占用自动统计的开关、延迟与间隔
- `autoUpdate`：启动后自动检查更新并在后台下载（默认开启）；关闭后仍可在设置里手动检查

## 分发方式

当前按绿色便携版分发：单个 `OssManager.exe` 放在任意可写目录即可运行，设置、`ossManage.conf`、缓存与更新文件都写在该目录。自动更新依赖替换同目录的 exe，因此不建议放进需要管理员权限的 `Program Files`。如需开始菜单快捷方式与卸载项，可后续再提供 Inno Setup 安装包，安装到用户目录（`%LOCALAPPDATA%\Programs`）即可与自动更新共存。


## 目录结构

```
app.go                 Wails 绑定的后端接口
internal/config        设置、连接配置文件解析、挂载记录与排序
internal/remote        连接增删改
internal/rclonefs      列桶与目录（内置内核）
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
