# TUI 优化：启动性能与 MCP

> 详细设计文档 1/3 — 解决启动缓慢问题，尤其是配置了 MCP Server 的场景。

## 1. 问题分析

### 1.1 启动流程现状

启动入口位于 `packages/cli/src/gemini.tsx` 的 `main()` 函数（第 290 行），执行一个包含多段串行等待的初始化管线：

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

当前启动分析器（`packages/cli/src/utils/startupProfiler.ts`）只记录到 UI render 前后的粗粒度 checkpoint；交互式模式下 `config.initialize()` 是在 `AppContainer` mount 后的 effect 中执行，现有 profile 文件并不会直接覆盖这段耗时。因此下表是**源码路径推导 + 需补充 instrumentation 验证的初始估计**，不能作为最终性能基线。

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

**必须补齐的指标口径**：

- `first_paint`：Ink 首次 render 完成
- `input_enabled`：用户可以输入且不会被启动阶段阻塞
- `config_initialize_start/end`：交互式初始化耗时
- `mcp_first_tool_registered`：首个 MCP Server 完成 discover 并注册工具
- `mcp_all_servers_settled`：所有 MCP Server 成功、失败或超时
- `gemini_tools_updated`：Gemini client 的 tools declaration 已刷新，可被下一次请求使用

**关键发现**：

1. Settings 加载使用 `fs.readFileSync` 串行读取多个文件（`packages/cli/src/config/settings.ts`）
2. `initializeApp()` 依赖 `loadCliConfig()` 产出的 `config`，不能整体并行；可优化的是 i18n 与 `loadCliConfig()` 并行，以及 config 就绪后 auth、startup warnings、Kitty 检测等独立步骤并行
3. MCP 发现跨 Server 并行（`Promise.all`），但 `discoverAllMcpTools()` 仍等待所有 Server settle 后才把 discovery state 标记为完成；UI 只能看到整体完成/失败语义，缺少首工具和逐 Server 可用指标
4. `McpClient.discover()` 内部会在单个 Server discover 完成时注册工具，并非“所有 Server 完成后才统一注册”；真正缺口是 ToolRegistry 的渐进刷新语义、Gemini tools declaration 的 debounce 更新，以及慢 Server 对整体完成状态的拖延
5. MCP 默认超时 10 分钟（`MCP_DEFAULT_TIMEOUT_MSEC = 10 * 60 * 1000`），需要区分“发现超时”和“工具调用超时”，不能简单把所有 MCP timeout 全局缩短到 30 秒

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

- `await Promise.all(discoveryPromises)` 意味着最慢的 Server 决定整体 discovery 完成时间
- 单个 Server 的工具会在 `client.discover(cliConfig)` 完成时注册，但 ToolRegistry 没有对外暴露稳定的“server ready / tools changed”事件语义
- `GeminiClient.setTools()` 只在 chat 初始化或显式调用时刷新 tools declaration；后续 MCP 工具动态加入后，如果不额外调用，模型不会自动拿到新工具
- `ToolRegistry.discoverMcpTools()` 当前会先清理 discovered tools/prompts，不适合直接作为 fire-and-forget 的渐进发现入口
- 默认超时 10 分钟对 discovery 过长，但对长耗时 tool call 可能合理，必须拆开配置和默认值
- 发现流程在 `config.initialize()` → `createToolRegistry()` → `registry.discoverAllTools()` 调用链中被前置初始化步骤阻塞

## 2. 解决方案

### 2.0 [P0] 启动观测基线先行

**目标**：先把启动过程拆成可验证的指标，再执行并行化和 MCP 渐进加载，避免用 render 前 checkpoint 推断 render 后瓶颈。

**新增 checkpoint/event**：

| 指标 | 触发位置 | 用途 |
| ---- | -------- | ---- |
| `first_paint` | `startInteractiveUI()` render 完成后 | 衡量用户首次看到 UI 的时间 |
| `input_enabled` | AppContainer 可接收输入时 | 衡量真实可交互时间 |
| `config_initialize_start/end` | `AppContainer` 调用 `config.initialize()` 前后 | 覆盖当前 profiler 盲区 |
| `tool_registry_created` | `Config.createToolRegistry()` 完成后 | 区分内置工具就绪与 MCP 发现 |
| `mcp_server_ready:<name>` | 单个 MCP Server discover 完成并注册工具后 | 衡量首工具/逐 Server 可用性 |
| `mcp_all_servers_settled` | MCP 发现全部成功、失败或超时后 | 衡量整体完成时间 |
| `gemini_tools_updated` | `GeminiClient.setTools()` 完成后 | 确认模型下一次请求能看到新工具 |

