# Qwen Code Web GUI - 开发计划

## 执行顺序

### Phase 1: 基础设施 (Infrastructure)

| Task | 描述 | 依赖 | 预估 |
|------|-----|------|------|
| 1.1 | 创建 `packages/web-app` 包结构 | 无 | 15min |
| 1.2 | 配置 package.json 和 TypeScript | 1.1 | 10min |
| 1.3 | 配置 Vite 和 Tailwind | 1.2 | 15min |

### Phase 2: 后端 API (Server)

| Task | 描述 | 依赖 | 预估 |
|------|-----|------|------|
| 2.1 | 实现 Express 服务器入口 | 1.x | 20min |
| 2.2 | 实现 Sessions API 路由 | 2.1 | 30min |
| 2.3 | 实现 Config API 路由 | 2.1 | 15min |
| 2.4 | 实现 WebSocket 服务 | 2.1 | 45min |
| 2.5 | 实现 Session Runner | 2.4 | 60min |

### Phase 3: 前端应用 (Client)

| Task | 描述 | 依赖 | 预估 |
|------|-----|------|------|
| 3.1 | 创建前端入口和 App 组件 | 1.x | 20min |
| 3.2 | 实现 Sidebar 组件 | 3.1 | 30min |
| 3.3 | 实现 ChatArea 组件 | 3.1 | 45min |
| 3.4 | 实现 WebSocket Hook | 3.1 | 30min |
| 3.5 | 实现 Sessions Hook | 3.1 | 20min |

### Phase 4: CLI 集成 (Integration)

| Task | 描述 | 依赖 | 预估 |
|------|-----|------|------|
| 4.1 | 创建 `/web` 命令 | 2.x | 30min |
| 4.2 | 注册命令到 BuiltinCommandLoader | 4.1 | 5min |

### Phase 5: 测试和文档 (Testing)

| Task | 描述 | 依赖 | 预估 |
|------|-----|------|------|
| 5.1 | 端到端测试 | 4.x | 30min |
| 5.2 | 文档更新 | 4.x | 15min |

---

## 详细任务分解

### 1.1 创建包结构

```bash
mkdir -p packages/web-app/src/{server,client,shared}
mkdir -p packages/web-app/src/server/{routes,websocket}
mkdir -p packages/web-app/src/client/{components,hooks,styles}
```

**验收标准**: 目录结构创建完成

### 1.2 配置 package.json

创建 `packages/web-app/package.json`:
- 添加依赖: express, ws, react, vite
- 配置 scripts: dev, build, start
- 配置 workspace 引用

**验收标准**: `npm install` 成功

### 1.3 配置 Vite 和 Tailwind

- 创建 `vite.config.ts`
- 创建 `tailwind.config.js`
- 创建 `index.html`
- 配置 webui 样式导入

**验收标准**: `npm run dev` 启动前端开发服务器

### 2.1 实现 Express 服务器

- `src/server/index.ts` - 入口，导出 startServer
- `src/server/app.ts` - Express 应用配置
- 实现端口查找逻辑

**验收标准**: 服务器可以启动并响应 `/healthz`

### 2.2 实现 Sessions API

- GET /api/sessions - 复用 SessionService.listSessions
- POST /api/sessions - 复用 Config.startNewSession
- GET /api/sessions/:id - 复用 SessionService.loadSession

**验收标准**: API 返回正确的 session 数据

### 2.3 实现 Config API

- GET /api/config - 返回基础配置
- PUT /api/config/theme - 更新主题

**验收标准**: API 正常工作

### 2.4 实现 WebSocket 服务

- 连接管理
- 消息路由
- Session 绑定

**验收标准**: WebSocket 可以连接和发送消息

### 2.5 实现 Session Runner

- 管理 AI 对话流程
- 流式消息广播
- 权限请求处理

**验收标准**: 可以发送消息并接收 AI 响应

### 3.1 创建前端入口

- `src/client/main.tsx` - React 入口
- `src/client/App.tsx` - 根组件
- 导入 webui 样式

**验收标准**: 前端页面可以渲染

### 3.2 实现 Sidebar

- Session 列表显示
- 搜索过滤
- 新建/切换 Session

**验收标准**: Sidebar 功能完整

### 3.3 实现 ChatArea

- 复用 ChatViewer 组件
- 复用 InputForm 组件
- 集成 PermissionDrawer

**验收标准**: 聊天界面可以显示消息和输入

### 3.4 实现 WebSocket Hook

- 连接管理
- 消息处理
- 重连机制

**验收标准**: 实时通信正常

### 3.5 实现 Sessions Hook

- 列表获取
- 创建/删除
- 状态管理

**验收标准**: Session 管理功能完整

### 4.1 创建 /web 命令

- 参数解析 (--port, --host, --no-open)
- 启动服务器
- 打开浏览器

**验收标准**: `/web` 命令可以启动 Web GUI

### 4.2 注册命令

修改 BuiltinCommandLoader 添加 webCommand

**验收标准**: 命令在帮助列表中显示

### 5.1 端到端测试

- 启动服务器
- 创建 Session
- 发送消息
- 验证响应

**验收标准**: E2E 流程通过

### 5.2 文档更新

- 更新 CLI 文档
- 添加 Web GUI 说明

**验收标准**: 文档完整
