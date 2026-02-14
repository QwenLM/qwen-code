# Chrome MCP Integration - 设计对比与实现

> **版本**: 2.0.0 | **最后更新**: 2026-02-08

本文档详细对比当前实现与开源 mcp-chrome 插件的差异，并说明实现原理。

---

## 📊 与开源 mcp-chrome 的对比

### 核心差异总结

| 维度                 | mcp-chrome (hangwin)     | 本项目 (mcp-chrome-integration)            |
| -------------------- | ------------------------ | ------------------------------------------ |
| **架构基础**         | 基于 hangwin/mcp-chrome  | 基于 hangwin/mcp-chrome + 深度定制         |
| **Extension 实现**   | 独立 Extension           | ✅ 完整 Side Panel Chat UI (React 19)      |
| **Native Messaging** | ✅ 支持                  | ✅ 完整实现                                |
| **ACP 集成**         | ❌ 无                    | ✅ 与 Qwen CLI 直接集成                    |
| **工具数量**         | 27 个基础工具            | ✅ 27 个工具 + 源码可定制                  |
| **通信方式**         | Extension → Native → MCP | ✅ Extension → Native → MCP/ACP → Qwen CLI |
| **Side Panel**       | ❌ 无聊天界面            | ✅ 完整聊天 UI + 流式传输 + 工具可视化     |
| **维护性**           | 社区维护                 | ✅ Fork + 本地定制                         |

---

## 🎯 主要差异点

### 差异 1: Side Panel Chat UI（最大差异）

**mcp-chrome (hangwin)**:

- 无 Side Panel 聊天界面
- 仅通过 MCP Protocol 被动接收指令
- 用户必须通过外部客户端（如 Claude Desktop）调用

**本项目**:

```typescript
// app/chrome-extension/src/sidepanel/App.tsx
import { ChatInterface } from '@qwen-code/webui';

// 完整的聊天界面
const handleSubmit = async (text: string) => {
  // 发送消息到 background
  await vscode.postMessage({
    type: 'sendMessage',
    data: { text },
  });
};

// 接收流式响应
useEffect(() => {
  const handleMessage = (event: MessageEvent) => {
    switch (event.data.type) {
      case 'streamStart':
        // 开始新消息
        break;
      case 'streamChunk':
        // 接收文本块
        break;
      case 'toolCall':
        // 工具调用可视化
        break;
    }
  };
}, []);
```

**优势**:

- ✅ 用户可以直接在 Chrome 扩展中与 AI 对话
- ✅ 实时看到工具调用过程
- ✅ 无需切换到外部应用
- ✅ 支持流式传输，响应更快

---

### 差异 2: ACP 协议集成

**mcp-chrome (hangwin)**:

- 仅实现 MCP Protocol
- 需要外部 MCP Client 调用

**本项目**:

```typescript
// app/native-server/src/native-messaging-host.ts
import { AcpClient } from '@qwen-code/acp';

// 同时支持 Native Messaging 和 ACP
class NativeMessagingHost {
  private acpClient: AcpClient;

  async handleUiRequest(request: UiRequest) {
    // 路由 UI 请求到 Qwen CLI
    const response = await this.acpClient.sendPrompt({
      type: 'acp_prompt',
      text: request.message,
    });

    // 返回流式响应到 Side Panel
    return response;
  }
}
```

**优势**:

- ✅ Side Panel 可以直接与 Qwen CLI 通信
- ✅ 无需手动配置 MCP Client
- ✅ 支持双向流式通信

---

### 差异 3: 工具定义方式

**mcp-chrome (hangwin)**:

```typescript
// 使用 @modelcontextprotocol/sdk
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const server = new McpServer({
  name: 'chrome-mcp',
  version: '1.0.0',
});

server.tool('chrome_screenshot', async (params) => {
  // 实现...
});
```

**本项目**:

```typescript
// app/native-server/src/shared/tools.ts
export const TOOL_SCHEMAS = [
  {
    name: 'chrome_screenshot',
    description: '页面截图（推荐优先使用 chrome_computer 的 screenshot 操作）',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '截图文件名' },
        selector: { type: 'string', description: '截取特定元素' },
        fullPage: { type: 'boolean', default: true },
      },
    },
  },
  // ... 27 个工具
];

// 与 background 通信实现
async function executeToolViaBackground(toolName: string, params: any) {
  return await sendMessageToBackground({
    type: 'CALL_TOOL',
    toolName,
    params,
  });
}
```

