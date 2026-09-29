# Managed Grep：公共声明与真实后端

状态：2026-09-09，基于 `dc840f8a88` 实现，已完成下述 macOS 本机限定验收。继续 [daemon 默认替换](managed-agent-daemon-default.md)，沿用 [Glob/LS 的执行上下文](managed-agent-search-tools.md) 与已有 v2 invocation/父子历史绑定。该阶段未切换普通 factory；2026-09-10 核对共四处入口（三处 workspace factory 加自有嵌入入口），按[首阶段计划](../plans/2026-09-09-managed-daemon-default.md)继续接线。

公共声明、Gateway 离线注册、Runtime 原生后端选择、配置继承及 POSIX 进程组等待已实现。完整 build/bundle/typecheck、变更 lint 和去重 517 项定向测试通过；16 组隔离验收覆盖下述搜索、权限、父子作用域、取消、释放与后端选择。该阶段推进默认替换，尚不代表普通四入口或全平台兼容已经完成。

## 问题与目标

Gateway 创建工具 registry 时仍探测 rg，并构造、执行本地 GrepTool 或 RipGrepTool。两者共用 grep 名称和相同的四个参数类型，说明文本不同；直接复用某个静态声明会与实际 Runtime descriptor 摘要冲突。现有搜索还有生命周期缺口：git/grep spawn 未连接取消，rg 的 error 事件可先于进程退出返回，版本探测同样可能产生进程；RipGrep 的错误文本缺少机器可读的失败状态。

目标是把搜索、后端探测、路径验证、读取记录与进程生命周期交给 Runtime，Gateway 继续原模型循环、权限、Hook 决策与输出展示。没有工具的首轮不等待 worker；首次工具调用等待已认证 Runtime 的真实准备与执行。

## 公共声明与注册

抽出一份 getGrepToolDefinition，普通 GrepTool、RipGrepTool 和 Gateway proxy 共用。保留 pattern/path/glob/limit 的类型、必填项、正整数限制、Kind.Search、20000 字符工具上限和 AUTO 空串语义。说明准确描述可用搜索后端，不统一承诺实际后端并不全部支持的正则、大小写或文件路径行为。此处有意调整模型可见描述和 schema 中的说明文本，会影响 prompt cache 前缀和 ToolSearch 排名；不改变四个参数的形状或要求模型先调用额外发现工具。

Managed Config 在原 Grep 后端探测分支之前按原权限规则注册纯代理，完全跳过 Gateway canUseRipgrep。普通 Config 保留原后端选择和 fallback。Runtime 只准入其实际 registry 中已经许可的原生 Grep 家族，按作用域的有效偏好选择唯一原生实现，并保留原准入实例的存续检查；manifest 不同时放入两个同名工具，也不取消完整 descriptor digest 校验。RipGrep 执行错误不会临时切换为 Grep；继续原 bundled→system 探测 fallback 与一次 EAGAIN 降线程规则。Grep 内部仍按原策略使用 git grep、系统 grep、JavaScript fallback，取消后不继续下一策略。

## 作用域、配置与权限

既有 bind executionContext 增加有效 useRipgrep/useBuiltinRipgrep 及输出字符/行阈值；无限额度用明确的 null 在线上传输，不能由 JSON 把 Infinity 隐式变成 null。实际 Config getter 是唯一 producer，严格解析、复制、纳入不可变摘要和配置漂移检查。输出阈值还需保留是否显式配置，使同视图的既有工具声明与执行保持一致。旧上下文缺少新增可选字段时沿用 worker 配置，新 Gateway 始终携带有效值。

目录列表、过滤选项和记忆根继续使用父子各自的绑定；搜索结果的 partial-read 记录写入同一 Runtime 视图的 FileReadCache，记录保留 `full: false`，不会触发完整 Read 的缓存命中；现有 Edit/Write 接受有效的部分读取记录，并继续检查 mtime/size 漂移，迁移不新增完整读取前置条件。保留现有两后端的权限与结果差异：Grep 的 memory 路径 allow 改用 Config getter，RipGrep 仍对 workspace 外路径 ask；原文件 path 支持差异和 fallback ignore 行为不借迁移统一。可信 worker 环境补齐实际读取的 WSL_INTEROP，其他未验证的命令环境差异进入完整初始化/配置兼容工作。

