# TUI 优化：启动性能与 MCP

> 详细设计文档 1/3 — 解决启动缓慢问题，尤其是配置了 MCP Server 的场景。

## 1. 问题分析

### 1.1 启动流程现状

启动入口位于 `packages/cli/src/gemini.tsx` 的 `main()` 函数（第 290 行），执行一个**严格串行**的初始化管线：

```
T0: profileCheckpoint('main_entry')                    ← 第 291 行
 │
 ├─ loadSettings()          [同步, 读取 4-5 个 JSON]    ← 第 293 行
 ├─ cleanupCheckpoints()    [异步, 等待完成]             ← 第 294 行
 ├─ parseArguments()        [异步, yargs 解析]           ← 第 297 行
 ├─ dns.setDefaultResultOrder()                         ← 第 310 行
 ├─ themeManager.loadCustomThemes() [同步]               ← 第 315 行
 │
 ├─ Sandbox 检查 + 可能的进程重启                        ← 第 328-415 行
 │   ├─ loadSandboxConfig()   [异步, 文件 I/O]
 │   ├─ loadCliConfig()       [异步, 仅用于沙箱场景]
 │   ├─ validateAuth()        [异步, 可能触发网络请求]
 │   └─ start_sandbox() 或 relaunchAppInChildProcess()
 │
 ├─ loadCliConfig()          [异步, 合并所有配置源]       ← 第 445 行
 ├─ initializeApp()          [异步: i18n + auth + IDE]   ← 第 507 行
 ├─ 收集启动警告                                         ← 第 518-535 行
 ├─ Kitty 协议检测           [异步]                      ← 第 543 行
 ├─ startInteractiveUI()     [渲染 React 树]             ← 第 544 行
 │
 └─ config.initialize()      [UI 渲染后, MCP 发现在此]   ← config.ts 第 872 行
     ├─ FileDiscoveryService 初始化
     ├─ GitService 初始化
     ├─ PromptRegistry 初始化
     ├─ ExtensionManager 初始化
     ├─ HookSystem 初始化
     └─ discoverAllMcpTools()  [MCP 发现]
```

### 1.2 各阶段耗时分析

基于启动分析器（`packages/cli/src/utils/startupProfiler.ts`）的 checkpoint 数据和代码分析：

| 阶段                              | 估计耗时   | I/O 操作           | 瓶颈类型     |
| --------------------------------- | ---------- | ------------------ | ------------ |
| 模块加载（V8 解析 23.7MB bundle） | 200-500ms  | 1 次磁盘读取       | CPU + I/O    |
| Settings 加载                     | 50-200ms   | 4-5 次文件读取     | 串行 I/O     |
| 参数解析                          | 10-30ms    | 无                 | CPU          |
| 主题加载                          | 5-10ms     | 无                 | CPU          |
| Sandbox/进程重启检查              | 10-50ms    | 1-2 次文件读取     | I/O          |
| loadCliConfig()                   | 50-100ms   | 2-3 次文件读取     | 合并操作     |
| initializeApp()                   | 50-200ms   | LSP 发现（如启用） | I/O + 网络   |
| UI 渲染                           | 100-300ms  | 无                 | React 初始化 |
| config.initialize()               | 500ms-5s+  | 文件扫描 + MCP     | MCP 子进程   |
| MCP 发现                          | 500ms-10s+ | 子进程启动 + 网络  | 网络延迟     |

**关键发现**：

1. Settings 加载使用 `fs.readFileSync` 串行读取多个文件（`packages/cli/src/config/settings.ts`）
2. `loadCliConfig()` 和 `initializeApp()` 之间无数据依赖，但串行执行
3. MCP 发现虽然跨 Server 并行（`Promise.all`），但位于 `config.initialize()` → `createToolRegistry()` → `discoverAllTools()` 调用链中，被前置的 FileDiscovery、Git、Hook 等初始化阻塞
4. MCP 默认超时 10 分钟（`MCP_DEFAULT_TIMEOUT_MSEC = 10 * 60 * 1000`），一个慢 Server 会拖慢整个工具可用性

### 1.3 MCP 初始化详细分析

MCP 客户端管理器位于 `packages/core/src/tools/mcp-client-manager.ts`：

