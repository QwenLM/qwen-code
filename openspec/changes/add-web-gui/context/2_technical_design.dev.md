# Qwen Code Web GUI - 技术设计文档

## 1. 设计概述

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         packages/web-app                             │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────┐      ┌──────────────────────────────────┐ │
│  │   Server (Express)   │      │     Client (React + Vite)        │ │
│  ├──────────────────────┤      ├──────────────────────────────────┤ │
│  │ routes/              │      │ App.tsx                          │ │
│  │   sessions.ts        │◄────►│ components/                      │ │
│  │   config.ts          │ HTTP │   Sidebar.tsx                    │ │
│  ├──────────────────────┤      │   ChatArea.tsx                   │ │
│  │ websocket/           │      │   SettingsDialog.tsx             │ │
│  │   handler.ts         │◄────►│ hooks/                           │ │
│  │   sessionRunner.ts   │  WS  │   useWebSocket.ts                │ │
│  └──────────┬───────────┘      │   useSession.ts                  │ │
│             │                  └──────────────────────────────────┘ │
└─────────────┼───────────────────────────────────────────────────────┘
              │
              │ 调用 Core API
              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      @qwen-code/qwen-code-core                       │
├─────────────────────────────────────────────────────────────────────┤
│  SessionService    │  ChatRecordingService  │  Config  │  Storage   │
└─────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    ~/.qwen/<project_hash>/chats/                     │
│                         <sessionId>.jsonl                            │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 技术选型

| 组件 | 技术 | 理由 |
|------|------|------|
| HTTP 服务 | Express.js | 轻量、成熟、Core 包已使用 |
| WebSocket | ws | 与 Core 包一致 |
| 前端框架 | React 18+ | 复用 webui 组件 |
| 构建工具 | Vite | 快速开发、HMR 支持 |
| 样式 | Tailwind CSS | 与 webui 一致 |
| 静态文件 | 内嵌构建产物 | 简化部署 |

---

## 2. 文件改动清单

### 2.1 新增文件

```
packages/web-app/                      # 新包
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
├── index.html
├── src/
│   ├── server/
│   │   ├── index.ts                   # 服务入口
│   │   ├── app.ts                     # Express 应用
│   │   ├── routes/
│   │   │   ├── sessions.ts            # Session API
│   │   │   └── config.ts              # 配置 API
│   │   └── websocket/
│   │       ├── handler.ts             # WS 连接处理
│   │       └── sessionRunner.ts       # Session 运行器
│   ├── client/
│   │   ├── main.tsx                   # 前端入口
│   │   ├── App.tsx                    # 根组件
│   │   ├── components/
│   │   │   ├── Sidebar.tsx            # 侧边栏
│   │   │   ├── ChatArea.tsx           # 聊天区域
│   │   │   ├── Header.tsx             # 顶部标题栏
│   │   │   └── SettingsDialog.tsx     # 设置对话框
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts        # WebSocket Hook
│   │   │   ├── useSessions.ts         # Sessions Hook
│   │   │   └── useMessages.ts         # Messages Hook
│   │   └── styles/
│   │       └── global.css             # 全局样式
│   └── shared/
│       └── types.ts                   # 共享类型定义
```

### 2.2 修改文件

```
packages/cli/src/
├── ui/commands/
│   └── webCommand.ts                  # 新增: /web 命令
├── services/
│   └── BuiltinCommandLoader.ts        # 修改: 注册 webCommand
```

---

## 3. 详细设计

### 3.1 `/web` 命令实现

**文件**: `packages/cli/src/ui/commands/webCommand.ts`