**差异**:

- ✅ 集中式工具定义（所有工具在一个文件）
- ✅ 更易于维护和修改
- ✅ 工具执行通过 Native Messaging 路由到 Extension

---

### 差异 4: 通信架构

**mcp-chrome (hangwin)**:

```
Extension → Native Messaging → MCP Server → External Client
```

**本项目**:

```
┌─────────────────────────────────────────────────────────┐
│ Extension                                                │
│  Side Panel → sendMessage → Background (Service Worker) │
└───────────────────────┬─────────────────────────────────┘
                        │
                 Native Messaging (stdio)
                        │
┌───────────────────────▼─────────────────────────────────┐
│ Native Server                                            │
│  ┌─────────────────┐      ┌───────────────────────┐    │
│  │ UI Request      │      │ MCP Server            │    │
│  │ Router          │──────│ (27 tools)            │    │
│  │ (ACP Client)    │      │                       │    │
│  └─────────────────┘      └───────────────────────┘    │
└───────────────────────┬─────────────────────────────────┘
                        │
                  MCP Protocol (stdio)
                        │
┌───────────────────────▼─────────────────────────────────┐
│ Qwen CLI                                                 │
└─────────────────────────────────────────────────────────┘
```

**本项目特点**:

1. **双路径通信**:
   - 路径 A: Side Panel → Native Server → Qwen CLI（聊天模式）
   - 路径 B: Qwen CLI → Native Server → Extension（工具调用）

2. **UI Request Router**:

```typescript
// app/chrome-extension/src/background/ui-request-router.ts
export async function routeUiRequest(
  request: UiRequest,
  nativeMessaging: NativeMessaging,
) {
  if (request.type === 'sendMessage') {
    // 路由聊天消息到 Qwen CLI
    const response = await nativeMessaging.sendMessageWithResponse({
      type: 'acp_prompt',
      text: request.data.text,
    });

    // 流式返回给 Side Panel
    return { handled: true, response };
  }
}
```

---

## 🔧 实现原理详解

### 1. Native Messaging 实现

**Chrome Manifest 配置**:

```json
// app/chrome-extension/public/manifest.json
{
  "manifest_version": 3,
  "name": "Chrome MCP Integration",
  "permissions": [
    "nativeMessaging",
    "activeTab",
    "tabs",
    "debugger",
    "webNavigation"
  ],
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  }
}
```

**Native Messaging Host 配置**:

```json
// ~/.../NativeMessagingHosts/com.chromemcp.nativehost.json
{
  "name": "com.chromemcp.nativehost",
  "description": "Node.js Host for Browser Bridge Extension",
  "path": "/path/to/native-server/dist/run_host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
}
```

**通信流程**:

```typescript
// Extension Side
chrome.runtime
  .connectNative('com.chromemcp.nativehost')
  .onMessage.addListener((message) => {
    console.log('Received from native:', message);
  });

// Native Host Side (Node.js)
process.stdin.on('data', (chunk) => {
  const message = parseNativeMessage(chunk);
  const response = handleMessage(message);
  sendNativeMessage(response);
});
```

---

### 2. MCP Server 实现

**基于 @modelcontextprotocol/sdk**:

```typescript
// app/native-server/src/mcp/mcp-server-stdio.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server(
  {
    name: 'chrome-mcp',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// 注册所有工具
TOOL_SCHEMAS.forEach((tool) => {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === tool.name) {
      // 执行工具
      const result = await executeToolViaBackground(
        tool.name,
        request.params.arguments,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  });
});

// 启动 stdio 传输
const transport = new StdioServerTransport();
await server.connect(transport);
```

---

### 3. Service Worker 工具路由

**工具执行流程**:

