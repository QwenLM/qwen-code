# Qwen Code MCP Chrome Integration - 实施总结

**日期**: 2026-01-16
**版本**: 2.0.0-alpha
**状态**: 源码集成已完成 80%

---

## ✅ 已完成的工作

### 1. 项目结构搭建

✅ **目录结构创建**

- 创建了完整的 monorepo 结构
- 包含 `packages/shared`（共享类型库）
- 包含 `app/native-server`（Native Server）
- 包含 `app/chrome-extension`（React Extension）

✅ **源码复制**

- ✅ 完整复制 hangwin `native-server`（Fastify + MCP SDK + 20+ 工具）
- ✅ 完整复制 hangwin `shared` 包（消息类型和工具定义）
- ✅ 复制现有 React 19 Extension 源码

### 2. 配置文件

✅ **Workspace 配置**

- ✅ `package.json` - 根 workspace 配置，已适配 Qwen
- ✅ `pnpm-workspace.yaml` - workspace 定义
- ✅ `.prettierrc.json` - 代码格式化配置

✅ **构建脚本**

- ✅ `scripts/build-all.sh` - 全量构建脚本
- ✅ `scripts/install.sh` - 自动化安装脚本

### 3. 文档

✅ **项目文档**

- ✅ `README.md` - 项目介绍和快速开始
- ✅ `docs/status/implementation-plan.md` - 完整的实施方案（来自用户提供）
- ✅ `docs/status/implementation-summary.md` - 本实施总结

---

## ⚠️ 待完成的工作

### 1. Extension 通信层适配（关键任务）

**当前状态**: React Extension 仍使用 HTTP 通信

**需要完成**:

#### 任务 1.1: 创建 Native Messaging 通信层

**文件**: `app/chrome-extension/src/background/native-messaging.ts`（新建）

参考 hangwin 的实现：`/Users/yiliang/projects/temp/mcp-chrome/app/chrome-extension/entrypoints/background/native-host.ts`

核心代码结构：

```typescript
import { NativeMessageType } from '@chrome-mcp/shared';

let nativePort: chrome.runtime.Port | null = null;
const HOST_NAME = 'com.chromemcp.nativehost';

export function connectNativeHost(port: number = 12306): boolean {
  if (nativePort) return true;

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);

    nativePort.onMessage.addListener(async (message) => {
      // 处理来自 native-server 的消息
      if (message.type === NativeMessageType.CALL_TOOL && message.requestId) {
        // 调用浏览器工具
        const result = await handleCallTool(message.payload);
        nativePort?.postMessage({
          responseToRequestId: message.requestId,
          payload: { status: 'success', data: result },
        });
      }
      // ... 其他消息类型处理
    });

    nativePort.onDisconnect.addListener(() => {
      console.warn('Native host disconnected', chrome.runtime.lastError);
      nativePort = null;
      // 自动重连逻辑
    });

    nativePort.postMessage({
      type: NativeMessageType.START,
      payload: { port },
    });
    return true;
  } catch (error) {
    console.error('Failed to connect native host', error);
    return false;
  }
}
```

#### 任务 1.2: 适配 service-worker.js

**文件**: `app/chrome-extension/src/background/service-worker.js`

**需要修改**:

1. **移除 HTTP 通信代码**（约 200 行）:
   - 删除 `BACKEND_URL = 'http://127.0.0.1:18765'`
   - 删除所有 `fetch()` 调用
   - 删除 `EventSource` SSE 监听
   - 删除 `callBackend()`, `connectToNativeHost()`, `sendToNativeHost()`, `startEventPolling()` 等函数

2. **导入 Native Messaging 模块**:

```javascript
import { connectNativeHost, sendToNativeHost } from './native-messaging';
import { NativeMessageType } from '@chrome-mcp/shared/types';
```

3. **适配消息处理**:
   - 保留所有浏览器工具函数（`getBrowserPageContent()`, `getBrowserScreenshot()` 等）
   - 修改 `handleBrowserRequest()` 以接收 Native Messaging 消息
   - 更新 `chrome.runtime.onMessage` 监听器

#### 任务 1.3: 更新 manifest.json

**文件**: `app/chrome-extension/public/manifest.json`

**需要添加**:

```json
{
  "permissions": [
    "nativeMessaging", // 🔧 添加此权限
    "activeTab",
    "tabs"
    // ... 保留现有权限
  ],
  "host_permissions": [
    "<all_urls>"
    // 🔧 移除 http://127.0.0.1:18765/* 权限（如果有）
  ]
}
```

### 2. React Hooks 适配（可选优化）

**文件**: `app/chrome-extension/src/sidepanel/hooks/useChromeExtension.ts`（如果存在）

**需要修改**:

- 移除 HTTP 连接状态（`isConnected`）
- 添加 Native Messaging 连接状态
- 移除 SSE 事件流监听
- 适配消息监听

### 3. 类型定义适配

**需要在 Extension 中导入 hangwin 的类型**:

在 `app/chrome-extension/tsconfig.json` 中添加路径映射：

