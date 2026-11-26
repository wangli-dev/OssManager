# 第三方组件许可

OssManager 自身以 MIT 许可发布。程序在编译时静态链接了若干开源组件，分发二进制时请同时保留本文件与各组件的许可声明。

## rclone

本程序通过 [rclone](https://rclone.org/) 库访问远端存储，rclone 使用 MIT 许可，与本项目许可兼容。

```text
Copyright (C) 2012 by Nick Craig-Wood http://www.craig-wood.com/nick/

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Wails

界面框架 [Wails](https://wails.io/) 使用 MIT 许可。

## AWS SDK for Go v2

`github.com/aws/aws-sdk-go-v2` 及其子模块使用 Apache License 2.0，可与 MIT 项目共同分发。

## 其他依赖

其余 Go 与前端依赖的许可证见各自模块仓库及 `go.sum`、`frontend/package-lock.json`。如再分发二进制，请一并保留上述声明。
