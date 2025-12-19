# Chrome Qwen Bridge API 参考文档

## Chrome Extension APIs

### Background Service Worker

#### 消息类型

##### 连接管理

**CONNECT**
```javascript
// 请求
{
  type: 'CONNECT'
}

// 响应
{
  success: boolean,
  status?: string,      // 'connected' | 'running' | 'stopped'
  error?: string
}
```

**GET_STATUS**
```javascript
// 请求
{
  type: 'GET_STATUS'
}

// 响应
{
  connected: boolean,
  status: string        // 'disconnected' | 'connecting' | 'connected' | 'running'
}
```

##### Qwen CLI 控制

**START_QWEN_CLI**
```javascript
// 请求
{
  type: 'START_QWEN_CLI',
  config?: {
    mcpServers?: string[],    // MCP 服务器列表
    httpPort?: number         // HTTP 端口，默认 8080
  }
}

// 响应
{
  success: boolean,
  data?: {
    status: string,
    pid: number,
    port: number
  },
  error?: string
}
```

**STOP_QWEN_CLI**
```javascript
// 请求
{
  type: 'STOP_QWEN_CLI'
}

// 响应
{
  success: boolean,
  data?: string,
  error?: string
}
```

##### 数据操作

**EXTRACT_PAGE_DATA**
```javascript
// 请求
{
  type: 'EXTRACT_PAGE_DATA'
}

// 响应
{
  success: boolean,
  data?: {
    url: string,
    title: string,
    domain: string,
    path: string,
    timestamp: string,
    meta: object,
    content: {
      text: string,
      html: string,
      markdown: string
    },
    links: Array<{
      text: string,
      href: string,
      target: string,
      isExternal: boolean
    }>,
    images: Array<{
      src: string,
      alt: string,
      title: string,
      width: number,
      height: number
    }>,
    forms: Array<{
      action: string,
      method: string,
      fields: Array<object>
    }>,
    consoleLogs: Array<{
      type: string,
      message: string,
      timestamp: string,
      stack: string
    }>,
    performance: {
      loadTime: number,
      domReady: number,
      firstPaint: number
    }
  },
  error?: string
}
```

**CAPTURE_SCREENSHOT**
```javascript
// 请求
{
  type: 'CAPTURE_SCREENSHOT'
}

// 响应
{
  success: boolean,
  data?: string,        // Base64 编码的图片
  error?: string
}
```

**GET_NETWORK_LOGS**
```javascript
// 请求
{
  type: 'GET_NETWORK_LOGS'
}

// 响应
{
  success: boolean,
  data?: Array<{
    method: string,
    params: object,
    timestamp: number
  }>,
  error?: string
}
```

**SEND_TO_QWEN**
```javascript
// 请求
{
  type: 'SEND_TO_QWEN',
  action: string,       // 'analyze_page' | 'analyze_screenshot' | 'ai_analyze' | 'process_text'
  data: any
}

// 响应
{
  success: boolean,
  data?: any,          // Qwen CLI 返回的数据
  error?: string
}
```

### Content Script APIs

#### 消息类型

**EXTRACT_DATA**
```javascript
// 请求
{
  type: 'EXTRACT_DATA'
}

// 响应
{
  success: boolean,
  data: {
    // 同 EXTRACT_PAGE_DATA 的 data 字段
  }
}
```

**GET_SELECTED_TEXT**
```javascript
// 请求
{
  type: 'GET_SELECTED_TEXT'
}

// 响应
{
  success: boolean,
  data: string          // 选中的文本
}
```

**HIGHLIGHT_ELEMENT**
```javascript
// 请求
{
  type: 'HIGHLIGHT_ELEMENT',
  selector: string      // CSS 选择器
}

// 响应
{
  success: boolean
}
```

**EXECUTE_CODE**
```javascript
// 请求
{
  type: 'EXECUTE_CODE',
  code: string         // JavaScript 代码
}

// 响应
{
  success: boolean,
  data?: any,          // 执行结果
  error?: string
}
```