## 真实进程与结果状态

从现有 Shell 实现窄提取 POSIX 进程组所有权与退出等待，Shell 与搜索共同使用，保留 PID/PGID/启动身份连续性、TERM→KILL 和未知状态保持未排空的语义。搜索使用直接 argv 执行，不改成 Bash 工具调用。owned 模式的 git/grep/rg 及 rg --version 探测都以独立进程组启动，并在取消、超时、缓冲上限或进程失败后等待真实关闭和所属进程组退出。取消前不启动进程；取消后不进入下一 fallback/retry。不能用 cleanup timeout 的 reject 让 Runtime 把未排空操作记成 settled。

保留 native 搜索的模型可见结果文本，同时明确成功、硬错误、取消及 incomplete 的机器状态。no-match 是成功；有部分结果但扫描失败保留 partial 内容和 incomplete 提示，同时报告失败；用户取消报告 cancelled。Runtime/Hook 使用这些显式状态，不能通过匹配错误字符串推断。普通非 owned 路径保持现有进程策略，成功结果和返回参数兼容；错误/取消的显式状态是必要修正。

当前可复用严格进程组实现只支持 POSIX。Windows 的 taskkill ACK 和直接子进程 exit 不能证明完整进程树排空；在具备按调用 Job Object 等真实 owner 之前，owned 搜索在启动前明确失败，不能把本阶段当 Windows 或完整默认替换验收。该限制与现有 owned Shell 一并保留为默认迁移前的兼容工作。

## 验证与交付

先以全局 qwen 隔离 dry-run，随后用支持私有完整 host 的现有构建记录真实父子 Grep 的 Gateway 本地执行基线；单独记录取消早返回和错误误报成功的内核基线。计划、命令、构建摘要和失败证据保存在 `.qwen/e2e-tests/managed-agent-grep-tools.md` 及其验收目录。不得访问、重启或停止 4170 预览，不使用用户目录作为搜索夹具。

定向测试和真实进程验收覆盖公共声明一致及离线注册、两种配置与实际后端、bundled/system/fallback、不同父子 cwd/附加目录/custom ignore、外路径权限、输出阈值及搜索读取记录。取消使用自有延迟/忽略 TERM 的有限寿命进程及 wrapper 子进程，观察 status/release 在真实退出前不报告 settled，并验证取消后无 fallback/retry；硬错误与 partial 结果检查实际 Hook 和终态。所有自有 PID、端口和临时根须收尾，未覆盖组合如实记录。

build、bundle、typecheck、变更 lint/格式、定向测试、真实 E2E 与两次干净自审后，完成代码复审，提交到指定分支并同步方案。独立审查服务因账户额度不可用时，记录手工复审及其局限，不记为独立审查通过。其余工具、可信初始化、后台/Git/物理历史、配置热更新、全部消费者/旧会话、平台与并发边界继续推进；本阶段通过不等于完整目标完成。

## 2026-09-09 实现与验证

普通 GrepTool/RipGrepTool 及 Gateway proxy 共用公开 `grep_search` 声明。新绑定携带 `grepOptions` 与 `outputLimits`，有限正数和显式 null 无上限可以往返；旧绑定省略新增对象时保留 Runtime 配置。Runtime 从真实 registry 准入原生 Grep 家族，再根据绑定的有效偏好选择一个实例，持续核对原准入实例身份。Gateway 不再探测 rg。owned 搜索直接执行 git/grep/rg；系统命令发现并入实际执行或版本探测，不调用同步 shell 查找。

Shell 的 POSIX 组所有权实现已移至共用 utility，保留取消当刻的后台 promotion 判断。搜索同时等待 close 和进程组退出，取消、超时、缓冲超限都会触发 TERM/KILL 并保持未排空状态；RipGrep 的硬错误和 partial 错误同时返回 typed error 与 executionStatus。