```typescript
import type {
  SlashCommand,
  CommandContext,
  MessageActionReturn,
  StreamMessagesActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const webCommand: SlashCommand = {
  name: 'web',
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('Start Web GUI server');
  },
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<StreamMessagesActionReturn> => {
    // 解析参数
    const parsed = parseWebArgs(args);
    
    // 返回流式消息，在后台启动服务器
    return {
      type: 'stream_messages',
      messages: startWebServer(parsed, context),
    };
  },
};

interface WebArgs {
  port: number;
  host: string;
  open: boolean;
}

function parseWebArgs(args: string): WebArgs {
  const parts = args.trim().split(/\s+/);
  const result: WebArgs = {
    port: 5494,
    host: '127.0.0.1',
    open: true,
  };
  
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '--port' && parts[i + 1]) {
      result.port = parseInt(parts[i + 1], 10);
      i++;
    } else if (parts[i] === '--host' && parts[i + 1]) {
      result.host = parts[i + 1];
      i++;
    } else if (parts[i] === '--no-open') {
      result.open = false;
    }
  }
  
  return result;
}

async function* startWebServer(
  args: WebArgs,
  context: CommandContext,
): AsyncGenerator<{ messageType: 'info' | 'error'; content: string }> {
  yield { messageType: 'info', content: t('Starting Web GUI server...') };
  
  try {
    // 动态导入 web-app 包
    const { startServer } = await import('@qwen-code/web-app/server');
    
    const actualPort = await startServer({
      port: args.port,
      host: args.host,
      config: context.services.config,
    });
    
    const url = `http://${args.host}:${actualPort}`;
    yield { 
      messageType: 'info', 
      content: t('Web GUI running at {{url}}', { url }),
    };
    
    if (args.open) {
      const open = (await import('open')).default;
      await open(url);
      yield { messageType: 'info', content: t('Browser opened') };
    }
  } catch (error) {
    yield { 
      messageType: 'error', 
      content: t('Failed to start server: {{error}}', { 
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
```

**注册命令** - 修改 `BuiltinCommandLoader.ts`:

```typescript
// 添加导入
import { webCommand } from '../ui/commands/webCommand.js';

// 在 loadCommands 中添加
const allDefinitions: Array<SlashCommand | null> = [
  // ... 其他命令
  webCommand,
  // ...
];
```

---

### 3.2 Server 模块

#### 3.2.1 服务入口

**文件**: `packages/web-app/src/server/index.ts`

```typescript
import { createApp } from './app.js';
import { WebSocketServer } from 'ws';
import type { Config } from '@qwen-code/qwen-code-core';
import { findAvailablePort } from './utils/port.js';

export interface ServerOptions {
  port: number;
  host: string;
  config: Config | null;
}

export async function startServer(options: ServerOptions): Promise<number> {
  const { port, host, config } = options;
  
  // 查找可用端口
  const actualPort = await findAvailablePort(host, port);
  
  // 创建 Express 应用
  const app = createApp(config);
  
  // 启动 HTTP 服务
  const server = app.listen(actualPort, host, () => {
    console.log(`Web GUI server listening on http://${host}:${actualPort}`);
  });
  
  // 创建 WebSocket 服务
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss, config);
  
  return actualPort;
}
```

#### 3.2.2 Express 应用

**文件**: `packages/web-app/src/server/app.ts`

```typescript
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Config } from '@qwen-code/qwen-code-core';
import { sessionsRouter } from './routes/sessions.js';
import { configRouter } from './routes/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(config: Config | null) {
  const app = express();
  
  app.use(express.json());
  
  // CORS for development
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost:5173');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });
  
  // API 路由
  app.use('/api/sessions', sessionsRouter(config));
  app.use('/api/config', configRouter(config));
  
  // 健康检查
  app.get('/healthz', (req, res) => {
    res.json({ status: 'ok' });
  });
  
  // 静态文件 (生产环境)
  const staticDir = path.join(__dirname, '../../dist/client');
  app.use(express.static(staticDir));
  app.get('*', (req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
  
  return app;
}
```

#### 3.2.3 Sessions API

**文件**: `packages/web-app/src/server/routes/sessions.ts`

参考 Core 包中的 `SessionService`:

```typescript
import { Router } from 'express';
import type { Config, SessionService } from '@qwen-code/qwen-code-core';

export function sessionsRouter(config: Config | null) {
  const router = Router();
  
  // 复用 Core 的 SessionService
  // 参考: packages/core/src/services/sessionService.ts
  
  // GET /api/sessions - 列出所有 sessions
  router.get('/', async (req, res) => {
    if (!config) {
      return res.status(500).json({ error: 'Config not available' });
    }
    
    const sessionService = config.getSessionService();
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    
    // 复用 SessionService.listSessions()
    const result = await sessionService.listSessions(limit, offset);
    
    res.json({
      sessions: result.sessions.map(s => ({
        id: s.sessionId,
        title: s.title || 'Untitled',
        lastUpdated: s.lastUpdated,
        startTime: s.startTime,
      })),
      hasMore: result.hasMore,
    });
  });
  
  // POST /api/sessions - 创建新 session
  router.post('/', async (req, res) => {
    if (!config) {
      return res.status(500).json({ error: 'Config not available' });
    }
    
    const sessionId = config.startNewSession();
    
    res.json({
      id: sessionId,
      title: 'New Session',
      lastUpdated: new Date().toISOString(),
    });
  });
  
  // GET /api/sessions/:id - 获取 session 详情
  router.get('/:id', async (req, res) => {
    if (!config) {
      return res.status(500).json({ error: 'Config not available' });
    }
    
    const sessionService = config.getSessionService();
    const session = await sessionService.loadSession(req.params.id);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    res.json({
      id: session.conversation.sessionId,
      title: session.conversation.title || 'Untitled',
      messages: session.conversation.messages,
      lastUpdated: session.conversation.lastUpdated,
    });
  });
  
  return router;
}
```

#### 3.2.4 WebSocket Handler

**文件**: `packages/web-app/src/server/websocket/handler.ts`

参考 Core 包中的消息格式:

```typescript
import type { WebSocket, WebSocketServer } from 'ws';
import type { Config } from '@qwen-code/qwen-code-core';
import { SessionRunner } from './sessionRunner.js';

// WebSocket 消息类型
// 参考: packages/core/src/services/chatRecordingService.ts ChatRecord
interface WSMessage {
  type: string;
  sessionId?: string;
  content?: string;
  [key: string]: unknown;
}

export function setupWebSocket(wss: WebSocketServer, config: Config | null) {
  const sessionRunners = new Map<string, SessionRunner>();
  
  wss.on('connection', (ws: WebSocket) => {
    let currentSessionId: string | null = null;
    
    ws.on('message', async (data) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());
        
        switch (message.type) {
          case 'join_session':
            currentSessionId = message.sessionId || null;
            if (currentSessionId) {
              let runner = sessionRunners.get(currentSessionId);
              if (!runner) {
                runner = new SessionRunner(currentSessionId, config);
                sessionRunners.set(currentSessionId, runner);
              }
              runner.addClient(ws);
              
              // 发送历史消息
              const history = await runner.getHistory();
              ws.send(JSON.stringify({ type: 'history', messages: history }));
            }
            break;
            
          case 'user_message':
            if (currentSessionId) {
              const runner = sessionRunners.get(currentSessionId);
              if (runner) {
                await runner.handleUserMessage(message.content || '');
              }
            }
            break;
            
          case 'cancel':
            if (currentSessionId) {
              const runner = sessionRunners.get(currentSessionId);
              if (runner) {
                runner.cancel();
              }
            }
            break;
            
          case 'permission_response':
            if (currentSessionId) {
              const runner = sessionRunners.get(currentSessionId);
              if (runner) {
                runner.handlePermissionResponse(message);
              }
            }
            break;
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });
    
    ws.on('close', () => {
      if (currentSessionId) {
        const runner = sessionRunners.get(currentSessionId);
        if (runner) {
          runner.removeClient(ws);
        }
      }
    });
  });
}
```

---

### 3.3 Client 模块

#### 3.3.1 应用入口

**文件**: `packages/web-app/src/client/App.tsx`

```typescript
import { useState, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { SettingsDialog } from './components/SettingsDialog';
import { useSessions } from './hooks/useSessions';
import { useWebSocket } from './hooks/useWebSocket';
import { useMessages } from './hooks/useMessages';

// 复用 webui 的样式
import '@qwen-code/webui/styles.css';

export function App() {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  
  const { sessions, createSession, refreshSessions, isLoading } = useSessions();
  const { messages, addMessage, setMessages } = useMessages();
  const { 
    send, 
    isConnected, 
    isStreaming,
    permissionRequest,
    respondToPermission,
  } = useWebSocket(currentSessionId, {
    onMessage: (msg) => addMessage(msg),
    onHistory: (history) => setMessages(history),
  });
  
  const handleSelectSession = useCallback((sessionId: string) => {
    setCurrentSessionId(sessionId);
    setMessages([]);
  }, [setMessages]);
  
  const handleCreateSession = useCallback(async () => {
    const newSession = await createSession();
    if (newSession) {
      setCurrentSessionId(newSession.id);
      setMessages([]);
    }
  }, [createSession, setMessages]);
  
  const handleSendMessage = useCallback((content: string) => {
    if (!currentSessionId || !content.trim()) return;
    send({ type: 'user_message', content });
  }, [currentSessionId, send]);
  
  const handleCancel = useCallback(() => {
    send({ type: 'cancel' });
  }, [send]);
  
  return (
    <div className="flex h-screen bg-[var(--app-primary-background)]">
      {/* 侧边栏 - 复用 SessionSelector 逻辑 */}
      <Sidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onCreateSession={handleCreateSession}
        onRefresh={refreshSessions}
        onOpenSettings={() => setSettingsOpen(true)}
        isLoading={isLoading}
      />
      
      {/* 主内容区 */}
      <ChatArea
        sessionId={currentSessionId}
        messages={messages}
        isConnected={isConnected}
        isStreaming={isStreaming}
        permissionRequest={permissionRequest}
        onSendMessage={handleSendMessage}
        onCancel={handleCancel}
        onPermissionResponse={respondToPermission}
      />
      
      {/* 设置对话框 */}
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
```

#### 3.3.2 Sidebar 组件

**文件**: `packages/web-app/src/client/components/Sidebar.tsx`

复用 `@qwen-code/webui` 的 `groupSessionsByDate` 和样式:

```typescript
import { useState, useMemo, Fragment } from 'react';
import { 
  groupSessionsByDate, 
  getTimeAgo,
  SearchIcon,
  PlusIcon,
  RefreshIcon,
} from '@qwen-code/webui';
import type { Session } from '../../shared/types';

interface SidebarProps {
  sessions: Session[];
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  isLoading: boolean;
}

export function Sidebar({
  sessions,
  currentSessionId,
  onSelectSession,
  onCreateSession,
  onRefresh,
  onOpenSettings,
  isLoading,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  
  // 搜索过滤
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const query = searchQuery.toLowerCase();
    return sessions.filter(s => 
      s.title.toLowerCase().includes(query)
    );
  }, [sessions, searchQuery]);
  
  // 按日期分组 - 复用 webui 工具函数
  const groupedSessions = useMemo(() => {
    return groupSessionsByDate(filteredSessions);
  }, [filteredSessions]);
  
  return (
    <aside className="w-64 border-r border-[var(--app-border)] flex flex-col">
      {/* 顶部标识 */}
      <div className="p-4 border-b border-[var(--app-border)]">
        <h1 className="text-lg font-semibold">Qwen Code</h1>
        <span className="text-xs text-[var(--app-secondary-foreground)]">Web GUI</span>
      </div>
      
      {/* Sessions 标题栏 */}
      <div className="px-4 py-2 flex items-center justify-between">
        <span className="text-sm font-medium text-[var(--app-secondary-foreground)]">
          SESSIONS
        </span>
        <div className="flex gap-1">
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="p-1 rounded hover:bg-[var(--app-list-hover-background)]"
            title="Refresh"
          >
            <RefreshIcon className={isLoading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={onCreateSession}
            className="p-1 rounded hover:bg-[var(--app-list-hover-background)]"
            title="New Session"
          >
            <PlusIcon />
          </button>
        </div>
      </div>
      
      {/* 搜索框 */}
      <div className="px-4 py-2">
        <div className="flex items-center gap-2 px-2 py-1 rounded bg-[var(--app-input-background)]">
          <SearchIcon className="w-4 h-4 opacity-50" />
          <input
            type="text"
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent border-none outline-none text-sm"
          />
        </div>
      </div>
      
      {/* Session 列表 */}
      <div className="flex-1 overflow-y-auto px-2">
        {groupedSessions.map((group) => (
          <Fragment key={group.label}>
            <div className="px-2 py-1 text-xs font-medium text-[var(--app-secondary-foreground)] opacity-60 mt-2">
              {group.label}
            </div>
            {group.sessions.map((session) => (
              <button
                key={session.id}
                onClick={() => onSelectSession(session.id)}
                className={`w-full text-left px-2 py-2 rounded text-sm flex justify-between items-center
                  ${session.id === currentSessionId 
                    ? 'bg-[var(--app-list-active-background)] font-medium' 
                    : 'hover:bg-[var(--app-list-hover-background)]'
                  }`}
              >
                <span className="truncate flex-1">{session.title}</span>
                <span className="text-xs opacity-60 ml-2">
                  {getTimeAgo(session.lastUpdated)}
                </span>
              </button>
            ))}
          </Fragment>
        ))}
      </div>
      
      {/* 底部工具栏 */}
      <div className="p-4 border-t border-[var(--app-border)] flex justify-between">
        <button 
          onClick={onOpenSettings}
          className="p-2 rounded hover:bg-[var(--app-list-hover-background)]"
          title="Settings"
        >
          ⚙️
        </button>
      </div>
    </aside>
  );
}
```

#### 3.3.3 ChatArea 组件

**文件**: `packages/web-app/src/client/components/ChatArea.tsx`

复用 `@qwen-code/webui` 的消息组件:

```typescript
import { useRef, useCallback } from 'react';
import {
  ChatViewer,
  InputForm,
  PermissionDrawer,
  getEditModeIcon,
} from '@qwen-code/webui';
import type { ChatViewerHandle, ChatMessageData } from '@qwen-code/webui';
import type { Message, PermissionRequest } from '../../shared/types';

interface ChatAreaProps {
  sessionId: string | null;
  messages: Message[];
  isConnected: boolean;
  isStreaming: boolean;
  permissionRequest: PermissionRequest | null;
  onSendMessage: (content: string) => void;
  onCancel: () => void;
  onPermissionResponse: (allow: boolean, scope: string) => void;
}

export function ChatArea({
  sessionId,
  messages,
  isConnected,
  isStreaming,
  permissionRequest,
  onSendMessage,
  onCancel,
  onPermissionResponse,
}: ChatAreaProps) {
  const chatViewerRef = useRef<ChatViewerHandle>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const [inputText, setInputText] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  
  // 转换消息格式以适配 ChatViewer
  const chatMessages: ChatMessageData[] = useMemo(() => {
    return messages.map((msg) => ({
      uuid: msg.uuid,
      parentUuid: msg.parentUuid,
      timestamp: msg.timestamp,
      type: msg.type,
      message: msg.message,
      toolCall: msg.toolCall,
    }));
  }, [messages]);
  
  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isStreaming) return;
    onSendMessage(inputText);
    setInputText('');
  }, [inputText, isStreaming, onSendMessage]);
  
  // 空状态
  if (!sessionId) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="text-center text-[var(--app-secondary-foreground)]">
          <div className="text-4xl mb-4">💬</div>
          <p>Select a session or create a new one</p>
        </div>
      </main>
    );
  }
  
  return (
    <main className="flex-1 flex flex-col relative">
      {/* 顶部标题栏 */}
      <header className="px-4 py-2 border-b border-[var(--app-border)] flex items-center justify-between">
        <div>
          <h2 className="font-medium">Session</h2>
          <span className="text-xs text-[var(--app-secondary-foreground)]">
            {sessionId.slice(0, 8)}...
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!isConnected && (
            <span className="text-xs text-red-500">Disconnected</span>
          )}
        </div>
      </header>
      
      {/* 消息列表 - 复用 ChatViewer */}
      <div className="flex-1 overflow-hidden">
        <ChatViewer
          ref={chatViewerRef}
          messages={chatMessages}
          autoScroll={true}
          theme="auto"
          emptyMessage="Start a conversation..."
        />
      </div>
      
      {/* 输入区域 - 复用 InputForm */}
      <InputForm
        inputText={inputText}
        inputFieldRef={inputRef}
        isStreaming={isStreaming}
        isWaitingForResponse={isStreaming}
        isComposing={isComposing}
        editModeInfo={{
          label: 'Code',
          title: 'Code mode',
          icon: getEditModeIcon('edit'),
        }}
        thinkingEnabled={false}
        activeFileName={null}
        activeSelection={null}
        skipAutoActiveContext={false}
        contextUsage={null}
        onInputChange={setInputText}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        onKeyDown={() => {}}
        onSubmit={handleSubmit}
        onCancel={onCancel}
        onToggleEditMode={() => {}}
        onToggleThinking={() => {}}
        onToggleSkipAutoActiveContext={() => {}}
        onShowCommandMenu={() => {}}
        onAttachContext={() => {}}
        completionIsOpen={false}
      />
      
      {/* 权限请求 - 复用 PermissionDrawer */}
      {permissionRequest && (
        <PermissionDrawer
          toolCall={{
            name: permissionRequest.operation,
            args: permissionRequest.args,
          }}
          options={[
            { id: 'once', label: 'Allow once' },
            { id: 'session', label: 'Allow for this session' },
            { id: 'always', label: 'Always allow' },
          ]}
          onAllow={(scope) => onPermissionResponse(true, scope)}
          onDeny={() => onPermissionResponse(false, '')}
        />
      )}
    </main>
  );
}
```

#### 3.3.4 WebSocket Hook

**文件**: `packages/web-app/src/client/hooks/useWebSocket.ts`

```typescript
import { useState, useEffect, useCallback, useRef } from 'react';
import type { Message, PermissionRequest } from '../../shared/types';