**SCROLL_TO**
```javascript
// 请求
{
  type: 'SCROLL_TO',
  x?: number,
  y?: number,
  smooth?: boolean
}

// 响应
{
  success: boolean
}
```

#### 工具函数

**extractPageData()**
```javascript
function extractPageData(): PageData

interface PageData {
  url: string;
  title: string;
  domain: string;
  path: string;
  timestamp: string;
  meta: Record<string, string>;
  content: {
    text: string;
    html: string;
    markdown: string;
  };
  links: Link[];
  images: Image[];
  forms: Form[];
  consoleLogs: ConsoleLog[];
  performance: PerformanceMetrics;
}
```

**extractTextContent(element)**
```javascript
function extractTextContent(element: HTMLElement): string
// 提取元素的纯文本内容，移除脚本和样式
```

**htmlToMarkdown(element)**
```javascript
function htmlToMarkdown(element: HTMLElement): string
// 将 HTML 转换为 Markdown 格式
```

**getSelectedText()**
```javascript
function getSelectedText(): string
// 获取用户选中的文本
```

**highlightElement(selector)**
```javascript
function highlightElement(selector: string): boolean
// 高亮指定的元素，3秒后自动移除
```

**executeInPageContext(code)**
```javascript
async function executeInPageContext(code: string): Promise<any>
// 在页面上下文中执行 JavaScript 代码
```

## Native Host APIs

### 消息协议

#### 请求消息格式

```typescript
interface RequestMessage {
  id?: number;          // 请求 ID，用于匹配响应
  type: string;         // 消息类型
  action?: string;      // 具体动作
  data?: any;          // 携带的数据
  config?: object;     // 配置选项
}
```

#### 响应消息格式

```typescript
interface ResponseMessage {
  id?: number;          // 对应的请求 ID
  type: 'response' | 'event' | 'handshake_response';
  data?: any;          // 响应数据
  error?: string;      // 错误信息
  success?: boolean;   // 操作是否成功
}
```

### 消息类型

**handshake**
```javascript
// 请求
{
  type: 'handshake',
  version: string      // 扩展版本
}

// 响应
{
  type: 'handshake_response',
  version: string,
  qwenInstalled: boolean,
  qwenStatus: string,
  capabilities: string[]
}
```

**start_qwen**
```javascript
// 请求
{
  type: 'start_qwen',
  config?: {
    mcpServers?: string[],
    httpPort?: number
  }
}

// 响应
{
  type: 'response',
  id: number,
  success: boolean,
  data?: {
    status: string,
    pid: number,
    capabilities: string[]
  },
  error?: string
}
```

**stop_qwen**
```javascript
// 请求
{
  type: 'stop_qwen'
}

// 响应
{
  type: 'response',
  id: number,
  success: boolean,
  data?: string,
  error?: string
}
```

**qwen_request**
```javascript
// 请求
{
  type: 'qwen_request',
  action: string,
  data: any,
  config?: object
}

// 响应
{
  type: 'response',
  id: number,
  data?: any,
  error?: string
}
```

**get_status**
```javascript
// 请求
{
  type: 'get_status'
}

// 响应
{
  type: 'response',
  id: number,
  data: {
    qwenInstalled: boolean,
    qwenStatus: string,
    qwenPid: number | null,
    capabilities: string[]
  }
}
```

### 事件消息

**qwen_output**
```javascript
{
  type: 'event',
  data: {
    type: 'qwen_output',
    content: string      // stdout 输出
  }
}
```

**qwen_error**
```javascript
{
  type: 'event',
  data: {
    type: 'qwen_error',
    content: string      // stderr 输出
  }
}
```

**qwen_stopped**
```javascript
{
  type: 'event',
  data: {
    type: 'qwen_stopped',
    code: number         // 退出码
  }
}
```

## Qwen CLI 集成

### HTTP API 端点

**POST /api/process**
```javascript
// 请求
{
  action: string,
  data: any
}

// 响应
{
  success: boolean,
  result?: any,
  error?: string
}
```

### 支持的动作

