# 🚀 快速开始

## 首次使用

如果是第一次使用，请运行：

```bash
npm run dev
```

系统会自动检测并引导你完成：
1. 📦 手动安装 Chrome 插件
2. 🔧 配置 Native Host
3. 🎯 启动调试环境

## 安装步骤说明

### 第一次运行时需要：

1. **手动加载插件到 Chrome**
   - 打开 `chrome://extensions/`
   - 开启「开发者模式」（右上角）
   - 点击「加载已解压的扩展程序」
   - 选择 `extension` 目录
   - **记下扩展 ID**（很重要！）

2. **输入扩展 ID**
   - 脚本会提示你输入
   - 这样 Native Host 才能识别插件

3. **完成后**
   - 以后运行 `npm run dev` 就会自动加载所有内容

## 常见问题

### Q: 为什么需要手动加载插件？
A: Chrome 安全机制要求开发者模式的插件必须手动加载一次。

### Q: 插件图标在哪里？
A: 点击 Chrome 工具栏的拼图图标，找到 "Qwen CLI Bridge" 并点击固定。

### Q: 如何知道插件是否加载成功？
A:
- 在 `chrome://extensions/` 能看到插件
- 工具栏有插件图标
- 点击图标能看到弹出窗口

## 调试命令

```bash
npm run dev              # 启动调试环境（首次会引导安装）
npm run logs             # 查看 Native Host 日志
npm run logs:qwen        # 查看 Qwen 服务器日志
npm run clean            # 清理所有临时文件
```

## 文件说明

```
├── first-install.sh     # 首次安装向导
├── debug.sh            # 调试启动脚本
├── .extension-id       # 保存的扩展 ID（自动生成）
└── extension/          # Chrome 插件源码
```