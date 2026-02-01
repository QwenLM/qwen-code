# hangwin/mcp-chrome 源码级集成方案

> ⚠️ 备注：这是历史计划文档，内容可能与当前实现不一致。请优先以 `docs/status/integration-status.md` 与 `docs/design/03-architecture.md` 为准。

## 📋 背景和目标

### 当前状态

**现有架构** (`archive/chrome-extension`):
```
Chrome Extension (React 19)
  ↓ HTTP (127.0.0.1:18765)
Native Host (Node.js HTTP Bridge)
  ↓ ACP (JSON-RPC over stdio)
Browser MCP Server
  ↓ MCP Protocol
Qwen CLI
```
- **通信层数**: 5 层
- **工具数量**: 10 个
- **技术栈**: React 19 + esbuild + Tailwind CSS
- **通信协议**: HTTP + SSE

**目标架构** (基于 hangwin/mcp-chrome):
```
Chrome Extension (React 19 - 保留现有)
  ↓ Native Messaging Protocol (stdio)
Native Server (hangwin - Fastify + MCP SDK)
  ↓ MCP Protocol (StreamableHttp/stdio)
Qwen CLI
```
- **通信层数**: 3 层(简化 40%)
- **工具数量**: 20+ 个(增强 100%)
- **技术栈**: React 19(保留) + hangwin Native Server
- **通信协议**: Native Messaging

### 用户需求确认

✅ **完全采用 hangwin 架构** - Native Messaging 3 层通信
✅ **保留现有技术栈** - React 19 + esbuild(不切换到 Vue 3 + WXT)
✅ **完整复制 hangwin 结构** - monorepo 源码集成
✅ **源码级可定制** - 保留所有源代码以便未来修改

---

## 🏗️ 集成方案设计

### 方案核心思路

**混合集成**：
1. **完整复制** hangwin/mcp-chrome 源码到 `packages/mcp-chrome-integration`
2. **保留** hangwin 的 `native-server` (Fastify + MCP SDK + 20+ 工具)
3. **替换** hangwin 的 Vue Extension 为现有的 React Extension
4. **适配** React Extension 的通信层：从 HTTP → Native Messaging

### 架构对比

| 组件 | 现有实现 | hangwin | 集成后方案 |
|------|---------|---------|-----------|
| **Extension UI** | React 19 | Vue 3 | **保留 React 19** |
| **Extension 构建** | esbuild | WXT | **保留 esbuild** |
| **Extension 通信** | HTTP 18765 | Native Messaging | **切换到 Native Messaging** |
| **Native Server** | 自定义 HTTP Bridge | Fastify + MCP SDK | **使用 hangwin** |
| **MCP 工具** | 10 个 | 20+ 个 | **使用 hangwin 全部** |
| **MCP Transport** | ACP → MCP | StreamableHttp/stdio | **使用 hangwin** |

---

## 📁 目录结构设计