```typescript
// app/chrome-extension/src/background/tool-router.ts
import { executeBrowserTool } from './browser-tool-executors';

export async function routeToolCall(toolName: string, params: any) {
  // 路由到实际执行器
  switch (toolName) {
    case 'chrome_screenshot':
      return await captureScreenshot(params);

    case 'chrome_click_element':
      return await clickElement(params);

    case 'chrome_network_capture':
      return await captureNetwork(params);

    // ... 其他 27 个工具
  }
}

// app/chrome-extension/src/background/browser-tool-executors.ts
async function captureScreenshot(params: ScreenshotParams) {
  const tab = await getCurrentTab(params.tabId);

  if (params.fullPage) {
    // 全页截图
    return await captureFullPageScreenshot(tab.id);
  } else {
    // 视口截图
    const dataUrl = await chrome.tabs.captureVisibleTab();
    return { screenshot: dataUrl };
  }
}
```

---

### 4. Side Panel 实现

**React 19 Chat 界面**:

```typescript
// app/chrome-extension/src/sidepanel/App.tsx
import { ChatInterface } from '@qwen-code/webui';
import { useChromeExtension } from './hooks/useChromeExtension';

export function App() {
  const { vscode } = useChromeExtension();
  const [messages, setMessages] = useState<Message[]>([]);

  const handleSubmit = useCallback(async (text: string) => {
    // 添加用户消息
    setMessages(prev => [...prev, {
      role: 'user',
      content: text,
      timestamp: Date.now()
    }]);

    // 发送到 background
    await vscode.postMessage({
      type: 'sendMessage',
      data: { text }
    });
  }, [vscode]);

  useEffect(() => {
    // 监听来自 background 的响应
    const handleMessage = (event: MessageEvent) => {
      switch (event.data.type) {
        case 'streamChunk':
          // 更新 AI 消息
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last.role === 'assistant') {
              return [...prev.slice(0, -1), {
                ...last,
                content: last.content + event.data.chunk
              }];
            }
          });
          break;

        case 'toolCall':
          // 显示工具调用
          setMessages(prev => [...prev, {
            role: 'tool',
            toolName: event.data.toolName,
            params: event.data.params
          }]);
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return <ChatInterface messages={messages} onSubmit={handleSubmit} />;
}
```

**Chrome Extension 适配器**:

```typescript
// app/chrome-extension/src/sidepanel/hooks/useVSCode.ts
export function useChromeExtension() {
  return {
    postMessage: async (message: unknown) => {
      // 使用 Chrome API 代替 VSCode API
      return chrome.runtime.sendMessage(message);
    },

    onDidReceiveMessage: (handler: (message: any) => void) => {
      chrome.runtime.onMessage.addListener(handler);
    },
  };
}
```

---

### 5. 网络捕获实现（关键差异）

**使用 Chrome Debugger API 捕获响应体**:

```typescript
// app/chrome-extension/src/background/browser-network-tools.ts
export async function captureNetworkWithResponseBody(
  params: NetworkCaptureParams,
) {
  const tabId = params.tabId || (await getCurrentTab()).id;

  // 启用 Debugger
  await chrome.debugger.attach({ tabId }, '1.3');

  // 启用网络域
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');

  const requests: NetworkRequest[] = [];

  // 监听网络事件
  const handleEvent = (source: any, method: string, params: any) => {
    if (source.tabId !== tabId) return;

    switch (method) {
      case 'Network.requestWillBeSent':
        requests.push({
          requestId: params.requestId,
          url: params.request.url,
          method: params.request.method,
          headers: params.request.headers,
        });
        break;

      case 'Network.responseReceived':
        const req = requests.find((r) => r.requestId === params.requestId);
        if (req) {
          req.statusCode = params.response.status;
          req.responseHeaders = params.response.headers;
        }
        break;

      case 'Network.loadingFinished':
        // 获取响应体
        chrome.debugger
          .sendCommand({ tabId }, 'Network.getResponseBody', {
            requestId: params.requestId,
          })
          .then(({ body }) => {
            const req = requests.find((r) => r.requestId === params.requestId);
            if (req) req.responseBody = body;
          });
        break;
    }
  };

  chrome.debugger.onEvent.addListener(handleEvent);

  // 等待捕获完成
  await new Promise((resolve) =>
    setTimeout(resolve, params.maxCaptureTime || 5000),
  );

  // 清理
  chrome.debugger.detach({ tabId });

  return { requests };
}
```

**与 hangwin/mcp-chrome 的差异**:

- ✅ 完整捕获响应体（包括 Document、XHR、Fetch）
- ✅ 支持 WebSocket 消息捕获
- ✅ 可配置捕获范围（静态资源、特定 URL 模式）

---

## 🎨 代码组织差异