```typescript
// discoverAllMcpTools() 关键流程
async discoverAllMcpTools(cliConfig: Config): Promise<void> {
  await this.stop();  // 清理已有连接

  const servers = populateMcpServerCommand(
    cliConfig.getMcpServers() || {},
    cliConfig.getMcpServerCommand(),
  );

  this.discoveryState = MCPDiscoveryState.IN_PROGRESS;

  // 跨 Server 并行 — 这一点已经做得不错
  const discoveryPromises = Object.entries(servers).map(
    async ([name, config]) => {
      if (cliConfig.isMcpServerDisabled(name)) return;
      const client = new McpClient(name, config, ...);
      this.clients.set(name, client);
      try {
        await client.connect();     // 子进程启动 / TCP 连接
        await client.discover(cliConfig);  // 工具枚举
      } catch (error) { /* 记录但不阻塞 */ }
    },
  );

  await Promise.all(discoveryPromises);  // 等待所有 Server
  this.discoveryState = MCPDiscoveryState.COMPLETED;
}
```

**问题**：

- `await Promise.all(discoveryPromises)` 意味着最慢的 Server 决定整体完成时间
- 工具注册发生在所有 Server 发现完成后，而非逐个注册
- 默认超时 10 分钟过长，用户需等待不可接受的时间
- 发现流程在 `config.initialize()` → `createToolRegistry()` → `registry.discoverAllTools()` 调用链中被前置初始化步骤阻塞

## 2. 解决方案

### 2.1 [P0] 并行 Settings 加载

**现状**：`loadSettings()` 在 `packages/cli/src/config/settings.ts` 中通过 `fs.readFileSync` 串行读取系统默认、系统配置、用户配置、工作区配置等 4-5 个 JSON 文件。

**方案**：

1. 将 `fs.readFileSync` 替换为 `fs.promises.readFile`
2. 使用 `Promise.all` 并行读取所有配置文件
3. 读取完成后再执行串行的合并逻辑（合并本身很快，瓶颈在 I/O）
4. 将 `loadSettings()` 签名从同步改为异步

**影响范围**：

- `packages/cli/src/config/settings.ts` — 核心修改
- `packages/cli/src/gemini.tsx:293` — 调用处加 `await`（`main()` 已是 async）

**预期收益**：Settings 加载阶段耗时降低 30-50%（从 ~150ms 降至 ~80ms）。

**验证方式**：

```bash
QWEN_CODE_PROFILE_STARTUP=1 qwen-code --prompt "test"
# 对比 after_load_settings 阶段耗时
```

### 2.2 [P0] 并行化 UI 前初始化

**现状**：`loadCliConfig()` 之后，`initializeApp(config, settings)` 串行执行 i18n、auth、IDE 连接。而 `initializeApp` 依赖 `config` 参数，因此不能与 `loadCliConfig` 并行。但 `initializeApp` 内部的子步骤可以并行化，且启动警告收集、Kitty 协议检测等与 `initializeApp` 无依赖关系。

**方案**：拆分 `initializeApp()`，将其内部子步骤与其他独立步骤并行执行。

**拆分 initializeApp 内部**（`packages/cli/src/core/initializer.ts` 第 37-58 行）：

```typescript
// 当前 initializeApp 内部是串行的：
//   await initializeI18n(...)    // 不依赖 config
//   await performInitialAuth(config, authType)  // 依赖 config
//   if (ideMode) await ideClient.connect()      // 依赖 config

// 优化：i18n 可以与 loadCliConfig 并行
const [config, _i18n] = await Promise.all([
  loadCliConfig(settings.merged, argv, ...),
  initializeI18n(settings.merged),  // 仅依赖 settings，不依赖 config
]);

// config 就绪后，auth 与其他步骤并行
const [_auth, startupWarnings, userWarnings, _kitty] = await Promise.all([
  performInitialAuth(config, authType),
  getStartupWarnings(),
  getUserStartupWarnings(settings),
  detectKittyProtocol(),
]);
```

**影响范围**：

- `packages/cli/src/gemini.tsx`（第 440-550 行）— 重组初始化顺序
- `packages/cli/src/core/initializer.ts`（第 37-58 行）— 拆分 `initializeApp()` 为独立可组合的函数