| 已验证组合                                  | 实际结果                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 完整 host，useRipgrep=false                 | 父搜索、真实前台 AgentTool 子搜索及正式 final 共 5 次本地模型请求；2 次 Runtime 搜索成功，Gateway 本地搜索 0，两个 binding 完成 terminal release |
| 完整 host，默认 bundled 配置                | 同样完成真实父子搜索及 final；2 次 Runtime 搜索成功，Gateway 本地搜索 0，保留原 Qwen ignore 行为                                                 |
| 独立 owned rg 取消                          | 基线在取消后 39ms 返回，但后代仍活跃并在返回后写文件；修复组在取消后 388ms 返回，返回时父子进程均退出，未发生后续写入                            |
| 独立真实 Config + ManagedToolRuntime 硬错误 | 原始 stderr 诊断保留，实际 settled 结果由 success 变为 error                                                                                     |

以上四组均验证自有进程退出、临时目录移除和构建 hash 稳定；搜索组各覆盖 52 个不同构建文件，独立组各覆盖 14 个。详细记录在 `.qwen/e2e-tests/managed-agent-grep-tools-progress.json`，原始失败基线和测试夹具修正记录均保留。定向测试为 Core 471 项、CLI 46 项；首轮失败中的缺失 mock getter、错误线程参数/末行预期和异步 ps 夹具时序均修正后复验，不能把初始红测记成通过。

补充 12 组均已完成；原始断言与进程、清理、构建摘要记录保存在同一验收目录：

| 已验证组合                                                                   | 实际结果                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 真实完整 host：rg、系统 grep、git grep 各自取消与执行中关闭 Session，共 6 组 | 每组实际观察 executing 和 cancel_requested；自有父子进程存活时不返回 settled 或成功 release；排空后为 cancelled，仅 1 次模型请求，没有后续写入                                                               |
| 注册 worktree 子 Agent、附加目录、自定义 ignore、输出阈值                    | 父搜索只见父目录和 include；子搜索只见 worktree，12 条匹配按 3 行截断。字符无限额度与显式配置标志正确传递；子 Agent 随后的 WriteFile 使用部分读取记录成功，正式 final 完成，2 个 binding 均释放              |
| 两后端的工作区、memory 与外目录权限，共 2 组                                 | 工作区均 allow；memory 保留 Grep allow / RipGrep ask 差异；外目录均 ask。实际拒绝后不 execute，调用状态为 not_started。bundled/fallback 分别 4/5 次模型请求                                                  |
| 真实 owned rg --version 取消及 5 秒超时，共 2 组                             | 忽略 TERM 的父子进程均退出后才返回取消或 ETIMEDOUT，未发生延迟写入                                                                                                                                           |
| 后端选择 utility 的实际进程组                                                | 原样复制构建模块至隔离 package，依赖仍使用真实构建模块。损坏的 bundled 探测等待其子进程退出才转 system；系统执行成功、两者缺失、两者损坏保留 bundled 原因、owned 探测绕过已预热 ordinary health cache 均通过 |

合计 16 组：11 组完整 host 各验证 52 个不同构建文件，4 组独立生命周期各验证 14 个文件，1 组后端选择验证 7 个文件。所有组均无残留自有进程、无兜底清理信号，已移除临时根；构建前后 hash 相同。当前 bundle SHA-256 为 `845de356df75eb81455827c23bb3d8bba68ac5e557e88d81b215531437822b8b`。16 组并不等于全工具、全消费者或全平台验收。

夹具失败原样保留：默认 AbortSignal 抛出的 DOMException AbortError 使用 code 20，不能误断言为 helper 的 ABORT_ERR；复制 package 中的模拟 bundled 可执行文件需要独立 CommonJS 类型配置。仅修正这两处夹具后重跑，没有为通过测试修改产品语义。初始 full-host 计数把同一声明文件列了两次，52 个唯一 hash 是实际口径，原始 53 计数不覆盖。

独立审查 Agent 当前因账户额度不可用，采用主任务手工复审；不声称通过了独立审查。原有 Shell 所有权实现的抽取、普通非 owned 搜索路径、公开声明、配置生产与读取、Runtime 准入和拒绝路径均须纳入最终自审记录。

尚未证明的边界包括 Windows 完整进程树所有权、真实 WSL 主机、所有 fallback ignore/正则行为的跨平台一致性、完整用户 Hook 组合与大规模并发。partial/error 的机器状态由定向测试及真实 Runtime 硬错误组验证，不能扩大为每一种用户 Hook 已实测。后续继续其余工具和可信初始化，再切换普通入口并验证 Web Shell、SDK、Channels、定时任务与旧会话。
