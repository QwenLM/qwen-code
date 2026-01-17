# Fastify Chrome Native Messaging服务

这是一个基于Fastify的TypeScript项目，用于与Chrome扩展进行原生通信。

## 功能特性

- 通过Chrome Native Messaging协议与Chrome扩展进行双向通信
- **支持多浏览器**: Chrome 和 Chromium (包括 Linux、macOS 和 Windows)
- 提供RESTful API服务
- 完全使用TypeScript开发
- 包含完整的测试套件
- 遵循代码质量最佳实践

## 开发环境设置

### 前置条件

- Node.js 20+
- npm 8+ 或 pnpm 8+

### 安装

```bash
git clone https://github.com/your-username/fastify-chrome-native.git
cd fastify-chrome-native
npm install
```

### 开发

1. 本地构建注册native server

```bash
cd app/native-server
npm run dev
```

2. 启动chrome extension

```bash
cd app/chrome-extension
npm run dev
```

### 构建

```bash
npm run build
```

### 注册Native Messaging主机

#### 自动检测并注册所有已安装的浏览器

```bash
mcp-chrome-bridge register --detect
```

#### 注册特定浏览器

```bash
# 仅注册 Chrome
mcp-chrome-bridge register --browser chrome

# 仅注册 Chromium
mcp-chrome-bridge register --browser chromium

# 注册所有支持的浏览器
mcp-chrome-bridge register --browser all
```

#### 全局安装（会自动注册检测到的浏览器）

```bash
npm i -g mcp-chrome-bridge
```

#### 浏览器支持

| 浏览器        | Linux | macOS | Windows |
| ------------- | ----- | ----- | ------- |
| Google Chrome | ✓     | ✓     | ✓       |
| Chromium      | ✓     | ✓     | ✓       |

注册位置：

- **Linux**: `~/.config/[browser-name]/NativeMessagingHosts/`
- **macOS**: `~/Library/Application Support/[Browser]/NativeMessagingHosts/`
- **Windows**: `%APPDATA%\[Browser]\NativeMessagingHosts\`

### 与Chrome扩展集成

以下是Chrome扩展中如何使用此服务的简单示例：

```javascript
// background.js
let nativePort = null;
let serverRunning = false;

// 启动Native Messaging服务
function startServer() {
  if (nativePort) {
    console.log('已连接到Native Messaging主机');
    return;
  }

  try {
    nativePort = chrome.runtime.connectNative('com.yourcompany.fastify_native_host');

    nativePort.onMessage.addListener((message) => {
      console.log('收到Native消息:', message);

      if (message.type === 'started') {
        serverRunning = true;
        console.log(`服务已启动，端口: ${message.payload.port}`);
      } else if (message.type === 'stopped') {
        serverRunning = false;
        console.log('服务已停止');
      } else if (message.type === 'error') {
        console.error('Native错误:', message.payload.message);
      }
    });

    nativePort.onDisconnect.addListener(() => {
      console.log('Native连接断开:', chrome.runtime.lastError);
      nativePort = null;
      serverRunning = false;
    });

    // 启动服务器
    nativePort.postMessage({ type: 'start', payload: { port: 3000 } });
  } catch (error) {
    console.error('启动Native Messaging时出错:', error);
  }
}

// 停止服务器
function stopServer() {
  if (nativePort && serverRunning) {
    nativePort.postMessage({ type: 'stop' });
  }
}

// 测试与服务器的通信
async function testPing() {
  try {
    const response = await fetch('http://localhost:3000/ping');
    const data = await response.json();
    console.log('Ping响应:', data);
    return data;
  } catch (error) {
    console.error('Ping失败:', error);
    return null;
  }
}

// 在扩展启动时连接Native主机
chrome.runtime.onStartup.addListener(startServer);

// 导出供popup或内容脚本使用的API
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startServer') {
    startServer();
    sendResponse({ success: true });
  } else if (message.action === 'stopServer') {
    stopServer();
    sendResponse({ success: true });
  } else if (message.action === 'testPing') {
    testPing().then(sendResponse);
    return true; // 指示我们将异步发送响应
  }
});
```

### 测试

```bash
npm run test
```

### 许可证

MIT
