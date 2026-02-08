# Chrome MCP Integration 文档

> **版本**: 2.0.0 | **最后更新**: 2026-02-08

欢迎使用 Chrome MCP Integration 文档。本项目将 Chrome 浏览器与 Qwen CLI 集成，提供 **27 个强大的浏览器自动化工具**。

---

## 📚 快速导航

### 🚀 新用户入门

1. **[快速开始](guides/quick-start.md)** - 5分钟快速上手
2. **[安装指南](guides/installation.md)** - 完整安装步骤
3. **[MCP 使用指南](guides/mcp-usage.md)** - 在 Qwen CLI 中使用

### 🏗️ 架构与设计

- **[系统架构](architecture.md)** - 3层架构设计、组件说明、数据流
- **[工具参考](tools-reference.md)** - 27个 chrome\_\* 工具的完整文档（539行）

### 💻 开发者资源

- **[开发指南](guides/development.md)** - 开发环境配置、调试技巧
- **[定制指南](guides/customization.md)** - 扩展和定制工具
- **[架构决策记录 (ADR)](adr/README.md)** - 关键技术决策

---

## 🛠️ 核心功能

### 27 个浏览器自动化工具

| 类别         | 工具数量 | 主要功能                              |
| ------------ | -------- | ------------------------------------- |
| 浏览器管理   | 6        | 窗口/标签管理、页面导航、DOM 访问     |
| 页面交互     | 5        | 点击、填充、键盘输入、JavaScript 执行 |
| 网络监控     | 2        | 网络请求捕获、HTTP 请求发送           |
| 内容分析     | 2        | 页面内容提取、控制台日志捕获          |
| 数据管理     | 4        | 历史记录、书签管理                    |
| 截图与录制   | 2        | 页面截图、GIF 录制                    |
| 性能分析     | 3        | 性能追踪、分析                        |
| 文件与对话框 | 3        | 文件上传、对话框处理、下载管理        |

详见 **[工具参考文档](tools-reference.md)**

---

## 🏛️ 架构概览

```
Chrome Extension (MV3)
         ↓ Native Messaging
    Native Server (Node.js)
         ↓ MCP Protocol
       Qwen CLI (AI Agent)
```

**3 层架构**，相比旧版 HTTP 架构：

- 🎯 **架构简化**: 5层 → 3层 (-40%)
- 🚀 **工具增强**: 10个 → 27个 (+170%)
- ⚡ **性能提升**: Native Messaging 更快更稳定

详见 **[架构文档](architecture.md)**

---

## 📖 文档结构

```
docs/
├── README.md              # 本文档（导航入口）
├── architecture.md        # 系统架构设计
├── tools-reference.md     # 工具完整参考（539行）
│
├── guides/                # 用户指南
│   ├── installation.md
│   ├── quick-start.md
│   ├── development.md
│   ├── mcp-usage.md
│   └── customization.md
│
└── adr/                   # 架构决策记录
    ├── 0001-native-messaging.md
    ├── 0002-mcp-stdio-entrypoint.md
    ├── 0003-tool-naming.md
    └── README.md
```

---

## 🗂️ 归档文档

开发过程中的中间产物已归档到 `../archive/docs/`：

- **设计骨架**: 13个未完成的设计草稿
- **状态追踪**: 4个实施计划和状态报告
- **一次性报告**: 2个验证和依赖安装报告

详见 [归档说明](../archive/docs/README.md)

---

## 💡 常见问题

### 如何快速开始？

1. 阅读 [快速开始](guides/quick-start.md)
2. 按照 [安装指南](guides/installation.md) 配置环境
3. 查看 [工具参考](tools-reference.md) 了解 27 个可用工具

### 如何调试问题？

参考 [开发指南](guides/development.md) 中的调试章节

### 如何扩展新工具？

参考 [定制指南](guides/customization.md)

### 工具列表在哪里？

- **完整参考**: [tools-reference.md](tools-reference.md) - 539行，每个工具详细说明
- **快速查看**: [../README.md](../README.md) - 项目主页简要列表

---

## 🔗 相关资源

- **项目主 README**: `../README.md`
- **源码库**: 基于 [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome)
- **变更日志**: `../CHANGELOG.md`

---

**维护者**: Qwen Code Team
**许可证**: Apache-2.0
**文档版本**: 与代码版本 2.0.0 保持一致