```
packages/mcp-chrome-integration/
├── README.md                          # 集成文档
├── package.json                       # 根 workspace 配置(pnpm)
├── pnpm-workspace.yaml                # workspace 定义
├── tsconfig.json                      # 根 TS 配置
│
├── packages/
│   └── shared/                        # 共享类型库(来自 hangwin)
│       ├── src/
│       │   ├── types.ts               # 消息类型(Native Message)
│       │   ├── tools.ts               # MCP 工具定义(20+ 工具)
│       │   ├── agent-types.ts
│       │   └── ...
│       ├── package.json
│       └── tsconfig.json
│
├── app/
│   ├── chrome-extension/              # Chrome Extension(React - 现有代码适配)
│   │   ├── public/
│   │   │   ├── manifest.json          # Manifest V3(保留)
│   │   │   └── sidepanel.html
│   │   ├── src/
│   │   │   ├── background/
│   │   │   │   └── service-worker.ts  # 🔧 适配 Native Messaging
│   │   │   ├── content/
│   │   │   │   └── content-script.ts  # 保留现有实现
│   │   │   └── sidepanel/
│   │   │       ├── index.tsx          # React 入口(保留)
│   │   │       ├── App.tsx            # 主组件(保留)
│   │   │       ├── hooks/             # custom hooks(保留)
│   │   │       ├── components/        # React 组件(保留)
│   │   │       └── ...
│   │   ├── config/
│   │   │   ├── esbuild.config.js      # 保留现有构建
│   │   │   └── tailwind.config.js
│   │   ├── scripts/
│   │   │   └── dev-watch.js
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── native-server/                 # Native Server(来自 hangwin)
│       ├── src/
│       │   ├── cli.ts                 # CLI 入口(注册 Native Messaging)
│       │   ├── index.ts               # 启动入口
│       │   ├── native-messaging-host.ts  # Native Messaging 协议
│       │   ├── server/                # Fastify HTTP 服务器
│       │   │   ├── index.ts           # 核心服务器
│       │   │   └── routes/            # HTTP 路由
│       │   ├── mcp/                   # MCP 协议实现
│       │   │   ├── mcp-server.ts      # MCP Server 实例
│       │   │   ├── mcp-server-stdio.ts # stdio 传输
│       │   │   └── register-tools.ts  # 工具注册(20+ 工具)
│       │   ├── agent/                 # Agent 服务(可选)
│       │   ├── constant/              # 常量
│       │   └── util/                  # 工具函数
│       ├── package.json
│       └── tsconfig.json
│
├── scripts/
│   ├── install.sh                     # 安装脚本
│   ├── build-all.sh                   # 全量构建
│   └── dev.sh                         # 开发模式
│
└── docs/
    ├── implementation-plan.md         # 本实施方案
    ├── architecture.md                # 架构文档
    ├── migration-from-old.md          # 从旧版迁移
    └── guides/customization.md         # 定制指南
```

---

## 🔧 核心适配任务

### 任务 1: 复制 hangwin 源码

**目标**: 将 `/Users/yiliang/projects/temp/mcp-chrome` 完整复制到 `packages/mcp-chrome-integration`

**操作**:
```bash
# 复制完整源码
cp -r /Users/yiliang/projects/temp/mcp-chrome/app/native-server packages/mcp-chrome-integration/app/
cp -r /Users/yiliang/projects/temp/mcp-chrome/packages/shared packages/mcp-chrome-integration/packages/

# 复制构建配置
cp /Users/yiliang/projects/temp/mcp-chrome/package.json packages/mcp-chrome-integration/
cp /Users/yiliang/projects/temp/mcp-chrome/pnpm-workspace.yaml packages/mcp-chrome-integration/
cp /Users/yiliang/projects/temp/mcp-chrome/tsconfig.json packages/mcp-chrome-integration/
```

**保留文件**:
- ✅ `app/native-server/*` - 完整保留
- ✅ `packages/shared/*` - 完整保留
- ❌ `app/chrome-extension/*` - **不复制**(用现有 React 实现替代)

---

### 任务 2: 迁移 React Extension

**目标**: 将现有 React Extension 复制到新目录，并适配 Native Messaging

**步骤 2.1: 复制现有 Extension**

```bash
# 复制 React Extension 源码
cp -r archive/chrome-extension/src packages/mcp-chrome-integration/app/chrome-extension/
cp -r archive/chrome-extension/public packages/mcp-chrome-integration/app/chrome-extension/
cp -r archive/chrome-extension/config packages/mcp-chrome-integration/app/chrome-extension/
cp -r archive/chrome-extension/scripts packages/mcp-chrome-integration/app/chrome-extension/
cp archive/chrome-extension/package.json packages/mcp-chrome-integration/app/chrome-extension/
cp archive/chrome-extension/tsconfig.json packages/mcp-chrome-integration/app/chrome-extension/
```

**步骤 2.2: 适配 Service Worker 通信层**

**关键文件**: `app/chrome-extension/src/background/service-worker.ts`

**需要修改的部分**:

1. **移除 HTTP 通信代码**:
```typescript
// 删除这些
const BACKEND_URL = 'http://127.0.0.1:18765';
fetch(BACKEND_URL + '/api', { ... });
fetch(BACKEND_URL + '/events');  // SSE
```

