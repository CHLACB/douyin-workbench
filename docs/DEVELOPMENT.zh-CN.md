# 开发说明

本项目使用 AI 辅助开发，包含需求拆解、界面迭代、问题排查与本地验证实践。

## 构建与验证

```powershell
npm test
dotnet build desktop/DouyinAutomation.Desktop/DouyinAutomation.Desktop.csproj -c Release
dotnet build desktop/DouyinAutomation.Launcher/DouyinAutomation.Launcher.csproj -c Release
npm run product:publish
```

默认成品输出到 `dist/DouyinAutomation`。也可指定独立目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-product.ps1 -ProductDirectoryName DouyinAutomation-v1.2.0
```

v1.2.0 本地验证：51 项 Node 测试通过，两个 Release 构建通过；界面覆盖 1440×900、1024×768、920×640 三种窗口尺寸，设置读写和密钥加密通过隔离测试。测试结果不代表所有平台在线操作均已验收，实际发送与付费模型调用未纳入本轮验收。

## 技术结构

```text
C# WinForms 启动器 / 桌面界面
          ↓
Node.js 命令控制层
          ↓
Chrome DevTools Protocol → 专用 Chrome

桌面界面 → 兼容 chat/completions 的模型服务
```

源码分为桌面 UI、应用逻辑、浏览器/CDP 基础设施与本地测试。详细说明见 [使用文档](USAGE.zh-CN.md) 和 [架构说明](ARCHITECTURE.zh-CN.md)。

## 数据与使用边界

- 登录状态保存在本地 `.runtime`；API Key 使用当前 Windows 用户的 DPAPI 加密保存。
- 仓库和发布压缩包不包含登录资料、真实 API Key、本地配置或采集记录。
- 使用 AI 生成时，主题、模板及最近 20 条评论会发送到配置的模型服务。
- 请仅在有权限的场景下使用，并遵守平台规则。该项目与抖音官方无关联。
