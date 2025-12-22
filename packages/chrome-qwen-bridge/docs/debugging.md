# Chrome Qwen Bridge 调试指南

## 🚀 快速开始调试

### 一键启动（推荐）

最简单的方式是使用我们提供的一键启动脚本：

```bash
# 进入项目目录
cd packages/chrome-qwen-bridge

# 方式一：使用 npm 脚本（跨平台）
npm run dev

# 方式二：使用 shell 脚本（macOS/Linux）
npm run dev:quick
# 或直接运行
./start.sh
```

**脚本会自动完成以下操作：**
1. ✅ 检查并配置 Chrome
2. ✅ 安装 Native Host
3. ✅ 检查 Qwen CLI
4. ✅ 启动 Qwen 服务器（端口 8080）
5. ✅ 启动测试页面服务器（端口 3000）
6. ✅ 启动 Chrome 并加载插件
7. ✅ 自动打开 DevTools

## 📝 可用的 npm 命令

```bash
# 开发调试
npm run dev              # 完整的开发环境启动（Node.js 脚本）
npm run dev:quick        # 快速启动（Shell 脚本）
npm run dev:stop         # 停止所有服务
npm run dev:chrome       # 仅启动 Chrome 加载插件
npm run dev:server       # 仅启动 Qwen 服务器

# 安装配置
npm run install:host           # 安装 Native Host 依赖
npm run install:host:macos     # macOS 安装 Native Host
npm run install:host:windows   # Windows 安装 Native Host
npm run update:host            # 更新 Native Host 配置（更换电脑/浏览器后使用）

# 构建打包
npm run build            # 构建项目
npm run package          # 打包扩展为 zip
npm run package:source   # 打包源代码

# 日志查看
npm run logs             # 查看 Native Host 日志
npm run logs:qwen        # 查看 Qwen 服务器日志

# 清理
npm run clean            # 清理构建文件和日志
```

## 🔧 手动调试步骤

如果自动脚本有问题，可以手动进行调试：

### 步骤 1：安装 Native Host

```bash
# macOS/Linux
cd native-host
./install.sh

# Windows（管理员权限）
cd native-host
install.bat
```

### 步骤 2：启动 Qwen 服务器（可选）

```bash
# 如果安装了 Qwen CLI
qwen server --port 8080
```

### 步骤 3：加载插件到 Chrome

1. 打开 Chrome
2. 访问 `chrome://extensions/`
3. 开启「开发者模式」
4. 点击「加载已解压的扩展程序」
5. 选择 `packages/chrome-qwen-bridge/extension` 目录

### 步骤 4：测试插件

1. 打开任意网页（或访问 http://localhost:3000）
2. 点击工具栏中的插件图标
3. 点击「Connect to Qwen CLI」
4. 测试各项功能

## 🐛 调试技巧

### 1. Chrome DevTools

#### Service Worker (Background Script)
- 打开 `chrome://extensions/`
- 找到 Qwen CLI Bridge
- 点击「Service Worker」链接
- 在打开的 DevTools 中查看日志

#### Content Script
- 在任意网页上右键 → 检查
- 在 Console 中查看 content script 的日志
- 使用 Sources 面板设置断点

#### Popup
- 右键点击插件图标
- 选择「检查弹出内容」
- 在 DevTools 中调试 popup 代码

### 2. Native Host 调试

查看 Native Host 日志：
```bash
# macOS/Linux
tail -f /tmp/qwen-bridge-host.log

# 或使用 npm 命令
npm run logs
```

测试 Native Host 连接：
```javascript
// 在 Service Worker console 中执行
chrome.runtime.sendNativeMessage('com.qwen.cli.bridge',
  {type: 'handshake', version: '1.0.0'},
  response => console.log('Native Host response:', response)
);
```

### 3. 消息调试

在 Service Worker 中添加日志：
```javascript
// background/service-worker.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message received:', request, 'from:', sender);
  // ...
});
```

### 4. 网络请求调试

使用 Chrome DevTools Network 面板：
- 查看与 Qwen 服务器的 HTTP 通信
- 检查请求/响应头和内容
- 查看请求时间

## 🔍 常见问题排查

### 问题：Native Host 连接失败

**症状**：点击「Connect」后显示连接错误

**解决方案**：
1. 检查 Native Host 是否正确安装：
   ```bash
   # macOS
   ls ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/

   # Linux
   ls ~/.config/google-chrome/NativeMessagingHosts/
   ```

2. 验证 manifest.json 中的路径是否正确
3. 确保 host.js 有执行权限：
   ```bash
   chmod +x native-host/host.js
   ```

### 问题：Qwen CLI 未响应

**症状**：显示 Qwen CLI 未安装或无响应

**解决方案**：
1. 确认 Qwen CLI 已安装：
   ```bash
   qwen --version
   ```

2. 手动启动 Qwen 服务器：
   ```bash
   qwen server --port 8080
   ```

3. 检查端口是否被占用：
   ```bash
   lsof -i:8080
   ```

### 问题：插件图标不显示

**症状**：加载插件后工具栏没有图标

**解决方案**：
1. 点击 Chrome 扩展图标（拼图图标）
2. 找到「Qwen CLI Bridge」
3. 点击固定图标

### 问题：Content Script 未注入

**症状**：提取页面数据失败

**解决方案**：
1. 刷新目标网页
2. 检查 manifest.json 的 content_scripts 配置
3. 确认网页不是 Chrome 内部页面（chrome://）

## 📊 性能分析

### Memory 分析
1. 打开 Chrome Task Manager（Shift + Esc）
2. 查看扩展的内存使用
3. 使用 DevTools Memory Profiler

### Performance 分析
1. 在 DevTools 中打开 Performance 面板
2. 记录操作过程
3. 分析瓶颈

## 🔄 热重载开发

虽然 Chrome Extension 不支持真正的热重载，但可以：

1. **快速重载扩展**：
   - 在 `chrome://extensions/` 点击重载按钮
   - 或使用快捷键：Cmd+R (macOS) / Ctrl+R (Windows/Linux)

2. **自动重载 Content Script**：
   修改代码后刷新网页即可

3. **保持 Qwen 服务器运行**：
   Qwen 服务器不需要重启，只需重载扩展

## 📱 远程调试

如果需要在其他设备上调试：

1. **启用远程调试**：
   ```bash
   google-chrome --remote-debugging-port=9222
   ```

2. **访问调试界面**：
   ```
   http://localhost:9222
   ```

3. **使用 Chrome DevTools Protocol**：
   可以编程控制和调试

## 💡 开发建议

1. **使用 console.log 大量输出日志**
   - 在开发阶段多打日志
   - 生产环境再移除

2. **利用 Chrome Storage API 存储调试信息**
   ```javascript
   chrome.storage.local.set({debug: data});
   ```

3. **创建测试页面**
   - 包含各种测试场景
   - 方便重复测试

4. **使用 Postman 测试 API**
   - 测试与 Qwen 服务器的通信
   - 验证数据格式

## 📚 相关资源

- [Chrome Extension 开发文档](https://developer.chrome.com/docs/extensions/mv3/)
- [Native Messaging 文档](https://developer.chrome.com/docs/apps/nativeMessaging/)
- [Chrome DevTools 文档](https://developer.chrome.com/docs/devtools/)
- [项目 API 参考](./api-reference.md)

## 🆘 获取帮助

如果遇到问题：

1. 查看 [技术细节文档](./technical-details.md)
2. 检查 [API 参考文档](./api-reference.md)
3. 提交 Issue 到 GitHub
4. 查看日志文件寻找错误信息

---

祝调试愉快！🎉