| 动作 | 描述 | 输入数据 | 返回数据 |
|------|------|---------|---------|
| `analyze_page` | 分析网页内容 | PageData | 分析结果 |
| `analyze_screenshot` | 分析截图 | { screenshot: string, url: string } | 图片分析结果 |
| `ai_analyze` | AI 深度分析 | { pageData: PageData, prompt: string } | AI 分析结果 |
| `process_text` | 处理文本 | { text: string, context: string } | 处理后的文本 |

## Chrome Storage API

### 配置存储

```javascript
// 保存配置
await chrome.storage.local.set({
  mcpServers: 'chrome-devtools,playwright',
  httpPort: 8080,
  autoConnect: true
});

// 读取配置
const settings = await chrome.storage.local.get([
  'mcpServers',
  'httpPort',
  'autoConnect'
]);
```

### 存储结构

```typescript
interface StorageSchema {
  mcpServers?: string;        // 逗号分隔的服务器列表
  httpPort?: number;          // HTTP 端口
  autoConnect?: boolean;      // 是否自动连接
  lastConnected?: string;     // 最后连接时间
  extensionVersion?: string;  // 扩展版本
}
```

## 错误代码

| 错误代码 | 描述 | 处理建议 |
|----------|------|----------|
| `NATIVE_HOST_NOT_FOUND` | Native Host 未安装 | 运行安装脚本 |
| `QWEN_NOT_INSTALLED` | Qwen CLI 未安装 | 安装 Qwen CLI |
| `CONNECTION_FAILED` | 连接失败 | 检查 Native Host |
| `PROCESS_START_FAILED` | 进程启动失败 | 检查 Qwen CLI 配置 |
| `REQUEST_TIMEOUT` | 请求超时 | 重试请求 |
| `INVALID_MESSAGE` | 消息格式错误 | 检查消息格式 |
| `PERMISSION_DENIED` | 权限不足 | 检查扩展权限 |
| `PORT_IN_USE` | 端口被占用 | 更换端口 |

## 使用示例

### 基本使用流程

```javascript
// 1. 连接到 Native Host
const connectResponse = await chrome.runtime.sendMessage({
  type: 'CONNECT'
});

if (!connectResponse.success) {
  console.error('连接失败:', connectResponse.error);
  return;
}

// 2. 启动 Qwen CLI
const startResponse = await chrome.runtime.sendMessage({
  type: 'START_QWEN_CLI',
  config: {
    mcpServers: ['chrome-devtools-mcp'],
    httpPort: 8080
  }
});

// 3. 提取页面数据
const pageDataResponse = await chrome.runtime.sendMessage({
  type: 'EXTRACT_PAGE_DATA'
});

// 4. 发送给 Qwen 分析
const analysisResponse = await chrome.runtime.sendMessage({
  type: 'SEND_TO_QWEN',
  action: 'analyze_page',
  data: pageDataResponse.data
});

console.log('分析结果:', analysisResponse.data);
```

### 高级功能示例

```javascript
// 监听 Qwen 事件
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'QWEN_EVENT') {
    console.log('Qwen 事件:', message.event);

    switch (message.event.type) {
      case 'qwen_output':
        // 处理输出
        updateUI(message.event.content);
        break;
      case 'qwen_error':
        // 处理错误
        showError(message.event.content);
        break;
      case 'qwen_stopped':
        // 处理停止
        handleStop(message.event.code);
        break;
    }
  }
});
```

## 版本兼容性

| 组件 | 最低版本 | 推荐版本 |
|------|---------|---------|
| Chrome | 88 | 最新稳定版 |
| Node.js | 14.0.0 | 18+ |
| Qwen CLI | 1.0.0 | 最新版 |
| Manifest | V3 | V3 |

## 性能指标

| 操作 | 预期延迟 | 超时时间 |
|------|---------|---------|
| Native Host 连接 | <100ms | 5s |
| Qwen CLI 启动 | <2s | 10s |
| 页面数据提取 | <500ms | 5s |
| 截图捕获 | <1s | 5s |
| AI 分析请求 | <5s | 30s |
| 消息往返 | <50ms | 1s |