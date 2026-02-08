# 归档脚本说明

> **归档日期**: 2026-02-08 | **归档原因**: 脚本整合到 npm scripts 和顶层用户脚本

本目录包含 `app/chrome-extension/scripts/` 中已归档的开发/测试脚本。

---

## 归档原因

### 1. 用户脚本已整合到顶层

最终用户使用的脚本位于项目顶层 `packages/mcp-chrome-integration/scripts/`：

| 用户脚本位置             | 功能               |
| ------------------------ | ------------------ |
| `install.sh`             | 完整安装向导       |
| `setup-extension.sh`     | Extension 加载助手 |
| `update-extension-id.sh` | 更新 Extension ID  |
| `diagnose.sh`            | 系统诊断           |

### 2. 开发脚本已整合到 npm scripts

开发者使用的命令位于 `package.json`：

| npm script          | 功能                                                |
| ------------------- | --------------------------------------------------- |
| `npm run dev`       | 开发模式监视（调用 `scripts/dev-watch.js`）         |
| `npm run build`     | 构建 Extension                                      |
| `npm run build:bg`  | 构建 Background（调用 `scripts/sync-extension.js`） |
| `npm run debug:mac` | macOS 调试（调用 `scripts/debug.sh`）               |

---

## 当前目录状态

### scripts/ 目录（保留 3 个必需脚本）

以下脚本被 `package.json` 引用，必须保留在 `scripts/` 目录：

| 脚本                | 被引用              | 功能                |
| ------------------- | ------------------- | ------------------- |
| `dev-watch.js`      | `npm run dev`       | 协调多个 watch 进程 |
| `sync-extension.js` | `npm run build:bg*` | 同步静态资源        |
| `debug.sh`          | `npm run debug:mac` | macOS 调试启动      |

### archive/scripts/ 目录（已归档 8 个脚本）

| 脚本                  | 原功能       | 归档原因                                   |
| --------------------- | ------------ | ------------------------------------------ |
| `build.sh`            | 构建并打包   | 被 `npm run build && npm run package` 替代 |
| `clean.sh`            | 清理 dist    | 被 `npm run clean` 替代                    |
| `first-install.sh`    | 首次安装向导 | 与顶层 `install.sh` 重复                   |
| `start.sh`            | 复杂启动脚本 | 与 `debug.sh` 功能重叠                     |
| `dev.js`              | 开发启动     | 400+ 行，未被使用                          |
| `cbmcp-wrapper.sh`    | 调试包装器   | 引用不存在的文件，已废弃                   |
| `set-extension-id.sh` | 设置扩展 ID  | 硬编码测试 ID，临时脚本                    |
| `test-simple.sh`      | 简单测试     | 开发者测试用                               |

---

## 开发者使用指南

### 开发模式

```bash
cd packages/mcp-chrome-integration/app/chrome-extension

# 启动开发监视（推荐）
npm run dev

# 或分别启动
npm run build:bg:watch  # Background 监视
npm run build:ui:watch   # UI 监视
```

### 构建发布包

```bash
npm run build           # 构建
npm run package         # 打包 zip
```

### macOS 调试

```bash
npm run debug:mac       # 一键启动调试环境
```

---

## 相关信息

- **项目根脚本**: `packages/mcp-chrome-integration/scripts/`
- **Chrome Extension**: `packages/mcp-chrome-integration/app/chrome-extension/`
- **Native Host**: `packages/mcp-chrome-integration/app/native-host/`

---

**归档日期**: 2026-02-08
**维护者**: Qwen Code Team