**前置条件**：已验证 `initializeI18n` 仅依赖 `settings.merged` 中的语言设置，不依赖 `config`，可与 `loadCliConfig` 并行。`performInitialAuth` 依赖 `config`，必须等 config 就绪后执行。

**预期收益**：`before_render` checkpoint 耗时减少 200-400ms（主要来自 i18n 与 config 并行 + auth 与警告/检测并行）。

### 2.3 [P1] 渐进式 MCP 可用性

**现状**：所有 MCP Server 完成发现后才统一注册工具，用户在此之前无法使用任何 MCP 工具。

**方案**：

1. **提前启动 MCP 发现**：在 config 加载完成后立即开始 MCP 发现（fire-and-forget），不等 UI 渲染
2. **逐 Server 注册**：每个 Server 发现完成后立即注册其工具到 ToolRegistry，而非等待所有 Server
3. **合理超时**：将发现阶段默认超时从 10 分钟降至 30 秒，支持 `serverConfig.timeout` 覆盖
4. **UI 进度指示**：添加 "N/M MCP Servers 已连接" 状态显示

**核心代码变更**（`packages/core/src/tools/mcp-client-manager.ts`）：

```typescript
async discoverAllMcpTools(
  cliConfig: Config,
  onServerReady?: (name: string) => void  // 新增：逐 Server 回调
): Promise<void> {
  // ... 省略前置代码 ...

  const discoveryPromises = Object.entries(servers).map(
    async ([name, config]) => {
      const client = new McpClient(name, config, ...);
      this.clients.set(name, client);

      try {
        // 使用 Promise.race 限制单 Server 超时
        await Promise.race([
          (async () => {
            await client.connect();
            await client.discover(cliConfig);
            onServerReady?.(name);  // 立即通知该 Server 就绪
          })(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`MCP server "${name}" discovery timeout`)),
              config.timeout ?? 30_000  // 30秒默认超时
            )
          ),
        ]);
      } catch (error) { /* 记录但不阻塞 */ }
    },
  );

  await Promise.all(discoveryPromises);
  this.discoveryState = MCPDiscoveryState.COMPLETED;
}
```

**实现路径**：

代码审查发现 `createToolRegistry()` 已支持 `skipDiscovery` 选项（`config.ts` 第 2584-2586 行），且 `discoverMcpTools()` 方法可独立调用（`tool-registry.ts` 第 385-393 行）。因此可以实现两阶段初始化：

```typescript
// 阶段 1：快速创建工具注册表（跳过发现）
await createToolRegistry({ skipDiscovery: true });

// 阶段 2：异步 MCP 发现（fire-and-forget 或带回调）
void toolRegistry.discoverMcpTools(onServerReady);
```

**影响范围**：

- `packages/core/src/tools/mcp-client-manager.ts` — 添加渐进回调、超时控制
- `packages/core/src/config/config.ts` — 利用已有的 `skipDiscovery` 选项，在 `initialize()` 中跳过 MCP，另行启动
- `packages/core/src/tools/tool-registry.ts` — 利用已有的 `discoverMcpTools()` 方法
- `packages/cli/src/ui/AppContainer.tsx` — 添加 MCP 连接状态显示

**预期收益**：

- 首个工具可用时间从 "等待所有 Server" 降至 "最快 Server 响应时间"（通常 < 2秒）
- 慢 Server 不再阻塞其他 Server 的工具使用

**风险点**：

- 工具列表在会话中动态变化（逐渐增加），需确保 LLM prompt 中的工具描述能动态更新
- 超时降低可能导致网络慢的环境误判 Server 不可用 → 通过配置项允许用户调整

### 2.4 [P1] 启动分析器增强

**现状**：`packages/cli/src/utils/startupProfiler.ts` 仅记录粗粒度 phase 边界，无法定位 `config.initialize()` 内部的具体瓶颈。

**方案**：

1. 在 `config.initialize()` 内部添加子 checkpoint：`file_discovery_init`、`git_init`、`prompt_registry_init`、`mcp_discovery_start`、`mcp_discovery_end`
2. 在每个 checkpoint 记录 `process.memoryUsage().heapUsed`
3. 添加 `--startup-profile` CLI 参数（比环境变量更易用）
4. 保存滚动 10 次运行历史到 `~/.qwen/startup-perf/`，支持回归检测