2. **添加 Native Messaging 通信**:
```typescript
// 参考 hangwin 的实现
// 文件: /Users/yiliang/projects/temp/mcp-chrome/app/chrome-extension/entrypoints/background/native-host.ts

// 核心代码示例：
let nativePort: chrome.runtime.Port | null = null;
const HOST_NAME = 'com.chromemcp.nativehost';  // 需要与 native-server 注册名一致

function connectToNativeHost() {
  nativePort = chrome.runtime.connectNative(HOST_NAME);

  nativePort.onMessage.addListener((message: NativeMessage) => {
    // 处理来自 native-server 的消息
    handleNativeMessage(message);
  });

  nativePort.onDisconnect.addListener(() => {
    console.error('Native host disconnected:', chrome.runtime.lastError);
    // 自动重连
    setTimeout(connectToNativeHost, 1000);
  });
}

function sendToNativeHost(message: NativeMessage) {
  if (!nativePort) {
    console.error('Native port not connected');
    return;
  }
  nativePort.postMessage(message);
}

// 启动时连接
chrome.runtime.onStartup.addListener(() => {
  connectToNativeHost();
});
```

3. **适配消息类型**:
```typescript
// 导入 hangwin 的消息类型
import { NativeMessageType, type NativeMessage } from '@chrome-mcp/shared/types';

// 工具调用消息
const callToolMessage: NativeMessage = {
  type: NativeMessageType.CALL_TOOL,
  payload: {
    requestId: generateRequestId(),
    toolName: 'chrome_screenshot',
    params: { fullPage: true }
  }
};

sendToNativeHost(callToolMessage);
```

**步骤 2.3: 更新 manifest.json**

**文件**: `app/chrome-extension/public/manifest.json`

```json
{
  "manifest_version": 3,
  "name": "Qwen Code Chrome Integration",
  "version": "2.0.0",
  "permissions": [
    "nativeMessaging",  // 🔧 添加 Native Messaging 权限
    "activeTab",
    "tabs",
    "storage",
    "debugger",
    "webNavigation",
    "scripting",
    "cookies",
    "webRequest",
    "sidePanel"
  ],
  "host_permissions": [
    "<all_urls>"
    // 🔧 移除 http://127.0.0.1:18765/* 权限
  ],
  "background": {
    "service_worker": "background/service-worker.js"
  },
  // ... 其余保持不变
}
```

---

### 任务 3: 配置 Native Messaging

**目标**: 注册 Chrome Native Messaging Host

**步骤 3.1: 配置 native-server CLI**

**文件**: `app/native-server/src/cli.ts` (hangwin 提供)

```typescript
// hangwin 已实现的 CLI 命令
mcp-chrome-bridge register    // 注册 Native Messaging
mcp-chrome-bridge unregister  // 取消注册
mcp-chrome-bridge doctor      // 诊断
```

**步骤 3.2: 注册配置清单**

**生成文件** (macOS):
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json`

```json
{
  "name": "com.chromemcp.nativehost",
  "description": "Qwen Code Chrome MCP Bridge",
  "path": "/path/to/packages/mcp-chrome-integration/app/native-server/dist/cli.js",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://YOUR_EXTENSION_ID/"
  ]
}
```

**步骤 3.3: 构建 native-server**

```bash
cd packages/mcp-chrome-integration/app/native-server
pnpm install
pnpm build

# 注册 Native Messaging
node dist/cli.js register
```

---

### 任务 4: 适配 React UI 组件

**目标**: 更新 React 组件以适应新的消息流

**关键变化**:

1. **移除 HTTP 状态管理**:
   - 删除 `isConnected` HTTP 连接状态
   - 删除 SSE 事件流监听

2. **添加 Native Messaging 状态**:
```typescript
// hooks/useChromeExtension.ts
const [nativeHostConnected, setNativeHostConnected] = useState(false);