**输出层指标**：

- `stdout_write_count`、`stdout_bytes`、`writes_per_second`
- `clear_terminal_count`
- `erase_lines_optimized_count`
- `bsu_frame_count`、`esu_frame_count`、不平衡帧数

**影响范围**：

- `packages/cli/src/utils/startupProfiler.ts`
- `packages/cli/src/gemini.tsx`
- `packages/cli/src/ui/AppContainer.tsx`
- `packages/core/src/config/config.ts`
- `packages/core/src/tools/mcp-client-manager.ts`
- `packages/cli/src/ui/utils/terminalRedrawOptimizer.ts`

### 2.1 [P0] 并行 Settings 加载

**现状**：`loadSettings()` 在 `packages/cli/src/config/settings.ts` 中通过 `fs.readFileSync` 串行读取系统默认、系统配置、用户配置、工作区配置等 4-5 个 JSON 文件。

同时需要注意，`loadSettings()` 不只是读文件：它还包含 JSON 恢复、损坏配置重命名、迁移持久化、`loadEnvironment()` 调用等副作用，并且被命令、设置对话框和测试大量复用。因此不能直接把现有同步函数改成异步签名并要求所有调用点一次性迁移。

**方案**：

1. 新增 `loadSettingsAsync()`，仅用于 CLI 启动主路径
2. 抽出“读取多个 settings 文件”的纯 I/O 层，使用 `Promise.all` 并行读取
3. 保留现有 `loadSettings()` 同步 wrapper，供命令、设置对话框、测试继续使用
4. 读取完成后复用同一套合并、迁移、恢复、`loadEnvironment()` 逻辑，确保副作用顺序不变
5. 迁移稳定后再评估是否统一异步化所有调用点

**影响范围**：

- `packages/cli/src/config/settings.ts` — 核心修改
- `packages/cli/src/gemini.tsx:293` — 启动主路径改用 `await loadSettingsAsync()`
- 设置对话框、命令和测试暂不强制迁移，避免大范围行为变化

**预期收益**：Settings 加载阶段耗时降低 30-50%（从 ~150ms 降至 ~80ms）。

**验证方式**：

```bash
QWEN_CODE_PROFILE_STARTUP=1 qwen-code --prompt "test"
# 对比 after_load_settings 阶段耗时
```

**回归约束**：

- 损坏 settings 文件仍会按原策略备份/恢复
- settings migration 仍只执行一次，且写回顺序不变
- `loadEnvironment()` 必须在 merged settings 形成后执行
- 同步调用点在第一阶段行为不变

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

**现状校准**：

- `McpClient.discover()` 会在单个 Server discover 完成后把工具注册进 ToolRegistry，因此“所有 Server 完成后才统一注册工具”并不准确
- 但 `discoverAllMcpTools()` 仍等待所有 Server settle 后才完成，慢 Server 会拖延整体 discovery state、初始化完成语义和 UI 反馈
- `ToolRegistry.discoverMcpTools()` 会先 `removeDiscoveredTools()` 并清空 prompt registry，不适合作为异步 fire-and-forget 入口，否则可能短暂移除已可用工具
- `GeminiClient.setTools()` 不会在 MCP 工具动态加入时自动触发；不刷新 tools declaration 时，模型下一次请求仍可能看不到新工具

**方案**：

1. **内置工具先可用**：交互式启动时先 `createToolRegistry({ skipDiscovery: true })`，完成内置工具、命令和必要 prompt 的初始化
2. **MCP 后台发现**：在 registry 创建后启动 MCP 发现任务，但不走会全量清空 discovered tools 的 `discoverMcpTools()` 路径
3. **逐 Server 原子注册**：为每个 Server 使用“仅移除该 Server 旧工具/prompt → connect → discover → 注册新工具”的原子路径；优先复用或扩展 `discoverToolsForServer()`
4. **tools declaration 刷新**：每个 Server ready 后触发 `toolRegistryChanged` 事件，并 debounce 调用 `config.getGeminiClient().setTools()`；只保证下一次模型请求使用新工具，不修改进行中的请求
5. **合理超时**：拆分 discovery timeout 与 tool-call timeout。discovery 默认可降至 30 秒；tool call 继续尊重 `MCP_DEFAULT_TIMEOUT_MSEC` 或 server 配置，避免误杀长耗时工具
6. **UI 进度指示**：复用现有 `mcp-client-update` 事件，显示 "N/M MCP Servers 已连接 / 失败 / 超时"，并在 init 后持续更新

