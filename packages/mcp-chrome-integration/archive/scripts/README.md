# 归档脚本说明

本目录包含开发和测试过程中使用的脚本，已不再需要用户使用。

## 归档原因

这些脚本是开发过程中的测试和辅助工具，包括：

- 构建脚本（已被 npm scripts 替代）
- MCP 测试脚本（开发者测试用）
- Service Worker 调试代码（开发者调试用）

用户需要的脚本位于 `scripts/` 目录。

---

## 归档内容

### 构建脚本（1个）

- `build-all.sh` - 构建所有组件（已被 `npm run build` 替代）

### 测试脚本（6个）

- `test-mcp.sh` - 测试 MCP 集成
- `test-mcp-tool.sh` - 测试单个 MCP 工具
- `test-stdio.sh` - 测试 stdio server
- `test-stdio-full.sh` - 完整 stdio 测试
- `test-simple.sh` - 简单工具测试
- `verify-mcp.sh` - 验证 MCP 连接（功能已被 diagnose.sh 覆盖）

### 调试代码（2个）

- `test-hangwin-tools.js` - Service Worker 测试代码
- `test-service-worker.js` - Service Worker 调试代码

---

## 用户脚本位置

项目的用户脚本位于：`../scripts/`

包含：

- `install.sh` - 完整安装向导
- `setup-extension.sh` - Extension 安装助手
- `update-extension-id.sh` - 更新 Extension ID
- `diagnose.sh` - 诊断工具

---

**归档日期**: 2026-02-08
**归档原因**: 清理开发测试脚本，保留用户必需脚本
