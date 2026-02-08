# Chrome MCP Integration - 脚本工具

> **版本**: 2.0.0 | **最后更新**: 2026-02-08

本目录包含用户安装和使用 Chrome MCP Integration 所需的脚本工具。

---

## 🚀 快速开始

### 首次安装（推荐）

```bash
# 运行完整安装向导（包含构建、注册、Extension 加载指导）
./scripts/install.sh
```

### 单独操作

```bash
# 1. 手动加载 Chrome Extension
./scripts/setup-extension.sh

# 2. 更新 Extension ID（当 Extension 重新加载后 ID 变化时）
./scripts/update-extension-id.sh <YOUR_EXTENSION_ID>

# 3. 诊断安装问题
./scripts/diagnose.sh
```

---

## 📋 脚本说明

### 🔧 核心脚本

#### `install.sh` - 完整安装向导

**用途**: 自动化完成所有安装步骤

**功能**:

- 检查依赖（Node.js, Chrome）
- 自动构建 Extension 和 Native Server
- 注册 Native Messaging Host
- 指导用户加载 Extension
- 验证安装状态

**使用场景**: 首次安装或重新安装

**示例**:

```bash
cd packages/mcp-chrome-integration
./scripts/install.sh
```

---

#### `setup-extension.sh` - Extension 安装助手

**用途**: 指导用户手动加载 Chrome Extension

**功能**:

- 显示详细的 Extension 加载步骤
- 提供正确的 Extension 目录路径
- 帮助用户复制 Extension ID

**使用场景**: 单独加载或重新加载 Extension

**示例**:

```bash
./scripts/setup-extension.sh
```

---

#### `update-extension-id.sh` - 更新 Extension ID

**用途**: 更新 Native Messaging 配置中的 Extension ID

**功能**:

- 修改 Native Messaging manifest 文件
- 更新 `allowed_origins` 配置
- 适配新的 Extension ID

**使用场景**: Extension 重新加载后 ID 变化时

**参数**: `<EXTENSION_ID>` - 新的 Extension ID

**示例**:

```bash
# 假设新的 Extension ID 是 abcdefghijklmnopqrstuvwxyz123456
./scripts/update-extension-id.sh abcdefghijklmnopqrstuvwxyz123456
```

---

### 🔍 诊断工具

#### `diagnose.sh` - 系统诊断

**用途**: 检查安装状态，排查问题

**功能**:

- 检查 Chrome Extension 安装状态
- 检查 Native Messaging Host 注册
- 检查 Native Server 文件
- 检查 Qwen CLI MCP 配置
- 验证权限和路径

**使用场景**: 遇到连接或功能问题时

**示例**:

```bash
./scripts/diagnose.sh
```

---

## 🔄 常见工作流

### 工作流 1: 首次安装

```bash
# 一键完成所有安装步骤
./scripts/install.sh

# 如果遇到问题，运行诊断
./scripts/diagnose.sh
```

### 工作流 2: Extension ID 变更

```bash
# 1. 在 Chrome 中重新加载 Extension
# 2. 复制新的 Extension ID
# 3. 更新配置
./scripts/update-extension-id.sh <NEW_EXTENSION_ID>

# 4. 验证更新成功
./scripts/diagnose.sh
```

### 工作流 3: 故障排查

```bash
# 1. 运行诊断获取详细信息
./scripts/diagnose.sh

# 2. 根据诊断结果修复问题
# 3. 如果需要重新安装
./scripts/install.sh
```

---

## 📝 与 npm scripts 的关系

这些 shell 脚本是对 `package.json` 中 npm scripts 的补充：

| Shell 脚本               | npm script 等价                                      | 说明                   |
| ------------------------ | ---------------------------------------------------- | ---------------------- |
| `install.sh`             | `npm run build && npm run install:native` + 手动步骤 | shell 脚本提供更多指导 |
| `diagnose.sh`            | `npm run doctor` + 额外检查                          | shell 脚本检查更全面   |
| `setup-extension.sh`     | 无等价命令                                           | 纯手动操作指导         |
| `update-extension-id.sh` | 无等价命令                                           | 配置文件修改工具       |

**推荐做法**:

- 开发者使用 npm scripts（如 `npm run build`, `npm run dev`）
- 最终用户使用 shell 脚本（如 `./scripts/install.sh`）

---

## ⚠️ 注意事项

### Extension ID 问题

每次在 Chrome 中重新加载未打包的 Extension，Extension ID 都会改变。解决方案：

1. **临时方案**: 每次重新加载后执行 `update-extension-id.sh`
2. **永久方案**: 发布为私有 Extension（固定 ID）

### 权限问题（macOS/Linux）

确保脚本有执行权限：

```bash
chmod +x scripts/*.sh
```

### 路径问题

所有脚本都应该在项目根目录下执行：

```bash
cd packages/mcp-chrome-integration
./scripts/install.sh  # ✓ 正确
```

---

## 🔗 相关资源

- **安装指南**: [docs/guides/installation.md](../docs/guides/installation.md)
- **快速开始**: [docs/guides/quick-start.md](../docs/guides/quick-start.md)
- **故障排查**: [docs/guides/development.md](../docs/guides/development.md)
- **项目 README**: [../README.md](../README.md)

---

## 🗂️ 归档脚本

开发和测试用的脚本已移至 `archive/scripts/`，包括：

- 构建脚本（已被 npm scripts 替代）
- MCP 测试脚本（开发者测试用）
- Service Worker 调试代码（开发者调试用）

详见: [../archive/scripts/README.md](../archive/scripts/README.md)

---

**维护者**: Qwen Code Team
**许可证**: Apache-2.0
