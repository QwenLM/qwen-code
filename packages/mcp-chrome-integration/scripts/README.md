# Chrome MCP Integration - 脚本工具

> **版本**: 2.0.0 | **最后更新**: 2026-02-09

本目录包含用户安装和使用 Chrome MCP Integration 所需的脚本工具。

---

## 🚀 快速开始

### 首次安装（推荐）

```bash
# 运行完整安装向导
./scripts/install.sh
```

**自动完成**：

- ✅ 检查依赖（Node.js 22+, pnpm）
- ✅ 安装所有依赖
- ✅ 构建 Extension 和 Native Server
- ✅ 注册 Native Messaging Host
- ✅ 指导加载 Chrome Extension

---

## 📋 可用脚本

### install.sh - 一键安装

**用途**: 自动化完整安装流程

**使用**:

```bash
cd packages/mcp-chrome-integration
./scripts/install.sh
```

**功能**:

1. 检查 Node.js (v22+) 和 pnpm
2. 安装所有依赖：`pnpm install`
3. 构建所有组件：`pnpm run build`
4. 注册 Native Messaging Host
5. 验证安装状态
6. 显示后续步骤指导

**适用场景**: 首次安装或重新安装

---

### update-extension-id.sh - 更新 Extension ID

**用途**: 更新 Native Messaging 配置中的 Extension ID

**使用**:

```bash
./scripts/update-extension-id.sh <YOUR_EXTENSION_ID>
```

**示例**:

```bash
# 假设新的 Extension ID 是 abcdefghijklmnopqrstuvwxyz123456
./scripts/update-extension-id.sh abcdefghijklmnopqrstuvwxyz123456
```

**功能**:

- 修改 `~/.../NativeMessagingHosts/com.chromemcp.nativehost.json`
- 更新 `allowed_origins` 为新的 Extension ID
- 创建配置文件备份

**适用场景**:

- 开发模式下重新加载 Extension 后 ID 变化
- 临时测试不同的 Extension 版本

**注意**: 使用固定密钥打包可避免 ID 变化，详见 [docs/01-installation-guide.md](../docs/01-installation-guide.md)

---

### diagnose.sh - 系统诊断

**用途**: 检查安装状态，排查常见问题

**使用**:

```bash
./scripts/diagnose.sh
```

**检查项目**:

1. ✅ Node.js 版本和路径
2. ✅ pnpm 安装状态
3. ✅ Extension 和 Native Server 构建产物
4. ✅ Native Messaging Host 配置文件
5. ✅ Chrome Extension 安装状态
6. ✅ 日志文件内容
7. ✅ run_host.sh 可执行权限

**输出示例**:

```
===== Chrome MCP Integration 诊断工具 =====

1️⃣  检查 Node.js...
✅ Node.js 已安装: v22.0.0
   路径: /usr/local/bin/node

2️⃣  检查 pnpm...
✅ pnpm 已安装: v9.0.0

3️⃣  检查构建产物...
✅ Chrome Extension 已构建
✅ Native Server 已构建

...
```

**适用场景**:

- Extension 无法连接 Native Host
- 工具调用失败
- 安装后验证

---

## 🔄 常见工作流

### 工作流 1: 首次安装

```bash
# 一键完成所有步骤
./scripts/install.sh

# 如果遇到问题，运行诊断
./scripts/diagnose.sh
```

---

### 工作流 2: Extension ID 变更

```bash
# 1. 在 Chrome 中重新加载 Extension (chrome://extensions/)
# 2. 复制新的 Extension ID
# 3. 更新配置
./scripts/update-extension-id.sh <NEW_EXTENSION_ID>

# 4. 验证更新
./scripts/diagnose.sh
```

---

### 工作流 3: 故障排查

```bash
# 1. 运行诊断获取详细信息
./scripts/diagnose.sh

# 2. 根据诊断结果修复问题
# 3. 如果需要重新安装
./scripts/install.sh
```

---

## ⚠️ 注意事项

### Extension ID 问题

每次在 Chrome 中重新加载未打包的 Extension，ID 都会改变。

**临时方案**（开发用）:

```bash
# 每次重新加载后运行
./scripts/update-extension-id.sh <NEW_ID>
```

**永久方案**（生产用）:

```bash
# 使用固定密钥打包
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --pack-extension=$(pwd)/app/chrome-extension/dist/extension \
  --pack-extension-key=$(pwd)/app/chrome-extension/.extension-key.pem
```

详见: [docs/01-installation-guide.md § Q1](../docs/01-installation-guide.md)

---

### 权限问题（macOS/Linux）

确保脚本有执行权限：

```bash
chmod +x scripts/*.sh
```

---

### 路径问题

所有脚本都应在项目根目录下执行：

```bash
cd packages/mcp-chrome-integration
./scripts/install.sh  # ✓ 正确

cd scripts
./install.sh          # ✗ 错误
```

---

## 📝 与 npm scripts 的关系

| Shell 脚本               | npm script 等价                                | 说明                     |
| ------------------------ | ---------------------------------------------- | ------------------------ |
| `install.sh`             | `pnpm install && pnpm run build` + 注册 + 指导 | shell 脚本提供更多自动化 |
| `diagnose.sh`            | 无等价命令                                     | 专用诊断工具             |
| `update-extension-id.sh` | 无等价命令                                     | 配置文件修改工具         |

**推荐做法**:

- **最终用户**: 使用 shell 脚本（如 `./scripts/install.sh`）
- **开发者**: 使用 npm scripts（如 `pnpm run build`, `pnpm run dev`）

---

## 🔗 相关文档

- **完整安装指南**: [docs/01-installation-guide.md](../docs/01-installation-guide.md)
- **功能与架构**: [docs/02-features-and-architecture.md](../docs/02-features-and-architecture.md)
- **测试用例**: [docs/04-test-cases.md](../docs/04-test-cases.md)
- **项目 README**: [../README.md](../README.md)

---

## 🗂️ 已删除的脚本

以下脚本在整理中被删除，原因和替代方案：

| 删除的脚本           | 删除原因               | 替代方案                    |
| -------------------- | ---------------------- | --------------------------- |
| `setup-extension.sh` | 功能与 install.sh 重复 | 使用 `./scripts/install.sh` |
| `build-all.sh`       | 已被 npm scripts 替代  | 使用 `pnpm run build`       |

---

**维护者**: Qwen Code Team
**许可证**: Apache-2.0
**版本**: 2.0.0
**最后更新**: 2026-02-09
