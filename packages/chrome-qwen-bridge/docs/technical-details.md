# Chrome Qwen Bridge 技术细节文档

## Native Messaging 协议详解

### 协议规范

Chrome 的 Native Messaging 使用简单的基于消息长度的协议：

```
[4字节长度][JSON消息内容]
```

- **长度前缀**：32位无符号整数，小端字节序
- **消息内容**：UTF-8 编码的 JSON 字符串
- **最大消息大小**：1MB (Chrome 限制)

### 实现细节

#### 消息发送实现

```javascript
function sendMessage(message) {
  // 1. 将消息对象转换为 JSON 字符串
  const jsonString = JSON.stringify(message);

  // 2. 转换为 Buffer
  const buffer = Buffer.from(jsonString, 'utf8');

  // 3. 创建 4 字节的长度前缀
  const lengthBuffer = Buffer.allocUnsafe(4);
  lengthBuffer.writeUInt32LE(buffer.length, 0);

  // 4. 写入 stdout
  process.stdout.write(lengthBuffer);
  process.stdout.write(buffer);
}
```

#### 消息接收实现

```javascript
function readMessages() {
  let messageLength = null;
  let chunks = [];

  process.stdin.on('readable', () => {
    let chunk;

    while ((chunk = process.stdin.read()) !== null) {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      // 第一步：读取消息长度
      if (messageLength === null) {
        if (buffer.length >= 4) {
          messageLength = buffer.readUInt32LE(0);
          chunks = [buffer.slice(4)];
        }
      }

      // 第二步：读取消息内容
      if (messageLength !== null) {
        const fullBuffer = Buffer.concat(chunks);

        if (fullBuffer.length >= messageLength) {
          const messageBuffer = fullBuffer.slice(0, messageLength);
          const message = JSON.parse(messageBuffer.toString('utf8'));

          // 重置状态，准备读取下一条消息
          chunks = [fullBuffer.slice(messageLength)];
          messageLength = null;

          // 处理消息
          handleMessage(message);
        }
      }
    }
  });
}
```

### 错误处理

1. **JSON 解析错误**：发送错误响应
2. **长度溢出**：拒绝超过 1MB 的消息
3. **流关闭**：优雅退出进程

## Chrome Extension API 使用

### 权限说明

| 权限 | 用途 | 风险级别 |
|------|------|---------|
| `nativeMessaging` | 与 Native Host 通信 | 高 |
| `activeTab` | 访问当前标签页 | 中 |
| `tabs` | 管理标签页 | 中 |
| `storage` | 存储配置 | 低 |
| `debugger` | 网络监控 | 高 |
| `scripting` | 注入脚本 | 高 |
| `webNavigation` | 页面导航事件 | 中 |
| `cookies` | Cookie 访问 | 中 |

### Content Script 注入

```javascript
// manifest.json 配置
{
  "content_scripts": [
    {
      "matches": ["<all_urls>"],  // 所有网页
      "js": ["content/content-script.js"],
      "run_at": "document_idle"   // DOM 加载完成后
    }
  ]
}
```

### Service Worker 生命周期

Service Worker 在 Manifest V3 中替代了 Background Page：

```javascript
// 扩展安装/更新时
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // 首次安装
  } else if (details.reason === 'update') {
    // 更新
  }
});

// Service Worker 可能会被系统终止
// 使用 chrome.storage 持久化状态
```

## 数据提取算法

### DOM 内容提取策略

```javascript
function extractPageData() {
  // 1. 优先查找语义化标签
  const mainContent = document.querySelector(
    'article, main, [role="main"], #content, .content'
  ) || document.body;

  // 2. 克隆节点避免修改原始 DOM
  const clone = mainContent.cloneNode(true);

  // 3. 移除干扰元素
  const removeSelectors = [
    'script', 'style', 'noscript', 'iframe',
    'nav', 'header', 'footer', '.ad', '#ads'
  ];

  removeSelectors.forEach(selector => {
    clone.querySelectorAll(selector).forEach(el => el.remove());
  });

  // 4. 提取文本内容
  return clone.textContent.trim();
}
```