```json
{
  "compilerOptions": {
    "paths": {
      "@chrome-mcp/shared/*": ["../../packages/shared/src/*"]
    }
  }
}
```

---

## 🚀 快速开始（当前可用功能）

### 构建 Native Server

```bash
cd packages/mcp-chrome-integration

# 安装依赖
pnpm install

# 构建 shared 包
cd packages/shared
pnpm build
cd ../..

# 构建 native-server
cd app/native-server
pnpm build
cd ../..

# 注册 Native Messaging
cd app/native-server
node dist/cli.js register
node dist/cli.js doctor
cd ../..
```

### 当前可测试的功能

✅ **Native Server 独立运行**:

```bash
cd app/native-server
node dist/index.js
```

Native Server 会启动 Fastify 服务器（端口 12306）并等待 MCP 连接。

✅ **MCP 工具列表**:
Native Server 已包含 20+ 个工具，但需要通过 Qwen CLI 调用才能触发浏览器工具。

⚠️ **Extension 无法工作**:
由于 Extension 还在使用 HTTP 通信，暂时无法与 Native Server 连接。

---

## 📝 下一步实施建议

### 建议 1: 最小可行版本（MVP）

**目标**: 快速验证 Native Messaging 通信

**步骤**:

1. 创建简化的 `native-messaging.ts`（仅基本连接和消息转发）
2. 修改 `service-worker.js`：
   - 注释掉 HTTP 通信代码
   - 导入 `native-messaging.ts`
   - 测试连接

3. 更新 `manifest.json` 添加 `nativeMessaging` 权限

4. 测试：
   - 加载 Extension
   - 检查 Service Worker Console
   - 验证 Native Messaging 连接

### 建议 2: 渐进式迁移

**目标**: 保留现有功能，逐步迁移

**步骤**:

1. **阶段 1**: 并行运行（HTTP + Native Messaging）
   - 保留 HTTP 通信作为备用
   - 添加 Native Messaging 作为新选项
   - 通过配置切换

2. **阶段 2**: 逐个工具迁移
   - 先迁移简单工具（如 `chrome_screenshot`）
   - 逐步迁移复杂工具（如 `chrome_network_debugger`）

3. **阶段 3**: 完全移除 HTTP
   - 确认所有工具都能通过 Native Messaging 工作
   - 移除 HTTP 相关代码

### 建议 3: 参考 hangwin 的 Vue Extension

**目标**: 直接借鉴成熟实现

**方法**:

1. 研究 hangwin 的 Vue Extension 如何处理消息
2. 提取核心逻辑，转换为 React 实现
3. 复用 hangwin 的错误处理和重连逻辑

---

## 🔍 关键文件参考

### 需要研究的 hangwin 文件

| 文件             | 用途                  | 位置                                                                                                 |
| ---------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| `native-host.ts` | Native Messaging 实现 | `/Users/yiliang/projects/temp/mcp-chrome/app/chrome-extension/entrypoints/background/native-host.ts` |
| `types.ts`       | 消息类型定义          | `/Users/yiliang/projects/temp/mcp-chrome/packages/shared/src/types.ts`                               |
| `tools.ts`       | MCP 工具定义          | `/Users/yiliang/projects/temp/mcp-chrome/packages/shared/src/tools.ts`                               |

### 需要修改的现有文件

| 文件                    | 修改内容                         | 优先级 |
| ----------------------- | -------------------------------- | ------ |
| `service-worker.js`     | 移除 HTTP，添加 Native Messaging | 🔴 高  |
| `manifest.json`         | 添加 `nativeMessaging` 权限      | 🔴 高  |
| `native-messaging.ts`   | 新建 Native Messaging 封装       | 🔴 高  |
| `useChromeExtension.ts` | 适配新的连接状态                 | 🟡 中  |
| `tsconfig.json`         | 添加路径映射                     | 🟡 中  |

---

## 🎯 工作量估算

| 任务                       | 预计时间       | 难度 |
| -------------------------- | -------------- | ---- |
| 创建 `native-messaging.ts` | 2-3 小时       | 中   |
| 适配 `service-worker.js`   | 4-6 小时       | 高   |
| 更新 `manifest.json`       | 15 分钟        | 低   |
| 适配 React hooks           | 1-2 小时       | 中   |
| 测试和调试                 | 2-3 小时       | 中   |
| **总计**                   | **10-15 小时** | -    |

---

## ✅ 验证清单

完成后需验证：

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
- [ ] MCP 工具列表正确（20+ 个）
- [ ] 端到端流程测试通过
- [ ] 权限请求流程正常

---

## 📞 支持和资源

- **实施方案**: `docs/status/implementation-plan.md`
- **架构文档**: 见 README.md 的架构对比部分
- **hangwin 源码**: `/Users/yiliang/projects/temp/mcp-chrome`
- **现有 Extension**: `/Users/yiliang/projects/temp/qwen-code/archive/chrome-extension`

---

**最后更新**: 2026-01-16
**下次里程碑**: 完成 Extension 通信层适配，实现 MVP
