# 📦 Chrome Qwen Bridge - 安装指南

## 🚀 快速安装（推荐）

### 一键安装（首次用户）

```bash
# 进入项目目录
cd packages/chrome-extension

# 运行安装向导
npm run install:all
```

这个命令会：

1. ✅ 引导你安装 Chrome 扩展
2. ✅ 自动配置 Native Host
3. ✅ 保存扩展 ID 供后续使用
4. ✅ 启动调试环境

## 📝 安装方式说明

### 场景 1：从 Chrome Web Store 安装（未来）

当扩展发布到 Chrome Web Store 后：

1. 从商店安装扩展
2. 运行 `npm run install:host`（会自动检测已安装的扩展）
3. 完成！

### 场景 2：开发者模式安装（当前）

```bash
# 步骤 1：安装扩展和 Native Host
npm run install:all

# 步骤 2：启动调试
npm run dev
```

### 场景 3：分步安装

```bash
# 1. 仅安装 Chrome 扩展
npm run install:extension

# 2. 仅配置 Native Host
npm run install:host

# 3. 启动开发环境
npm run dev
```

## 🔧 Native Host 说明

### 什么是 Native Host？

Native Host 是一个本地程序，允许 Chrome 扩展与本地应用（如 Qwen CLI）通信。出于安全考虑，Chrome 要求必须手动安装。

### 智能安装器特性

我们的 `smart-install.sh` 脚本会：

1. **自动检测** - 尝试自动找到已安装的扩展
2. **保存配置** - 记住扩展 ID，下次无需输入
3. **通用模式** - 即使没有扩展 ID 也能配置
4. **连接测试** - 可选的连接验证

### 安装位置

Native Host 配置文件位置：

- **macOS**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- **Linux**: `~/.config/google-chrome/NativeMessagingHosts/`

## ❓ 常见问题

### Q: 必须手动安装 Native Host 吗？

A: 是的，这是 Chrome 的安全要求。但我们的智能安装器让这个过程非常简单。

### Q: 如何找到扩展 ID？

A:

1. 打开 `chrome://extensions/`
2. 找到 "Qwen CLI Bridge"
3. ID 显示在扩展卡片上（类似 `abcdefghijklmnop...`）

### Q: 重装扩展后需要重新配置吗？

A: 如果扩展 ID 改变了，需要重新运行 `npm run install:host`。脚本会自动检测新的 ID。

### Q: 如何验证安装成功？

A: 运行 `npm run dev`，如果能看到插件图标并能点击连接，说明安装成功。

## 📋 命令参考

| 命令                        | 说明               |
| --------------------------- | ------------------ |
| `npm run install:all`       | 完整安装向导       |
| `npm run install:extension` | 仅安装扩展         |
| `npm run install:host`      | 仅配置 Native Host |
| `npm run dev`               | 启动调试环境       |
| `npm run clean`             | 清理所有配置和日志 |

## 🔄 更新和重装

如果需要重新安装：

```bash
# 清理旧配置
npm run clean

# 重新安装
npm run install:all
```

### 更换电脑或浏览器后的配置更新

如果你更换了电脑、浏览器或得到了新的扩展ID，可以使用专用的更新脚本：

```bash
# 进入Native Host目录
cd native-host

# 运行配置更新脚本
./update-host-config.sh
```

这个脚本会引导你：

1. 选择特定扩展ID或通用配置模式
2. 更新Native Host配置文件
3. 验证配置是否正确

使用这个脚本比完全重新安装更快捷方便。

## 📚 更多信息

- [调试指南](./docs/debugging.md)
- [API 文档](./docs/api-reference.md)
- [架构设计](./docs/architecture.md)