### HTML 转 Markdown 算法

```javascript
function htmlToMarkdown(element) {
  const rules = {
    'h1': (node) => `# ${node.textContent}\n`,
    'h2': (node) => `## ${node.textContent}\n`,
    'h3': (node) => `### ${node.textContent}\n`,
    'p': (node) => `${node.textContent}\n\n`,
    'a': (node) => `[${node.textContent}](${node.href})`,
    'img': (node) => `![${node.alt}](${node.src})`,
    'ul,ol': (node) => processLi",
    'code': (node) => `\`${node.textContent}\``,
    'pre': (node) => `\`\`\`\n${node.textContent}\n\`\`\``,
    'blockquote': (node) => `> ${node.textContent}`,
    'strong,b': (node) => `**${node.textContent}**`,
    'em,i': (node) => `*${node.textContent}*`
  };

  // 递归遍历 DOM 树
  // 应用转换规则
  // 返回 Markdown 字符串
}
```

### Console 日志拦截

```javascript
// 保存原始 console 方法
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info
};

// 拦截并记录
['log', 'error', 'warn', 'info'].forEach(method => {
  console[method] = function(...args) {
    // 记录日志
    consoleLogs.push({
      type: method,
      message: args.map(formatArg).join(' '),
      timestamp: Date.now(),
      stack: new Error().stack
    });

    // 调用原始方法
    originalConsole[method].apply(console, args);
  };
});
```

## 进程管理详解

### Qwen CLI 启动流程

```javascript
async function startQwenCli(config) {
  // 1. 构建命令参数
  const commands = [];

  // 2. 添加 MCP 服务器
  for (const server of config.mcpServers) {
    commands.push(
      `qwen mcp add --transport http ${server} ` +
      `http://localhost:${config.port}/mcp/${server}`
    );
  }

  // 3. 启动服务器
  commands.push(`qwen server --port ${config.port}`);

  // 4. 使用 shell 执行复合命令
  const process = spawn(commands.join(' && '), {
    shell: true,          // 使用 shell 执行
    detached: false,      // 不分离进程
    windowsHide: true,    // Windows 下隐藏窗口
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // 5. 监控输出
  process.stdout.on('data', handleOutput);
  process.stderr.on('data', handleError);
  process.on('exit', handleExit);

  return process;
}
```

### 进程清理

```javascript
// 优雅关闭
function gracefulShutdown() {
  if (qwenProcess) {
    // 发送 SIGTERM
    qwenProcess.kill('SIGTERM');

    // 等待进程退出
    setTimeout(() => {
      if (!qwenProcess.killed) {
        // 强制结束
        qwenProcess.kill('SIGKILL');
      }
    }, 5000);
  }
}

// 注册清理处理器
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('exit', gracefulShutdown);
```

## 性能优化技巧

### 内存管理

1. **内容大小限制**
```javascript
const MAX_TEXT_LENGTH = 50000;  // 50KB
const MAX_HTML_LENGTH = 100000; // 100KB
const MAX_LOGS = 100;           // 最多 100 条日志
```

2. **防止内存泄漏**
```javascript
// 使用 WeakMap 存储 DOM 引用
const elementCache = new WeakMap();

// 定期清理
setInterval(() => {
  consoleLogs.splice(0, consoleLogs.length - MAX_LOGS);
}, 60000);
```

### 响应时间优化

1. **懒加载**
```javascript
// 只在需要时提取数据
async function getPageData() {
  if (!pageDataCache) {
    pageDataCache = await extractPageData();
  }
  return pageDataCache;
}
```

2. **批处理**
```javascript
// 合并多个请求
const requestQueue = [];
const flushQueue = debounce(() => {
  sendBatchRequest(requestQueue);
  requestQueue.length = 0;
}, 100);
```

## 安全最佳实践

### 输入验证

```javascript
function validateMessage(message) {
  // 类型检查
  if (typeof message !== 'object') {
    throw new Error('Invalid message type');
  }

  // 必填字段
  if (!message.type) {
    throw new Error('Missing message type');
  }

  // 大小限制
  const size = JSON.stringify(message).length;
  if (size > 1024 * 1024) {  // 1MB
    throw new Error('Message too large');
  }

  return true;
}
```

### XSS 防护

```javascript
// 避免直接插入 HTML
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// 使用 textContent 而非 innerHTML
element.textContent = userInput;  // 安全
// element.innerHTML = userInput;  // 危险！
```

### CSP (Content Security Policy)

```javascript
// manifest.json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'none'"
  }
}
```

## 调试技巧

### Chrome Extension 调试

1. **Background Service Worker**
   - 打开 `chrome://extensions/`
   - 点击 "Service Worker" 链接
   - 使用 Chrome DevTools