useEffect(() => {
  // 监听 background 的连接状态更新
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'NATIVE_HOST_STATUS') {
      setNativeHostConnected(message.data.connected);
    }
  });
}, []);
```

3. **保留现有 UI**:
   - ✅ 所有 React 组件保持不变
   - ✅ Markdown 渲染保持不变
   - ✅ 工具调用展示保持不变
   - ✅ 权限抽屉保持不变

---

### 任务 5: 更新构建系统

**目标**: 配置 monorepo 构建流程

**文件**: `packages/mcp-chrome-integration/package.json`

```json
{
  "name": "@qwen-code/mcp-chrome-integration",
  "version": "2.0.0",
  "private": true,
  "scripts": {
    "build:shared": "pnpm --filter @chrome-mcp/shared build",
    "build:native": "pnpm --filter mcp-chrome-bridge build",
    "build:extension": "pnpm --filter chrome-extension build",
    "build": "pnpm build:shared && pnpm build:native && pnpm build:extension",

    "dev:extension": "pnpm --filter chrome-extension dev",
    "dev:native": "pnpm --filter mcp-chrome-bridge dev",

    "install:native": "cd app/native-server && node dist/cli.js register",
    "uninstall:native": "cd app/native-server && node dist/cli.js unregister"
  },
  "workspaces": [
    "packages/*",
    "app/*"
  ]
}
```

**文件**: `pnpm-workspace.yaml`

```yaml
packages:
  - 'packages/*'
  - 'app/*'
```

---

## 🔄 通信协议对比

### 旧版 HTTP 协议

```typescript
// Extension → Native Host
fetch('http://127.0.0.1:18765/api', {
  method: 'POST',
  body: JSON.stringify({
    type: 'sendMessage',
    data: { text: 'Hello' }
  })
});

// Native Host → Extension (SSE)
fetch('http://127.0.0.1:18765/events')
  .then(response => {
    const reader = response.body.getReader();
    // 读取流...
  });
```

### 新版 Native Messaging 协议

```typescript
// Extension → Native Host
const nativePort = chrome.runtime.connectNative('com.chromemcp.nativehost');

nativePort.postMessage({
  type: NativeMessageType.CALL_TOOL,
  payload: {
    requestId: '123',
    toolName: 'chrome_screenshot',
    params: {}
  }
});

// Native Host → Extension
nativePort.onMessage.addListener((message: NativeMessage) => {
  if (message.type === NativeMessageType.TOOL_RESULT) {
    // 处理结果
  }
});
```

**消息格式** (Native Messaging - stdio):
```
[4 bytes: message length (Little Endian)]
[JSON message body]
```

---

## 📊 工具映射表

### 从现有 10 个工具到 hangwin 20+ 个工具

| 现有工具 | hangwin 对应工具 | 变化 |
|---------|-----------------|------|
| `browser_read_page` | `chrome_read_page` | ✅ 功能增强(accessibility tree) |
| `browser_capture_screenshot` | `chrome_screenshot` | ✅ 新增全页/元素/自定义尺寸 |
| `browser_get_network_logs` | `chrome_network_debugger_start/stop` | ⚠️ 改为两步操作 |
| `browser_get_console_logs` | `chrome_console` | ✅ API 兼容 |
| `browser_click` | `chrome_click_element` | ✅ 支持 ref/selector/coordinates |
| `browser_click_text` | `chrome_click_element` | ✅ 合并 |
| `browser_fill_form` | `chrome_fill_or_select` | ⚠️ 需循环调用 |
| `browser_fill_form_auto` | `chrome_fill_or_select` | ⚠️ 需循环调用 |
| `browser_input_text` | `chrome_fill_or_select` | ✅ 合并 |
| `browser_run_js` | `chrome_inject_script` | ✅ 功能相同 |

**新增工具** (hangwin 独有):
- `search_tabs_content` - AI 语义搜索
- `chrome_history` - 浏览历史
- `chrome_bookmark_search/add/delete` - 书签管理
- `chrome_computer` - 高级交互(hover/drag)
- `chrome_keyboard` - 键盘快捷键
- `get_windows_and_tabs` - 窗口管理
- `chrome_switch_tab` - 切换标签
- `chrome_close_tabs` - 关闭标签
- `chrome_navigate` - 导航
- `chrome_go_back_or_forward` - 前进后退
- ... 等 10+ 个

---

## 🚀 实施步骤

### 阶段 1: 源码复制和初始化(2-3 小时)

1. ✅ 创建 `packages/mcp-chrome-integration` 目录
2. ✅ 复制 hangwin 的 `native-server` 和 `shared` 包
3. ✅ 复制现有 React Extension
4. ✅ 设置 pnpm workspace
5. ✅ 安装依赖

```bash
cd packages/mcp-chrome-integration
pnpm install
```

### 阶段 2: Extension 通信层适配(4-6 小时)

1. 🔧 修改 `service-worker.ts`:
   - 移除 HTTP 通信代码
   - 添加 Native Messaging 通信
   - 适配消息类型(使用 `@chrome-mcp/shared/types`)

2. 🔧 更新 `manifest.json`:
   - 添加 `nativeMessaging` 权限
   - 移除 HTTP host 权限

3. 🔧 适配 React hooks:
   - 更新连接状态管理
   - 适配消息监听

4. ✅ 保留所有 React 组件和 UI(无需修改)

### 阶段 3: Native Server 配置(1-2 小时)

1. ✅ 构建 native-server:
```bash
cd app/native-server
pnpm install
pnpm build
```

2. 🔧 注册 Native Messaging:
```bash
node dist/cli.js register
```

3. ✅ 验证注册:
```bash
node dist/cli.js doctor
```

### 阶段 4: 集成测试(2-3 小时)

1. 🧪 加载 Chrome Extension:
   - 构建 Extension: `pnpm --filter chrome-extension build`
   - 加载到 Chrome: `chrome://extensions/`