**核心代码变更**（`packages/core/src/tools/mcp-client-manager.ts`）：

```typescript
async discoverMcpToolsProgressively(
  cliConfig: Config,
  onServerReady?: (name: string) => void,
  onToolsChanged?: () => void,
): Promise<void> {
  const discoveryPromises = Object.entries(servers).map(
    async ([name, config]) => {
      if (cliConfig.isMcpServerDisabled(name)) return;

      const client = new McpClient(name, config, ...);
      this.clients.set(name, client);

      try {
        await Promise.race([
          (async () => {
            // 只清理当前 server 的旧工具/prompt，不能清空全局 discovered tools
            this.toolRegistry.removeDiscoveredToolsForServer(name);
            await client.connect();
            await client.discover(cliConfig);
            onServerReady?.(name);
            onToolsChanged?.();
          })(),
          timeout(discoveryTimeoutFor(config)),
        ]);
      } catch (error) { /* 记录但不阻塞 */ }
    },
  );

  await Promise.all(discoveryPromises);
  this.discoveryState = MCPDiscoveryState.COMPLETED;
}
```

**实现路径**：

代码审查发现 `createToolRegistry()` 已支持 `skipDiscovery` 选项，但不能直接 fire-and-forget 调用现有 `discoverMcpTools()`，因为它会清理所有 discovered tools/prompts。应实现一个新的渐进入口或扩展现有 per-server 发现入口：

```typescript
// 阶段 1：快速创建工具注册表（跳过 MCP discovery）
await createToolRegistry({ skipDiscovery: true });

// 阶段 2：异步 MCP 发现；server ready 后 debounce 刷新 Gemini tools
const refreshGeminiTools = debounce(() => config.getGeminiClient().setTools(), 100);
void toolRegistry.discoverMcpToolsProgressively({
  onServerReady,
  onToolsChanged: refreshGeminiTools,
});
```

**影响范围**：

- `packages/core/src/tools/mcp-client-manager.ts` — 添加渐进发现入口、逐 Server 超时控制、server ready 事件
- `packages/core/src/config/config.ts` — 利用已有的 `skipDiscovery` 选项，在 `initialize()` 中跳过 MCP，另行启动
- `packages/core/src/tools/tool-registry.ts` — 添加不清空全局 discovered tools 的 per-server discover/replace API
- `packages/core/src/core/client.ts` — 暴露或复用 `setTools()`，支持 debounce 刷新
- `packages/cli/src/ui/AppContainer.tsx` / `ConfigInitDisplay.tsx` — 扩展 MCP 连接状态显示到初始化后

**预期收益**：

- 首个 MCP 工具注册时间从 "等待所有 Server" 降至 "最快 Server 响应时间"（通常 < 2秒）
- 首个 MCP 工具被模型可见的时间 = server ready + debounce 后 `GeminiClient.setTools()` 完成
- 慢 Server 不再阻塞其他 Server 的工具使用

**风险点**：

- 工具列表在会话中动态变化，需确保 LLM tools declaration 能从下一次请求开始动态更新
- 正在进行的模型请求不应中途变更工具集合，避免工具调用/响应不一致
- 超时降低可能导致网络慢的环境误判 Server 不可用，应只作用于 discovery，并保留配置项允许用户调整
- per-server 替换必须是原子的，避免短暂删除其他 Server 工具或 prompts

### 2.4 [P1] 启动分析器增强

**现状**：`packages/cli/src/utils/startupProfiler.ts` 仅记录粗粒度 phase 边界，并且交互式模式下在 UI render 前后 finalize，无法定位 `config.initialize()`、MCP 首工具注册、Gemini tools 刷新的具体瓶颈。

**方案**：

