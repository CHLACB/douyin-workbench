# 随包运行时许可证

`scripts/publish-product.ps1` 会把实际随包版本对应的许可证复制到成品的 `LICENSES` 目录：

- `Node.js-LICENSE.txt`：随包 `runtime/node.exe` 对应版本的 Node.js 许可证与第三方声明；
- `dotnet-LICENSE.txt`：自包含 .NET 运行时许可证；
- `dotnet-ThirdPartyNotices.txt`：自包含 .NET 运行时第三方声明。

如果本机 Node 安装目录没有附带 `LICENSE`，发布脚本会从 Node.js 官方 GitHub 版本标签下载与 `node --version` 完全对应的许可证。许可证获取失败时发布会终止，不会生成缺少声明的成品。