**影响范围**：

- `packages/cli/src/utils/startupProfiler.ts` — 增强记录能力
- `packages/core/src/config/config.ts` — 添加子 checkpoint 调用

### 2.5 [P2] 产物体积优化

**现状**：`dist/cli.js` 约 23MB，V8 冷启动解析耗时不可忽略。

**方案**：

1. 使用 `source-map-explorer` 或 `esbuild-analyzer` 分析体积构成
2. **lowlight 语法库懒加载**：当前 `CodeColorizer.tsx:9` 通过 `import { common } from 'lowlight'` 一次性加载约 40 种语言语法，改为按需注册
3. 未使用主题定义的 tree-shaking
4. 考虑将代码高亮拆分为独立 chunk 或 worker

**影响范围**：

- 构建配置
- `packages/cli/src/ui/utils/CodeColorizer.tsx` — 延迟加载语法

**预期收益**：`processUptimeAtT0Ms`（V8 解析时间）减少 20%+。

## 3. 竞品参考

### Claude Code 启动优化策略

Claude Code 在 `src/main.tsx` 中实现了激进的并行初始化：

```typescript
// MCP 配置提前并行加载
const [localMcpPromise, claudeaiMcpPromise] = [
  loadLocalMcpConfig(),
  loadClaudeAiMcpConfig(),
];

// 设置/信任对话框与 MCP 连接并行运行
Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()]);

// MCP 连接使用 Promise.race 超时保护
Promise.race([claudeaiConnect, timeout]);

// 渲染后延迟预取（fire-and-forget）
void prefetchAllMcpResources();

// 特性门控的懒加载
const module = feature('FLAG') ? require('./module.js') : null;
```

**关键设计差异**：

- Claude Code 的 MCP 配置加载在 UI 渲染**之前**就开始
- 使用 `Promise.race` 而非等待所有 Server
- 非关键预取使用 `void` fire-and-forget 模式
- 特性门控避免加载不需要的模块

## 4. 实施优先级与里程碑

| 优先级 | 方案               | 周次 | 风险 | 预期改善             |
| ------ | ------------------ | ---- | ---- | -------------------- |
| P0     | 并行 Settings 加载 | 3    | 低   | 配置加载耗时 -30~50% |
| P0     | 并行化 UI 前初始化 | 4    | 低   | TTI -200~400ms       |
| P1     | 渐进式 MCP 可用性  | 5-6  | 中   | 首工具可用 < 2s      |
| P1     | 启动分析器增强     | 3    | 低   | 持续监控能力         |
| P2     | 产物体积优化       | 10   | 中   | 冷启动 -20%          |

## 5. 验证方案

### 5.1 定量指标

```bash
# 启动 profile 对比
QWEN_CODE_PROFILE_STARTUP=1 qwen-code --prompt "test"

# 重点关注指标：
# - processUptimeAtT0Ms: V8 模块解析时间
# - after_load_settings: 配置加载完成时间
# - before_render: UI 渲染前总耗时
# - 新增: mcp_first_tool_available: 首个 MCP 工具可用时间
# - 新增: mcp_all_tools_available: 所有 MCP 工具可用时间
```

### 5.2 测试场景

| 场景                         | 期望行为                                       |
| ---------------------------- | ---------------------------------------------- |
| 无 MCP Server                | 启动时间不受 MCP 影响                          |
| 1 个快速 MCP Server          | 工具在 < 2s 内可用                             |
| 3 个 MCP Server（1 慢 2 快） | 快速 Server 工具立即可用，慢 Server 超时后降级 |
| MCP Server 连接失败          | 错误记录但不阻塞启动                           |
| 网络不可用                   | 超时后优雅降级，显示警告                       |
| 冷启动 vs 热启动             | 两种场景均有改善                               |

### 5.3 向后兼容

- `loadSettings()` 签名变更需更新所有调用点
- MCP 超时降低需提供配置项允许用户恢复长超时
- 渐进式工具注册需确保不破坏现有的工具描述生成逻辑
