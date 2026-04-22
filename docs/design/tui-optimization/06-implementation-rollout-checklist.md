# TUI 优化实施与灰度清单

> 本文档给 `00-05` 各设计/调研文档补齐实施门槛、验收标准、灰度顺序和回滚条件。目标不是重复方案细节，而是把“什么时候能开始做、做到什么算完成、什么情况下必须停下来”写清楚。

如果需要把设计进一步落成开发排期，请与 [08-execution-plan-and-test-matrix.md](./08-execution-plan-and-test-matrix.md) 配套阅读：本清单负责“能不能上线”，`08` 负责“先改哪里、先测什么、先拆哪几条 PR”。

## 1. 使用方式

这份清单按四个层次组织：

1. **通用前置条件**：所有 TUI 优化都必须满足的共性门槛
2. **工作流验收清单**：启动/MCP、闪烁、渲染扩展各自的完成标准
3. **灰度策略**：先开给谁、在哪些终端/场景开、如何扩大范围
4. **回滚条件**：什么信号一出现就应降级或撤回

推荐执行顺序：

1. 先完成通用前置条件
2. 再按工作流分支实施
3. 每一项变更进入灰度前，都在本清单中打勾
4. 任何高风险功能默认要求特性开关

## 2. 通用前置条件

以下条件未满足前，不应启动高风险改造：

- [ ] 启动 profile 口径已明确，且团队知道当前 profiler 是否运行在 sandbox child process
- [ ] 输出层 counters 已可用：`stdout_write_count`、`stdout_bytes`、`clear_terminal_count`、`erase_lines_optimized_count`
- [ ] 至少有一个固定基准场景可重复采样 10 次以上
- [ ] 至少有一组慢 MCP server、长 Markdown 输出、长代码块输出的回归场景
- [ ] 所有高风险变更都有显式回退开关
- [ ] 文档中引用的外部终端能力结论都区分了“已由官方资料证明”和“仅待实机验证”

## 3. 启动与 MCP 验收清单

对应文档：

- `00-overview.md`
- `01-performance.md`
- `04-gemini-cli-research.md`
- `05-claude-code-research.md`

### 3.1 Phase 0 观测基线

- [ ] `first_paint` 可记录
- [ ] `input_enabled` 可记录
- [ ] `config_initialize_start/end` 可记录
- [ ] `mcp_server_ready:<name>` 可记录
- [ ] `mcp_all_servers_settled` 可记录
- [ ] `gemini_tools_updated` 可记录
- [ ] profile 输出区分 `interactive` / `non_interactive`
- [ ] profile 输出能标识是否来自 sandbox child process

### 3.2 冷启动优化

- [ ] `loadSettingsAsync()` 仅接入启动主路径，不改变旧同步调用点签名
- [ ] `initializeApp()` 的拆分没有引入 auth / IDE 初始化时序回归
- [ ] 入口延迟加载不改变非交互路径、测试 harness、CLI 子命令行为
- [ ] 至少在“无 MCP”“1 个快速 MCP”“3 个 MCP（含 1 个慢 server）”三组场景下完成前后对比

### 3.3 渐进式 MCP 可用性

- [ ] 启动阶段使用 `skipDiscovery` + 增量发现，不再 fire-and-forget 调用全量 `discoverMcpTools()`
- [ ] 单 server replace 不会清空其他 server 的 tools/prompts
- [ ] `ConfigInitDisplay` 或等价 UI 能区分“连接进度”和“工具可用性”
- [ ] 每个 server ready 后的 `GeminiClient.setTools()` 刷新具备 debounce
- [ ] 进行中的模型请求不会因 tools 刷新中途改变工具集合
- [ ] discovery timeout 与 tool-call timeout 已拆分
- [ ] 运行期 `refreshMemory()/refreshTools()` 不再默认全量 `restartMcpServers()`

### 3.4 启动/MCP 退出标准

以下条件同时满足时，可认为启动/MCP 改造完成一阶段：

- [ ] 无 MCP 场景启动无退化
- [ ] 快速 MCP server 的首工具注册时间显著早于 `mcp_all_servers_settled`
- [ ] 慢 MCP server 失败/超时不会让已可用 tools 消失
- [ ] runtime refresh 不再引发全量 tool 抖动
- [ ] 所有新增行为可通过特性开关关闭

## 4. 闪烁治理验收清单

对应文档：

- `02-screen-flickering.md`
- `04-gemini-cli-research.md`
- `05-claude-code-research.md`
- `07-issue-backed-failure-taxonomy.md`

### 4.1 前置判断

- [ ] 团队已明确区分 Ink 的 `eraseLines` 重绘问题和 `refreshStatic() -> clearTerminal` 问题
- [ ] 已有基础 flicker 指标或可替代观测数据
- [ ] 已有 main-screen、alternate/fullscreen、tmux、SSH 四类场景的最小回归样例

### 4.2 同步输出（DECSET 2026）

- [ ] 默认启用前已有 runtime probe 或终端家族 allowlist
- [ ] `bsu_frame_count === esu_frame_count`
- [ ] Buffer/string/callback 三类 `stdout.write()` 调用语义均已回归验证
- [ ] screen reader 场景明确不安装或不启用该优化
- [ ] tmux / SSH 组合路径未被直接默认开启
- [ ] `QWEN_CODE_LEGACY_RENDERING=1` 可完整回退

### 4.3 流式节流

- [ ] content stream 节流已覆盖
- [ ] thought stream 节流已覆盖
- [ ] stream end / cancel / tool call / confirm dialog 前会强制 flush
- [ ] shell output 现有节流行为不退化

