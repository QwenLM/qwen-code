# Chrome Qwen Bridge 文档

欢迎查阅 Chrome Qwen Bridge 的技术文档。本项目是一个 Chrome 扩展，用于连接浏览器与 Qwen CLI，实现 AI 增强的网页交互。

## 📚 文档目录

### 核心文档

1. **[架构设计文档](./architecture.md)**
   - 系统架构概览
   - 组件职责划分
   - 数据流设计
   - 安全设计
   - 性能优化策略

2. **[实施计划文档](./implementation-plan.md)**
   - 项目背景与需求
   - 分阶段实施计划
   - 技术栈选择
   - 测试与部署计划
   - 风险评估

3. **[技术细节文档](./technical-details.md)**
   - Native Messaging 协议详解
   - Chrome Extension API 使用
   - 数据提取算法
   - 进程管理
   - 调试技巧

4. **[API 参考文档](./api-reference.md)**
   - Chrome Extension APIs
   - Native Host APIs
   - Qwen CLI 集成
   - 错误代码
   - 使用示例

### 快速链接

- [主 README](../README.md) - 安装和使用指南
- [GitHub 仓库](https://github.com/QwenLM/qwen-code) - 源代码
- [问题反馈](https://github.com/QwenLM/qwen-code/issues) - 提交 Issue

## 🎯 项目特性

- ✅ **Native Messaging** - Chrome 官方推荐的安全通信方式
- ✅ **MCP 服务器支持** - 集成多个 Model Context Protocol 服务器
- ✅ **丰富的数据提取** - DOM、Console、网络请求等全方位数据
- ✅ **AI 分析能力** - 利用 Qwen 的 AI 能力分析网页内容
- ✅ **跨平台支持** - Windows、macOS、Linux 全平台

## 🚀 快速开始

1. **安装扩展**
   ```bash
   # 在 Chrome 中加载未打包的扩展
   chrome://extensions/ → 开发者模式 → 加载已解压的扩展程序
   选择: packages/chrome-qwen-bridge/extension
   ```

2. **安装 Native Host**
   ```bash
   cd packages/chrome-qwen-bridge/native-host
   ./install.sh  # macOS/Linux
   # 或
   install.bat   # Windows
   ```

3. **连接使用**
   - 点击扩展图标
   - 连接到 Qwen CLI
   - 开始分析网页！

## 📖 文档说明

### 架构设计文档
详细描述了系统的整体架构，包括 Chrome Extension、Native Host 和 Qwen CLI 三层架构的设计理念、组件职责、数据流向等核心概念。

### 实施计划文档
记录了项目从概念到实现的完整过程，包括各个开发阶段的任务分解、技术选型依据、测试计划和未来优化方向。

### 技术细节文档
深入探讨了关键技术的实现细节，如 Native Messaging 协议的具体实现、数据提取算法、进程管理策略等。

### API 参考文档
提供了所有 API 的完整参考，包括消息格式、参数说明、返回值、错误代码等，是开发和调试的重要参考。

## 🛠 技术架构

```
Chrome Browser
     ↓
Chrome Extension (Content Script + Service Worker + Popup)
     ↓
Native Messaging API
     ↓
Native Host (Node.js)
     ↓
Qwen CLI + MCP Servers
```

## 📝 版本历史

- **v1.0.0** (2024-12) - 初始版本
  - 实现基础架构
  - Native Messaging 通信
  - 页面数据提取
  - Qwen CLI 集成

## 🤝 贡献指南

欢迎贡献代码和文档！请查看主仓库的贡献指南。

## 📄 许可证

Apache-2.0 License

---

*本文档集是 Chrome Qwen Bridge 项目的技术参考，持续更新中。*