2. 🧪 测试 Native Messaging 连接:
   - 查看 Extension Console
   - 确认 `nativePort` 连接成功

3. 🧪 测试工具调用:
   - `chrome_screenshot`
   - `chrome_read_page`
   - `chrome_click_element`

4. 🧪 测试与 Qwen CLI 集成:
   - 配置 Qwen CLI MCP Server
   - 测试端到端流程

### 阶段 5: 文档和清理(1-2 小时)

1. 📝 编写文档:
   - `docs/design/03-architecture.md` - 新架构说明
   - `docs/migration-from-old.md` - 迁移指南
   - `docs/guides/customization.md` - 定制指南

2. 🧹 清理代码:
   - 移除未使用的依赖
   - 移除调试代码
   - 格式化代码

3. ✅ 更新 README

---

## 🔑 关键文件清单

### 需要创建的文件

| 文件路径 | 作用 | 来源 |
|---------|------|------|
| `package.json` | 根 workspace 配置 | 修改 hangwin |
| `pnpm-workspace.yaml` | workspace 定义 | hangwin |
| `app/chrome-extension/src/background/service-worker.ts` | Service Worker(适配 Native Messaging) | 修改现有 |
| `app/chrome-extension/src/background/native-messaging.ts` | Native Messaging 封装 | 新建(参考 hangwin) |
| `scripts/install.sh` | 安装脚本 | 新建 |
| `scripts/build-all.sh` | 构建脚本 | 新建 |
| `docs/design/03-architecture.md` | 架构文档 | 新建 |

### 需要修改的文件

| 文件路径 | 修改内容 |
|---------|---------|
| `app/chrome-extension/public/manifest.json` | 添加 `nativeMessaging` 权限 |
| `app/chrome-extension/src/sidepanel/hooks/useChromeExtension.ts` | 适配 Native Messaging 状态 |
| `app/native-server/src/cli.ts` | 调整注册路径和名称 |

### 完整保留的文件(无需修改)

- ✅ `app/native-server/src/*` - 所有 hangwin native-server 代码
- ✅ `packages/shared/src/*` - 所有共享类型定义
- ✅ `app/chrome-extension/src/sidepanel/*` - 所有 React 组件
- ✅ `app/chrome-extension/src/content/*` - Content Script
- ✅ `app/chrome-extension/config/*` - 构建配置

---

## ⚠️ 风险和注意事项

### 风险 1: Extension ID 变化

**问题**: 重新加载 Extension 会改变 Extension ID

**解决方案**:
1. 首次加载后，记录 Extension ID
2. 更新 Native Messaging 配置清单中的 `allowed_origins`
3. 或使用开发者账号发布私有扩展(Extension ID 固定)

### 风险 2: Native Messaging 权限

**问题**: macOS/Linux 需要文件权限

