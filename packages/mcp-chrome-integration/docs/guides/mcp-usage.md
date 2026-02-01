# MCP Chrome 快速使用指南

## ✅ 配置已完成

MCP 服务器 "chrome" 已成功添加到 Qwen CLI。

---

## 📍 使用方式

### 方式 1: 在项目目录使用（当前配置）

MCP 配置位于项目级别，需要在配置目录下使用：

```bash
# 进入配置目录
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension

# 查看 MCP 服务器
qwen mcp list
# 输出: ✗ chrome: node /path/to/index.js (stdio) - Disconnected
#       （"Disconnected" 是正常的，服务器按需启动）

# 启动 Qwen 会话
qwen

# 在会话中使用浏览器工具
> 请列出当前打开的所有 Chrome 标签页
> 帮我截图当前页面
```

### 方式 2: 添加到全局配置（任意目录使用）

如果想在任何目录都能使用，添加到全局配置：

```bash
# 在主目录添加
cd ~
qwen mcp add chrome node /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/mcp/mcp-server-stdio.js

# 然后在任意目录都可以使用
cd /anywhere
qwen mcp list
qwen
```

---

## 🔍 验证配置

### 检查配置文件

**项目配置**:
```bash
cat /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension/.qwen/settings.json
```

应该包含：
```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": [
        "/Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/mcp/mcp-server-stdio.js"
      ]
    }
  }
}
```

**全局配置**（如果使用方式 2）:
```bash
# 查找全局配置
find ~/.qwen -name "settings.json" -exec grep -l "mcpServers" {} \;
```

### 检查 Native Server

```bash
# 检查文件是否存在
ls -la /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/mcp/mcp-server-stdio.js

# 检查是否可执行
node /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/mcp/mcp-server-stdio.js --help 2>&1 | head -5
```

---

## 🎯 实际测试

### 测试 1: 基本连接（无需 Extension）

```bash
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension

qwen << EOF
列出所有可用的 MCP 工具
EOF
```

### 测试 2: 浏览器工具（需要 Extension）

**前提条件**:
1. Chrome Extension 已加载
2. Extension 已连接到 Native Server

**测试命令**:
```bash
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension

qwen << EOF
请列出当前打开的所有 Chrome 标签页
EOF
```

---

## ⚠️ 常见问题

### Q1: `qwen mcp list` 显示 "No MCP servers configured"

**原因**: 在错误的目录运行命令

**解决**:
```bash
# 进入配置目录
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension

# 或添加到全局配置
cd ~ && qwen mcp add chrome node /path/to/index.js
```

### Q2: 显示 "Disconnected" 正常吗？

**回答**: 完全正常！

- MCP 服务器是**按需启动**的
- 只有在 Qwen 会话中实际使用时才会连接
- "Disconnected" 只是表示当前没有活动连接

### Q3: 如何知道 MCP 服务器是否真的工作？

**测试方法**:
```bash
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension

# 启动会话并测试
qwen << EOF
你有哪些浏览器相关的工具可以使用？
EOF
```

如果 MCP 服务器正常工作，Qwen 会列出 20+ 个浏览器工具。

### Q4: Extension 是否必需？

**回答**: 取决于你要使用的工具

- **不需要 Extension**:
  - MCP 服务器信息查询
  - 工具列表

- **需要 Extension**:
  - 所有浏览器操作工具（截图、点击、读取页面等）
  - Extension 需要先完成通信层适配（参考 `docs/status/implementation-summary.md`）

---

## 📚 相关文档

- **调试指南（历史）**: `docs/archive/DEBUG_GUIDE.md`
- **实施总结**: `docs/status/implementation-summary.md`
- **依赖安装报告**: `docs/reports/dependency-installation.md`

---

## 🎉 总结

✅ **MCP 配置已完成**
- 配置文件: `app/chrome-extension/.qwen/settings.json`
- 服务器路径: `app/native-server/dist/mcp/mcp-server-stdio.js`
- 状态: Disconnected（正常）

✅ **使用方式**
- 方式 1: 在 `app/chrome-extension/` 目录下使用 ✅
- 方式 2: 添加到全局配置（任意目录使用）

✅ **下一步**
- 在 Qwen 会话中实际测试
- 如需浏览器工具，需完成 Extension 适配

---

**创建时间**: 2026-01-17
**最后更新**: 2026-01-17 10:35