2. **Content Script**
   - 在网页中打开 DevTools
   - 在 Console 中查看日志

3. **Popup**
   - 右键点击插件图标
   - 选择 "检查弹出内容"

### Native Host 调试

```javascript
// 日志文件
const logFile = path.join(os.tmpdir(), 'qwen-bridge-host.log');

function log(message) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
}

// 使用日志调试
log(`Received message: ${JSON.stringify(message)}`);
```

### 常见问题排查

| 问题 | 可能原因 | 解决方法 |
|------|---------|---------|
| Native Host 不响应 | 路径配置错误 | 检查 manifest.json 中的路径 |
| 消息解析失败 | JSON 格式错误 | 验证消息格式 |
| 权限错误 | 权限不足 | 检查 manifest 权限配置 |
| 进程启动失败 | Qwen CLI 未安装 | 安装 Qwen CLI |
| 内存溢出 | 数据量过大 | 添加大小限制 |

## 跨平台兼容性

### 平台差异处理

```javascript
// 检测操作系统
const platform = process.platform;

// 平台特定路径
const paths = {
  darwin: {  // macOS
    manifest: '~/Library/Application Support/Google/Chrome/NativeMessagingHosts/',
    log: '/tmp/'
  },
  win32: {   // Windows
    manifest: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\',
    log: process.env.TEMP
  },
  linux: {
    manifest: '~/.config/google-chrome/NativeMessagingHosts/',
    log: '/tmp/'
  }
};

// 使用平台特定配置
const config = paths[platform];
```

### Shell 命令兼容性

```javascript
// Windows 使用 .bat 文件
if (platform === 'win32') {
  // host.bat 包装器
  spawn('cmd.exe', ['/c', 'host.bat']);
} else {
  // 直接执行
  spawn('node', ['host.js']);
}
```

## 性能基准

### 数据提取性能

| 操作 | 平均耗时 | 内存占用 |
|------|---------|----------|
| DOM 提取 | ~50ms | ~2MB |
| Markdown 转换 | ~30ms | ~1MB |
| 截图捕获 | ~100ms | ~5MB |
| Console 日志 | <1ms | ~100KB |

### 通信延迟

| 通道 | 延迟 |
|------|------|
| Content ↔ Background | <1ms |
| Extension ↔ Native Host | ~5ms |
| Native Host ↔ Qwen CLI | ~10ms |
| 端到端 | ~20ms |

## 未来技术方向

### WebSocket 支持

```javascript
// 升级为 WebSocket 连接
class WebSocketBridge {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.setupEventHandlers();
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  onMessage(callback) {
    this.ws.on('message', (data) => {
      callback(JSON.parse(data));
    });
  }
}
```

### Service Worker 后台任务

```javascript
// 使用 Alarm API 定期任务
chrome.alarms.create('sync', { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync') {
    syncData();
  }
});
```

### Web Workers 并行处理

```javascript
// 在 Web Worker 中处理大量数据
const worker = new Worker('processor.js');

worker.postMessage({ cmd: 'process', data: largeData });

worker.onmessage = (e) => {
  const result = e.data;
  // 处理结果
};
```