**解决方案**:
```bash
# 确保 CLI 脚本可执行
chmod +x app/native-server/dist/cli.js

# 确保 Native Messaging 清单可读
chmod 644 ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json
```

### 风险 3: 消息格式不兼容

**问题**: React Extension 现有消息格式与 hangwin 不同

**解决方案**:
1. 使用 `@chrome-mcp/shared/types` 统一消息类型
2. 在 Service Worker 中添加适配层
3. 逐步迁移现有消息格式

### 风险 4: 调试困难

**问题**: Native Messaging 使用 stdio，不如 HTTP 好调试

**解决方案**:
1. hangwin 提供 `doctor` 命令诊断
2. Extension Console 可查看 `chrome.runtime.lastError`
3. native-server 添加详细日志
4. 可选：保留 HTTP 端点用于调试(Fastify 服务器已提供)

---

## 📈 预期收益

### 短期收益

- ✅ **架构简化**: 从 5 层降至 3 层
- ✅ **工具增强**: 从 10 个增至 20+ 个
- ✅ **性能提升**: Native Messaging 比 HTTP 更快
- ✅ **代码质量**: 使用 hangwin 成熟实现

### 中期收益

- ✅ **社区支持**: hangwin 持续更新
- ✅ **可定制**: 完整源码可修改
- ✅ **易维护**: monorepo 结构清晰
- ✅ **易调试**: 统一的类型定义

### 长期收益

- ✅ **功能扩展**: 基于 hangwin 添加新工具
- ✅ **生态集成**: 与其他 MCP 工具集成
- ✅ **技术债务**: 减少内部维护成本

---

## ✅ 验证清单

### 构建验证

- [ ] `pnpm build:shared` 成功
- [ ] `pnpm build:native` 成功
- [ ] `pnpm build:extension` 成功
- [ ] Extension 加载无错误

### 连接验证

- [ ] Native Messaging 连接成功
- [ ] Extension Console 无 `chrome.runtime.lastError`
- [ ] `doctor` 命令检查通过

### 功能验证

- [ ] `chrome_screenshot` 工具可用
- [ ] `chrome_read_page` 工具可用
- [ ] `chrome_click_element` 工具可用
- [ ] `chrome_network_debugger` 工具可用
- [ ] React UI 正常显示

### 集成验证

- [ ] Qwen CLI 连接成功
- [ ] MCP 工具列表正确(20+ 个)
- [ ] 端到端流程测试通过
- [ ] 权限请求流程正常

---

## 🎯 下一步行动

1. **立即开始**: 执行阶段 1(源码复制)
2. **核心任务**: 适配 Extension 通信层(阶段 2)
3. **测试验证**: 端到端功能测试(阶段 4)
4. **文档完善**: 编写迁移和定制文档(阶段 5)

---

## 📚 参考资源

### hangwin 源码位置

- Native Server: `/Users/yiliang/projects/temp/mcp-chrome/app/native-server`
- Shared Types: `/Users/yiliang/projects/temp/mcp-chrome/packages/shared`
- Extension (Vue): `/Users/yiliang/projects/temp/mcp-chrome/app/chrome-extension`

### 现有代码位置

- React Extension: `/Users/yiliang/projects/temp/qwen-code/archive/chrome-extension`
- Native Host: `/Users/yiliang/projects/temp/qwen-code/archive/chrome-extension/native-host`

### 关键参考文件

**Native Messaging 实现** (hangwin):
- `/Users/yiliang/projects/temp/mcp-chrome/app/chrome-extension/entrypoints/background/native-host.ts`
- `/Users/yiliang/projects/temp/mcp-chrome/app/native-server/src/native-messaging-host.ts`

**消息类型定义** (hangwin):
- `/Users/yiliang/projects/temp/mcp-chrome/packages/shared/src/types.ts`

**MCP 工具定义** (hangwin):
- `/Users/yiliang/projects/temp/mcp-chrome/packages/shared/src/tools.ts`

**React Extension 通信** (现有):
- `/Users/yiliang/projects/temp/qwen-code/archive/chrome-extension/src/background/service-worker.js`

---

**版本**: 2.0.0
**更新时间**: 2026-01-16
**状态**: 实施中