### 4.4 `refreshStatic()` 与渲染模式分层

- [ ] `refreshStatic()` 的触发来源已梳理清楚
- [ ] `refreshStatic()` 已拆分为“仅 remount static”与“clear terminal + remount”两类语义
- [ ] main-screen 路径与 alternate/fullscreen 路径的目标分离
- [ ] resize 导致的重排不会默认演变为整屏 `clearTerminal`
- [ ] active view / compact toggle / manual clear 三类路径分别有回归样例

### 4.5 窄屏 / 无限滚动回归

- [ ] 已有 <= 40 列窄终端回归样例
- [ ] 已有 tmux 多 pane 等效宽度回归样例
- [ ] shell interactive prompt（如 `git commit`）有回归样例
- [ ] 文档和测试中没有再把 `#1778` 的历史 one-line fix 写成当前源码事实

### 4.6 工具 / 子 agent 详情稳定性

- [ ] `ctrl+e` / `ctrl+f` 展开路径有独立回归样例
- [ ] tool progress / subagent progress / assistant content 的更新频率已分开验证
- [ ] bounded detail panel 或等价容器的键盘交互已回归
- [ ] pending confirmation / force expand / focus lock 规则未退化

### 4.7 闪烁治理退出标准

- [ ] 正常流式输出场景 `stdout.write` 频率显著下降
- [ ] 已支持的终端中肉眼可见的帧撕裂明显减轻
- [ ] 未纳入 allowlist 的终端不出现明显退化
- [ ] 所有高风险策略可单独回退

## 5. 渲染与扩展验收清单

对应文档：

- `03-rendering-extensibility.md`
- `04-gemini-cli-research.md`
- `05-claude-code-research.md`
- `07-issue-backed-failure-taxonomy.md`

### 5.1 Markdown / parser

- [ ] 不缓存 `ReactNode`
- [ ] parser cache key 不保留完整超长原文引用
- [ ] 已定义 plain-text fast path
- [ ] 已定义 streaming stable prefix / unstable suffix 策略
- [ ] HTML policy、GFM extension policy、partial block policy 已写明

### 5.2 代码高亮

- [ ] 当前帧仍保留同步 fallback，不在 render 路径直接 `await`
- [ ] 高亮缓存 key 覆盖 language、theme、width、settings 版本
- [ ] `highlightAuto()` 有长度和 grammar 集合限制
- [ ] pending streaming 代码块不会触发最重路径

### 5.3 大工具输出与 budgeting

- [ ] pre-render slicing 已区分 plain text / ANSI / markdown 三类输出
- [ ] hidden lines 统计不会把 pre-slice 与 soft wrap overflow 双重计算
- [ ] 模型可见预算与用户可见预算已拆分
- [ ] markdown-heavy 工具输出不会因防闪烁而直接退化为纯文本
- [ ] 工具输出默认折叠 / summary + detail 的产品语义已与 force expand 规则对齐

### 5.4 虚拟滚动

- [ ] 仅在 fullscreen / alternate 路径先行
- [ ] wheel/scroll 高频输入不直接驱动 React 高频 state 更新
- [ ] resize 后高度缓存有策略，不是简单全量清空
- [ ] sticky bottom / copy mode / search mode 的语义预留已写明
- [ ] 不出现 blank spacer / mounted range 抖动

### 5.5 渲染扩展退出标准

- [ ] Markdown fixture 测试覆盖旧 parser 与新 parser 共同边界
- [ ] 表格、代码块、列表、未闭合块在 streaming 场景不退化
- [ ] 高亮资源未就绪时内容仍优先可见
- [ ] 长会话场景 CPU / commit 次数有可测下降
- [ ] issue 驱动场景（长工具输出、WebStorm/JetBrains 终端、长回答回看）至少各有一条验收样例

## 6. 灰度顺序

建议的灰度顺序如下：

1. **内部 dogfood**
   - instrumentation
   - `loadSettingsAsync`
   - 启动前初始化并行化
   - 流式节流

2. **受控特性开关**
   - MCP 渐进可用性
   - runtime MCP incremental refresh
   - Markdown token/block cache
   - 高亮缓存 / 预热

3. **按终端家族定向开启**
   - DECSET 2026 同步输出
   - ANSI 16 色默认主题检测

4. **最后灰度**
   - `marked` parser 切换
   - fullscreen / alternate 虚拟滚动
   - 更激进的 render pipeline 改造

## 7. 回滚条件

出现以下任一情况时，应暂停扩大灰度，必要时回滚：

- 启动 profile 无法稳定复现或口径混乱
- `GeminiClient.setTools()` 刷新导致进行中的请求出现工具不一致
- runtime refresh 仍触发全量 tool 抖动
- 未纳入 allowlist 的终端出现明显闪屏或输出损坏
- `stdout.write()` callback / return value 语义被破坏
- 新 parser 在未闭合 Markdown、长代码块、表格场景出现功能性回归
- 虚拟滚动出现 blank spacer、sticky bottom 失效、copy/search mode 退化

## 8. 提交前检查

每次文档或实现准备提交前，建议至少确认：

- [ ] 文档中的 API 名称与当前源码一致
- [ ] 代码示意若不是现有 API，已明确标注“概念实现”或“建议 wrapper”
- [ ] 外部终端支持结论带有来源或明确标注“待验证”
- [ ] `git diff --check` 通过
- [ ] 新增文档已纳入索引