### hangwin/mcp-chrome 结构

```
mcp-chrome/
├── src/
│   ├── index.ts          # MCP Server 入口
│   ├── browser/          # Chrome API 封装
│   └── tools/            # 27 个工具实现
└── package.json
```

### 本项目结构

```
mcp-chrome-integration/
├── app/
│   ├── chrome-extension/         # 完整 Chrome Extension
│   │   ├── src/
│   │   │   ├── background/       # Service Worker + 工具执行
│   │   │   ├── content/          # Content Scripts
│   │   │   ├── sidepanel/        # React Chat UI
│   │   │   └── platform/         # Chrome 适配层
│   │   └── public/
│   │       └── manifest.json
│   │
│   └── native-server/            # Native Messaging Host + MCP Server
│       ├── src/
│       │   ├── native-messaging-host.ts  # Native Messaging 入口
│       │   ├── mcp/                      # MCP Server 实现
│       │   ├── shared/                   # 共享工具定义
│       │   └── cli.js                    # 注册工具
│       └── dist/
│           ├── index.js          # Native Host 可执行文件
│           ├── run_host.sh       # Shell 包装器
│           └── mcp/
│               └── mcp-server-stdio.js  # MCP Server
│
└── scripts/                      # 用户安装脚本
    ├── install.sh
    ├── update-extension-id.sh
    └── diagnose.sh
```

**组织优势**:

- ✅ Extension 和 Native Server 分离，职责清晰
- ✅ 用户脚本独立，易于安装
- ✅ 工具定义集中化（shared/tools.ts）

---

## 📊 性能对比

| 指标           | hangwin/mcp-chrome | 本项目                 |
| -------------- | ------------------ | ---------------------- |
| 工具响应时间   | 1-3 秒             | 1-3 秒（相同）         |
| 网络捕获速度   | 快                 | 稍慢（因捕获响应体）   |
| 内存占用       | 低                 | 中（因 Side Panel UI） |
| Extension 大小 | ~500KB             | ~2MB（含 React UI）    |

---

## 🔑 关键实现细节

### 1. Extension ID 动态配置

**问题**: 开发模式下 Extension ID 会变化

**解决**:

```bash
# scripts/update-extension-id.sh
EXTENSION_ID=$1
CONFIG_FILE="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json"

# 更新配置文件
jq --arg id "$EXTENSION_ID" '.allowed_origins = ["chrome-extension://\($id)/"]' \
  "$CONFIG_FILE" > "$CONFIG_FILE.tmp"
mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
```

---

### 2. 工具执行超时处理

```typescript
async function executeToolWithTimeout(
  toolName: string,
  params: any,
  timeout = 30000,
) {
  return Promise.race([
    routeToolCall(toolName, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Tool execution timeout')), timeout),
    ),
  ]);
}
```

---

### 3. 元素定位容错

```typescript
async function clickElement(params: ClickParams) {
  // 优先使用 ref
  if (params.ref) {
    return await clickByRef(params.ref);
  }

  // 其次使用选择器
  if (params.selector) {
    try {
      return await clickBySelector(params.selector);
    } catch (e) {
      // 如果失败，建议使用 chrome_read_page
      throw new Error(
        'Element not found. Suggestion: Use chrome_read_page to get element refs.',
      );
    }
  }

  // 最后使用坐标
  if (params.coordinates) {
    return await clickByCoordinates(params.coordinates);
  }
}
```

---

## 🎯 总结

### 与 hangwin/mcp-chrome 的关系

**本项目 = hangwin/mcp-chrome 核心 + 重大增强**

**保留**:

- ✅ 27 个 chrome\_\* 工具定义
- ✅ Native Messaging 架构
- ✅ MCP Protocol 实现

**增强**:

- ✅ 完整的 Side Panel Chat UI
- ✅ ACP 协议集成（与 Qwen CLI 直接通信）
- ✅ 流式传输支持
- ✅ 工具调用可视化
- ✅ 用户友好的安装脚本
- ✅ 诊断和故障排查工具

**定制**:

- ✅ 工具定义集中化
- ✅ Chrome 适配层（兼容 VSCode API）
- ✅ 网络捕获增强（响应体、WebSocket）

---

**文档版本**: 2.0.0
**最后更新**: 2026-02-08
**维护者**: Qwen Code Team