interface UseWebSocketOptions {
  onMessage: (message: Message) => void;
  onHistory: (messages: Message[]) => void;
}

export function useWebSocket(
  sessionId: string | null,
  options: UseWebSocketOptions,
) {
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const { onMessage, onHistory } = options;
  
  // 连接 WebSocket
  useEffect(() => {
    if (!sessionId) return;
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;
    
    ws.onopen = () => {
      setIsConnected(true);
      ws.send(JSON.stringify({ type: 'join_session', sessionId }));
    };
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case 'history':
          onHistory(data.messages);
          break;
        case 'user_message':
        case 'assistant_message':
        case 'tool_call':
        case 'thinking':
          onMessage(data);
          break;
        case 'stream_start':
          setIsStreaming(true);
          break;
        case 'stream_end':
          setIsStreaming(false);
          break;
        case 'permission_request':
          setPermissionRequest(data);
          break;
      }
    };
    
    ws.onclose = () => {
      setIsConnected(false);
    };
    
    return () => {
      ws.close();
    };
  }, [sessionId, onMessage, onHistory]);
  
  // 发送消息
  const send = useCallback((message: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);
  
  // 响应权限请求
  const respondToPermission = useCallback((allow: boolean, scope: string) => {
    send({ type: 'permission_response', allow, scope });
    setPermissionRequest(null);
  }, [send]);
  
  return {
    isConnected,
    isStreaming,
    permissionRequest,
    send,
    respondToPermission,
  };
}
```

---

## 4. 代码参考

### 4.1 Session 管理

| 需求 | 参考文件 | 关键函数 |
|------|---------|---------|
| 列出 Sessions | `packages/core/src/services/sessionService.ts` | `listSessions()` |
| 加载 Session | `packages/core/src/services/sessionService.ts` | `loadSession()` |
| 创建 Session | `packages/core/src/config/config.ts` | `startNewSession()` |
| 记录消息 | `packages/core/src/services/chatRecordingService.ts` | `recordUserMessage()` |

### 4.2 UI 组件复用

| 需求 | 复用组件 | 来源 |
|------|---------|------|
| 聊天展示 | `ChatViewer` | `@qwen-code/webui` |
| 用户消息 | `UserMessage` | `@qwen-code/webui` |
| AI 消息 | `AssistantMessage` | `@qwen-code/webui` |
| 思考消息 | `ThinkingMessage` | `@qwen-code/webui` |
| 工具调用 | `*ToolCall` 组件族 | `@qwen-code/webui` |
| 输入表单 | `InputForm` | `@qwen-code/webui` |
| 权限抽屉 | `PermissionDrawer` | `@qwen-code/webui` |
| 日期分组 | `groupSessionsByDate` | `@qwen-code/webui` |

### 4.3 命令系统

| 需求 | 参考文件 | 说明 |
|------|---------|------|
| 命令定义 | `packages/cli/src/ui/commands/types.ts` | `SlashCommand` 接口 |
| 命令注册 | `packages/cli/src/services/BuiltinCommandLoader.ts` | 添加到 `allDefinitions` |
| 流式返回 | `packages/cli/src/ui/commands/types.ts` | `StreamMessagesActionReturn` |

---

## 5. 技术细节

### 5.1 消息格式

WebSocket 消息遵循 Core 包的 `ChatRecord` 格式:

```typescript
// 参考: packages/core/src/services/chatRecordingService.ts
interface Message {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  type: 'user' | 'assistant' | 'tool_call' | 'thinking';
  message?: {
    role: string;
    parts: Array<{ text: string }>;
  };
  toolCall?: {
    name: string;
    args: Record<string, unknown>;
    status: 'pending' | 'running' | 'success' | 'error';
    result?: unknown;
  };
}
```

### 5.2 状态管理

前端使用 React Hooks 管理状态，无需引入 Redux:

- `useSessions` - 管理 session 列表
- `useMessages` - 管理当前 session 的消息
- `useWebSocket` - 管理 WebSocket 连接和实时通信

### 5.3 构建配置

Vite 配置需要支持:
- React 编译
- Tailwind CSS
- 代理 API 请求到后端（开发环境）
- 生产构建输出到 `dist/client`

---

## 6. 注意事项

### 6.1 潜在风险

1. **端口冲突**: 需要实现端口自动递增逻辑
2. **WebSocket 重连**: 需要实现断线重连机制
3. **大 Session**: 历史消息过多时的性能问题

### 6.2 安全考虑

1. 默认绑定 `127.0.0.1`，仅本地访问
2. `--host 0.0.0.0` 时显示警告
3. CORS 仅允许 localhost 来源

### 6.3 测试策略

1. 单元测试: API 路由、WebSocket 处理
2. 集成测试: 完整的消息流
3. E2E 测试: 浏览器自动化测试
