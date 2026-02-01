# MCP Chrome Integration - 脚本工具集

本目录包含 MCP Chrome Integration 项目的各种实用脚本，用于构建、安装、测试和诊断。

**版本**: 1.0
**最后更新**: 2026-01-25

---

## 📋 脚本索引

### 🔧 构建和安装脚本
- [build-all.sh](#build-allsh) - 构建所有组件
- [install.sh](#installsh) - 自动化完整安装
- [setup-extension.sh](#setup-extensionsh) - 设置 Chrome 扩展

### 🔍 测试脚本
- [test-mcp.sh](#test-mcpsh) - MCP 集成测试
- [test-mcp-tool.sh](#test-mcp-toolsh) - 单个 MCP 工具测试
- [test-simple.sh](#test-simplesh) - 简单连接测试
- [test-stdio.sh](#test-studiosh) - STDIO 模式测试
- [test-stdio-full.sh](#test-stdio-fullsh) - STDIO 完整测试
- [test-hangwin-tools.js](#test-hangwin-toolsjs) - Hangwin 工具测试
- [test-service-worker.js](#test-service-workerjs) - Service Worker 测试

### 🛠️ 维护脚本
- [diagnose.sh](#diagnosesh) - 诊断工具
- [verify-mcp.sh](#verify-mcpsh) - 验证 MCP 配置
- [update-extension-id.sh](#update-extension-idsh) - 更新 Extension ID

---

## 📖 脚本详细说明

### build-all.sh

**用途**: 构建项目的所有组件

**描述**: 按照正确的依赖顺序构建 shared 包、native-server 和 chrome-extension

**使用方法**:
```bash
cd /path/to/mcp-chrome-integration
./scripts/build-all.sh
```

**执行步骤**:
1. 构建 `packages/shared` 包
2. 构建 `app/native-server`
3. 构建 `app/chrome-extension`

**输出**: 各组件的构建产物在各自的 `dist/` 目录

**依赖**: pnpm

**预计时间**: 2-5 分钟

---

### install.sh

**用途**: 完整的自动化安装向导

**描述**: 一键完成依赖安装、构建、Native Messaging 注册和验证

**使用方法**:
```bash
cd /path/to/mcp-chrome-integration
./scripts/install.sh
```

**执行步骤**:
1. 检查 Node.js 和 pnpm 版本
2. 安装所有依赖
3. 构建所有组件（调用 build-all.sh）
4. 注册 Native Messaging Host
5. 验证安装（运行 doctor 命令）

**环境要求**:
- Node.js 22+
- pnpm
- macOS/Linux（Windows 需要修改路径）

**预计时间**: 5-10 分钟

**后续步骤**: 脚本会输出详细的下一步指引

---

### setup-extension.sh

**用途**: 交互式设置 Chrome Extension

**描述**: 引导用户完成扩展加载、Extension ID 获取和配置更新

**使用方法**:
```bash
./scripts/setup-extension.sh
```

**交互步骤**:
1. 提示用户在 Chrome 中加载扩展
2. 要求输入 Extension ID
3. 自动更新 Native Messaging 配置文件
4. 引导验证连接

**注意事项**:
- 需要手动在 Chrome 中操作
- 会备份原配置文件（.backup 后缀）
- Extension ID 格式验证（32个小写字母）

**配置文件位置**:
- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json`

---

### diagnose.sh

**用途**: 全面的诊断工具

**描述**: 检查所有组件的状态，帮助排查问题

**使用方法**:
```bash
./scripts/diagnose.sh
```

**检查项目**:
1. ✅ Chrome 扩展安装状态
2. ✅ Native Messaging Host 配置
3. ✅ 脚本文件可执行性
4. ✅ Node.js 版本
5. ✅ 日志文件
6. ✅ HTTP 服务器运行状态（端口 12306）

**输出**:
- 各项检查结果（✅ 或 ❌）
- 最新日志摘要
- 常见问题解决方案

**适用场景**:
- 安装后验证
- 连接问题排查
- 定期健康检查

---

### test-mcp.sh

**用途**: 测试 MCP 与 Qwen CLI 的集成

**描述**: 检查 MCP 配置、Native Server 启动和基本连接

**使用方法**:
```bash
./scripts/test-mcp.sh
```

**测试内容**:
1. 检查 Qwen MCP 配置
2. 验证 Native Server 文件存在
3. 测试 Native Server 启动
4. 显示手动测试步骤

**输出**:
- MCP 服务器列表
- Native Server 启动日志
- 手动测试指引

**注意**: MCP 服务器显示 "Disconnected" 是正常的

---

### test-mcp-tool.sh

**用途**: 测试单个 MCP 工具

**描述**: 针对特定工具的测试脚本

**使用方法**:
```bash
./scripts/test-mcp-tool.sh [tool_name]
```

**参数**:
- `tool_name`: 要测试的工具名称（可选）

**示例**:
```bash
./scripts/test-mcp-tool.sh chrome_screenshot
```

---

### test-simple.sh

**用途**: 简单的 MCP 连接测试

**描述**: 快速验证 MCP 配置和文件存在性

**使用方法**:
```bash
./scripts/test-simple.sh
```

**检查项目**:
1. MCP 配置列表
2. MCP Server 文件存在性
3. MCP Server 可执行性

**特点**:
- 快速（<10秒）
- 无副作用
- 适合频繁运行

---

### test-stdio.sh

**用途**: 测试 STDIO 模式

**描述**: 验证 MCP Server 的 STDIO 通信模式

**使用方法**:
```bash
./scripts/test-stdio.sh
```

---

### test-stdio-full.sh

**用途**: STDIO 模式完整测试

**描述**: 更全面的 STDIO 通信测试

**使用方法**:
```bash
./scripts/test-stdio-full.sh
```

---

### test-hangwin-tools.js

**用途**: 测试 Hangwin MCP 工具

**描述**: Node.js 脚本，测试来自 hangwin/mcp-chrome 的工具

**使用方法**:
```bash
node scripts/test-hangwin-tools.js
```

**依赖**: Node.js

---

### test-service-worker.js

**用途**: 测试 Service Worker

**描述**: Node.js 脚本，测试 Chrome Extension 的 Service Worker

**使用方法**:
```bash
node scripts/test-service-worker.js
```

**依赖**: Node.js

---

### verify-mcp.sh

**用途**: 验证 MCP 配置

**描述**: 检查 MCP 配置的完整性和正确性

**使用方法**:
```bash
./scripts/verify-mcp.sh
```

**验证内容**:
- MCP 配置文件格式
- 路径有效性
- 权限设置

---

### update-extension-id.sh

**用途**: 更新 Extension ID

**描述**: 更新 Native Messaging 配置中的 Extension ID

**使用方法**:
```bash
./scripts/update-extension-id.sh <EXTENSION_ID>
```

**参数**:
- `EXTENSION_ID`: 新的 Chrome Extension ID（32个字符）

**示例**:
```bash
./scripts/update-extension-id.sh abcdefghijklmnopqrstuvwxyz123456
```

**注意**: 会备份原配置文件

---

## 🚀 快速开始流程

### 首次安装

```bash
# 1. 完整安装
./scripts/install.sh

# 2. 设置扩展
./scripts/setup-extension.sh

# 3. 验证
./scripts/diagnose.sh
```

### 开发调试

```bash
# 重新构建
./scripts/build-all.sh

# 快速测试
./scripts/test-simple.sh

# 完整测试
./scripts/test-mcp.sh
```

### 问题排查

```bash
# 1. 运行诊断
./scripts/diagnose.sh

# 2. 验证 MCP 配置
./scripts/verify-mcp.sh

# 3. 如果 Extension ID 改变
./scripts/update-extension-id.sh <新ID>
```

---

## 📊 脚本分类总结

### 按用途分类

| 分类 | 脚本数量 | 脚本列表 |
|------|---------|---------|
| 🔧 构建安装 | 3 | build-all.sh, install.sh, setup-extension.sh |
| 🔍 测试 | 7 | test-*.sh, test-*.js |
| 🛠️ 维护 | 3 | diagnose.sh, verify-mcp.sh, update-extension-id.sh |

### 按使用频率分类

| 频率 | 脚本 |
|------|------|
| **首次使用** | install.sh, setup-extension.sh |
| **经常使用** | build-all.sh, test-simple.sh, diagnose.sh |
| **偶尔使用** | test-mcp.sh, verify-mcp.sh, update-extension-id.sh |
| **开发测试** | test-*.js, test-stdio*.sh |

---

## ⚙️ 配置和环境

### 环境变量

某些脚本使用硬编码路径，如需修改，请编辑脚本中的以下变量：

```bash
# 项目根目录
PROJECT_ROOT="/Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration"

# Native Messaging 配置文件
CONFIG_FILE="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json"

# Extension ID
EXTENSION_ID="mdcjeiebajocdnaiofbdjgadeoommfjh"
```

### 日志位置

- **Native Host 日志**: `~/Library/Logs/mcp-chrome-bridge/`
- **测试日志**: `/tmp/mcp-server-test.log`
- **Service Worker 日志**: Chrome DevTools Console

---

## 🐛 常见问题

### Q1: 脚本执行权限不足

**问题**: `Permission denied`

**解决**:
```bash
chmod +x scripts/*.sh
```

### Q2: pnpm 命令不存在

**问题**: `pnpm: command not found`

**解决**:
```bash
npm install -g pnpm
```

### Q3: Node.js 版本过低

**问题**: Node.js 版本 < 18

**解决**: 升级 Node.js 到 18+ 版本
```bash
# 使用 nvm
nvm install 18
nvm use 18
```

### Q4: Extension ID 改变

**问题**: 每次重新加载扩展，ID 都会变

**解决**: 使用 `update-extension-id.sh` 更新配置，或在 manifest.json 中固定 key

---

## 🔗 相关文档

- [项目文档索引](../docs/README.md)
- [调试指南（历史）](../docs/archive/DEBUG_GUIDE.md)
- [快速开始](../docs/guides/quick-start.md)
- [开发指南](../docs/guides/development.md)

---

## 📝 贡献指南

### 添加新脚本

1. 创建脚本文件
2. 添加 shebang 和注释说明
3. 设置可执行权限 (`chmod +x`)
4. 更新本 README.md
5. 测试脚本功能

### 脚本命名规范

- **构建脚本**: `build-*.sh`
- **测试脚本**: `test-*.sh` 或 `test-*.js`
- **维护脚本**: 动词开头，如 `update-`, `verify-`, `diagnose-`

### 代码规范

- 使用 `set -e` 在遇到错误时立即退出
- 添加清晰的 echo 输出
- 使用颜色区分成功/失败/警告
- 提供明确的错误信息和解决建议

---

**脚本总数**: 13 个
**最后更新**: 2026-01-25
**维护者**: Qwen Code Team