1. 将 2.0 中定义的指标接入 startup profiler，profile 生命周期延长到交互式初始化完成或显式 timeout
2. 在 `config.initialize()` 内部添加子 checkpoint：`file_discovery_init`、`git_init`、`prompt_registry_init`、`tool_registry_created`、`mcp_discovery_start`、`mcp_first_tool_registered`、`mcp_all_servers_settled`
3. 在每个 checkpoint 记录 `process.memoryUsage().heapUsed`
4. 添加 `--startup-profile` CLI 参数（比环境变量更易用），但保留 `QWEN_CODE_PROFILE_STARTUP=1`
5. 保存滚动 10 次运行历史到 `~/.qwen/startup-perf/`，支持回归检测
6. 在 profile 中标记 `interactive` / `non_interactive`，避免把两种启动路径混合比较

**影响范围**：

- `packages/cli/src/utils/startupProfiler.ts` — 增强记录能力
- `packages/core/src/config/config.ts` — 添加子 checkpoint 调用
- `packages/cli/src/ui/AppContainer.tsx` — render 后初始化 checkpoint

### 2.5 [P2] 产物体积优化

**现状**：`dist/cli.js` 约 23MB，V8 冷启动解析耗时不可忽略。

**方案**：

1. 使用 `source-map-explorer` 或 `esbuild-analyzer` 分析体积构成
2. **代码高亮依赖优化**：当前 `CodeColorizer.tsx:9` 通过 `import { common } from 'lowlight'` 一次性加载约 40 种语言语法；懒加载需要配合渲染层同步/异步边界设计，不能直接在同步 `colorizeCode()` 中引入 `await`
3. 未使用主题定义的 tree-shaking
4. 考虑将代码高亮拆分为独立 chunk 或 worker

**影响范围**：

- 构建配置
- `packages/cli/src/ui/utils/CodeColorizer.tsx` — 延迟加载语法

**预期收益**：`processUptimeAtT0Ms`（V8 解析时间）减少 20%+。该项与 `03-rendering-extensibility.md` 的代码高亮缓存/预热方案联动实施。

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
| P0     | 启动观测基线       | 1    | 低   | 指标口径可信         |
| P0     | 并行 Settings 加载 | 4    | 中   | 配置加载耗时 -30~50% |
| P0     | 并行化 UI 前初始化 | 5    | 低   | TTI -200~400ms       |
| P1     | 渐进式 MCP 可用性  | 6-7  | 中   | 首工具可见 < 2s      |
| P1     | 启动分析器增强     | 1-2  | 低   | 持续监控能力         |
| P2     | 产物体积优化       | 10   | 中   | 冷启动 -20%          |

## 5. 验证方案

### 5.1 定量指标

```bash
# 启动 profile 对比
QWEN_CODE_PROFILE_STARTUP=1 qwen-code --prompt "test"

# 重点关注指标：
# - processUptimeAtT0Ms: V8 模块解析时间
# - after_load_settings: 配置加载完成时间
# - first_paint: UI 首次渲染
# - input_enabled: 可输入时间
# - config_initialize_start/end: render 后初始化耗时
# - before_render: UI 渲染前总耗时
# - mcp_first_tool_registered: 首个 MCP 工具注册时间
# - gemini_tools_updated: 首个 MCP 工具被模型下一次请求可见
# - mcp_all_servers_settled: 所有 MCP Server 完成/失败/超时
```

### 5.2 测试场景

| 场景                         | 期望行为                                       |
| ---------------------------- | ---------------------------------------------- |
| 无 MCP Server                | 启动时间不受 MCP 影响                          |
| 1 个快速 MCP Server          | 工具在 < 2s 内注册，并在 `setTools()` 后对下一次模型请求可见 |
| 3 个 MCP Server（1 慢 2 快） | 快速 Server 工具先注册，慢 Server 超时后降级；其他工具不被清空 |
| MCP Server 连接失败          | 错误记录但不阻塞启动                           |
| 网络不可用                   | 超时后优雅降级，显示警告                       |
| 冷启动 vs 热启动             | 两种场景均有改善                               |
| 正在进行的模型请求中 MCP 工具变化 | 当前请求工具集合不变，下一次请求看到更新 |

### 5.3 向后兼容

- 第一阶段不修改 `loadSettings()` 同步签名，新增 `loadSettingsAsync()` 给启动主路径使用
- MCP discovery 超时降低需提供配置项允许用户恢复长超时；tool call 超时不随 discovery 默认值改变
- 渐进式工具注册需确保不破坏现有的工具描述生成逻辑，并通过 `GeminiClient.setTools()` debounce 刷新
- 不直接使用会全局清空 discovered tools/prompts 的 `ToolRegistry.discoverMcpTools()` 作为后台渐进入口
