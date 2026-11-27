# OssManager 一键构建 + 可选部署脚本（对应 TODO C1/A5）
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\build.ps1            # 只构建+校验
#   powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Deploy    # 构建后备份/覆盖部署 E:\soft\OssManager，备份只留最近 3 份
param(
    [switch]$Deploy
)
$ErrorActionPreference = "Stop"
$root      = Split-Path -Parent $PSScriptRoot
$deployDir = "E:\soft\OssManager"
$exe       = "$root\build\bin\OssManager.exe"

# ---- 1) 前端构建：wails build -s 不会重建 frontend/dist，跳过这步就会把旧界面打进 exe ----
Push-Location "$root\frontend"
if (-not (Test-Path ".\node_modules")) {
    npm ci
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm ci 失败" }
}
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm run build 失败" }
Pop-Location

# 记录本次前端产物名，稍后校验 exe 内嵌的就是它
$distIndex = Get-ChildItem "$root\frontend\dist\assets\index-*.js" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $distIndex) { throw "前端产物缺失：frontend\dist\assets\index-*.js" }

# ---- 2) Go/Wails 构建（CGO + WinFsp SDK，cmount 才支持进程内挂载）----
$env:CGO_ENABLED  = "1"
$env:CC           = "gcc"
$env:CGO_CFLAGS   = "-IE:/soft/winfsp-sdk-2.1.25156/inc/fuse"
$env:CGO_LDFLAGS  = "-LE:/soft/winfsp-sdk-2.1.25156/lib"
Push-Location $root
wails build -s -tags cmount
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "wails build 失败" }
Pop-Location

# ---- 3) 校验 exe 内嵌前端版本 = 刚构建的 index-*.js，防止再次打出旧界面 ----
$text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($exe))
$embedded = [regex]::Matches($text, 'index-[A-Za-z0-9_]+\.js') |
    ForEach-Object { $_.Value } | Select-Object -Unique
if (@($embedded) -notcontains $distIndex.Name) {
    throw ("exe 内嵌前端({0})不是刚构建的 {1}" -f ($embedded -join ','), $distIndex.Name)
}
Write-Host "构建完成：$exe（内嵌前端 $($distIndex.Name)）"

# ---- 4) 可选部署：退出运行中的程序 → 备份 → 覆盖 → 裁剪备份（对应 TODO A5）----
if ($Deploy) {
    Get-Process OssManager -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 800
    if (-not (Test-Path $deployDir)) { throw "部署目录不存在：$deployDir" }
    $stamp = Get-Date -Format "yyyyMMdd-HHmm"
    Copy-Item $exe "$deployDir\OssManager.exe.bak-$stamp"
    Copy-Item $exe "$deployDir\OssManager.exe" -Force
    Get-ChildItem "$deployDir\OssManager.exe.bak-*" |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 |
        Remove-Item -Force
    Write-Host "已部署到 $deployDir（本次备份 .bak-$stamp，历史备份仅保留最近 3 份）"
    Write-Host "启动命令（经 explorer 代理拿标准令牌，盘符才在资源管理器可见）："
    Write-Host "  Start-Process explorer.exe -ArgumentList '$deployDir\OssManager.exe'"
}
