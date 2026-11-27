# Web Shell 分离后台 Shell 存活探测

- 状态：草案
- 关联 issue：[#17819](https://github.com/QwenLM/qwen-code/issues/17819)
- 配套设计：[web-shell-sidebar-background-work-indicator.zh-CN.md](./web-shell-sidebar-background-work-indicator.zh-CN.md)（live 路径指示器，#17713）
- 英文版：[web-shell-detached-background-shell-liveness.md](./web-shell-detached-background-shell-liveness.md)

## 背景

每个 workspace 的所有会话由同一个运行时（ACP bridge 子进程）承载；后台 shell 是它 spawn 的孙进程。运行时一旦死亡——daemon 重启、bridge 崩溃、被硬杀——相关会话就变成 persisted-only：磁盘上有 transcript，但注册表里没有 live 条目，没有任何人可以回答"它的后台工作还在跑吗"。

后台 shell 会在 `<projectTempDir>/background-shells/<sessionId>/` 下写 `shell-*.status` 侧车文件。注册表只在优雅退出时把 sidecar 结算成终态（`settleAsCancelled`），硬杀会留下过期的 `running` 声明。在本次修改之前，没有任何 daemon 侧代码会读它——唯一的读者是模型本身，按 `shell.ts` 中每次启动时给出的状态文件指引（`statusFileGuidance`）去读取。

## 问题

daemon 会话列表只从 live 注册表条目读取 `hasRunningBackgroundTasks`。对 persisted-only 会话，这个字段缺失，Web Shell 认为该行没有已知后台工作，删除流程直接放行——detached 工作可能还在跑，transcript 却被删掉了。这正是"无感恢复"故事制造的组合：懒重启恢复了 transcript，但没有任何机制恢复（甚至观察）detached shell。

## 目标

- 通过磁盘和操作系统进程验证恢复 detached shell 的存活信号，覆盖重新打开会话后的场景。
- 信号端到端贯通：daemon 会话列表 → SDK/bridge 类型 → Web Shell store → 侧栏指示、tooltip、删除弹窗。
- 对确认仍在运行的 detached 工作拦截删除；对无法确认的状态给出提示而非拦截。
- 保证列表响应路径安全：探测尽力而为、单次请求工作量有界、结果有缓存。

## 非目标

- `deleteDaemonSessions` 内的服务端删除时复查（后续项，见[删除时复查](#删除时复查后续项)）。
- 恢复或重新接管 detached shell；信号只做观察。
- Windows 与 macOS 进程身份令牌（本迭代仅 Linux procfs，见[平台限制](#平台限制)）。

## 设计

### 证据模型

sidecar `.status` 文件是声明，不是事实。它只被当作候选指针读取——提供 pid 与身份令牌——结论永远来自对操作系统进程表的探测。过期的声明不会产生误判的"运行中"，只会产生两种结果：被证伪（pid 无归属），或落入 `unknown`。

单会话裁决矩阵（任一 sidecar 都可以决定整个会话）：

| 磁盘声明                                   | 进程探测                                                                                      | 对结论的贡献                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------- |
| `running` / `cancelled` / `failed` 带令牌  | 令牌与存活且非僵尸的进程吻合                                                                  | 会话为 `running`（短路返回）       |
| 同上                                       | 声明被证伪——落定的命名空间声明下 `ESRCH`，或启动时间片不匹配 / 僵尸进程                       | 声明被证伪——不贡献                 |
| 同上                                       | 身份无法确认——bootId 不匹配、外部或无配对的命名空间声明、procfs 读取失败、非 `ESRCH` 探测错误 | 会话为 `unknown`                   |
| `running` / `cancelled` 无令牌（非 Linux） | 无 pid namespace 概念，本机 pid 表可信                                                        | `ESRCH` 证伪声明；其余为 `unknown` |
| `running` / `cancelled` 无令牌（Linux）    | 没有任何可确认的命名空间声明能把记录锚定到本机                                                | 会话为 `unknown`                   |
| 无令牌的 `failed`                          | 跳过                                                                                          | 终态，无需进程检查                 |
| `completed`                                | 跳过                                                                                          | 终态，无需进程检查                 |
| 文件不可读 / 格式非法 / 超 16 KiB          | —                                                                                             | 会话为 `unknown`                   |
| 无 sidecar 目录                            | —                                                                                             | 无信号（字段缺省）                 |

`cancelled` 声明与带令牌的 `failed` 声明仍会被探测：`settleAsCancelled` 先写文件再发取消请求，传输错误也在退出前落盘，终态标签不能证明进程已退。

### 身份验证

复用 `process-liveness.ts` 的既有原语（`readLocalBootId`、`readProcStartToken`、`readPidNamespaceId`、`isZombie`）——与 channel pidfile 身份检查相同的模式，推广到"由其他进程写下的 sidecar"：

- `bootId` 不匹配 → 机器重启过 → 无法判定 → `unknown`。
- pid namespace 不匹配 → 不同容器/域 → `unknown`。
- `process.kill(pid, 0)` 返回 `ESRCH` → 当前没有任何进程占用该 pid → 声明被证伪（`dead`）。仅当命名空间声明已落定时才允许这个方向：记录的 namespace 与本域一致，或平台根本没有 pid namespace 概念。PID 复用不可能让 pid 凭空消失，所以这个方向的判定不依赖身份令牌。
- procfs 启动时间不匹配 → pid 已被无关进程复用 → `dead`。
- 启动时间吻合且非僵尸进程 → `alive-verified`。

### 平台限制

身份令牌只在 Linux 落地（procfs）。其他平台写不出令牌；没有令牌时，"活着的 pid"无法与"复用的 pid"区分，探测返回 `alive-unverified` → 会话 `unknown`。`ESRCH` 只在本机 pid 表可信时才能判定死亡：无 pid namespace 概念的平台，或记录的 namespace 已确认与本域一致。在 Linux 上读取 `/proc/self/ns/pid` 失败不代表"没有 namespace"——共享运行目录的兄弟容器让本机 pid 表失去意义——这类记录保持 `unknown`。后台 shell 在 POSIX 上以 detached 方式 spawn，macOS 上硬杀 daemon 同样会留下存活的 shell；那里写不出令牌，存活者读作 `unknown`，死亡者由本机 `ESRCH` 证伪（macOS 没有 pid namespace 概念）。补 Windows 与 macOS 身份令牌（进程创建时间）属于后续项。

### 接入点

- `session-list.ts` 的两条列表路径都探测当前页的持久化记录。对于 live 行，探测器用 live 条目的创建时间排除本次会话运行期间启动的 shell。上一次运行留下的 shell 可以和当前运行时管理的工作同时存在。
- 传输格式：会话摘要上的 `detachedBackgroundWork?: 'running' | 'unknown'`。缺省 = 未观察到 detached 工作；刻意不引入 `not_running`（缺省已经承载了这个含义）。
- 客户端应用 live 状态时会保留目录里的 detached shell 观测。已确认运行的 detached 工作和 live 后台工作都能拦截删除。两者同时存在时，界面只显示一个运行指示。detached 状态未知时仍显示提示。
- 60 秒慢速目录刷新覆盖已订阅的非 live 行和带 detached shell 观测的 live 行。孤儿 shell 退出时，目录版本可能保持原值。

### 预算与缓存

- 结果按项目临时目录和会话缓存 45 秒，包含「无信号」结果。复用缓存要求 live 条目的时间分界相同。
- 单次调用最多探测 100 个未缓存会话，其余留给后续刷新。探测发生在分页之后，绝不扫全量目录。
- 任何探测失败都降级为 `unknown` 或"无信号"——绝不抛错——因为它跑在列表响应路径里。

## 删除时复查（后续项）

列表/UI 层可以被直接调用 `POST /sessions/delete` 绕过。应在 daemon 删除 handler 内调用同一个探测器，拒绝仍存在已验证运行 detached 工作的删除。本设计刻意先交付读侧；删除门禁是复用本模块的小型后续改动。

## 备选方案

- **给删除接入 `requireIdle`**——改变所有存在活跃 AI 回合会话的删除语义，破坏 #17713 测试钉住的"仅有活跃回合的行仍可勾选"行为。否决。
- **把任何 sidecar 声明当真相**——硬杀后留下的过期声明会让干净会话永远无法删除。否决：声明必须经操作系统验证。
- **在会话记录里持久化"detached"标记**——无法回答"还在跑吗"；真相在进程表里，不在记录里。

## 测试

- `detached-work-liveness.test.ts`：裁决矩阵、缓存、预算滚动、PID 复用、ESRCH 降级、非法 sidecar。
- `session-list.test.ts` 覆盖重新打开后还能查到旧 shell，包括当前运行时还有其他任务的情况。
- `backgroundShellRegistry.test.ts`：身份令牌随 sidecar 落盘。
- 客户端测试覆盖新任务开始和结束时保留旧 shell 的观测，以及旧 shell 退出后在目录版本原值下慢刷新解除删除拦截。
- 手工验证：Linux 上 daemon 重启且 detached shell 存活时，该行有 running 指示且删除被拦；shell 退出后指示消失、删除放行。Windows 上硬杀 daemon 会带走整棵进程树，残留的 `running` 声明经 `ESRCH` 判定为"无信号"。macOS 上存活的 detached shell 读作 `unknown`，死亡声明的结算方式相同。

## 验收标准

1. persisted-only 会话存在已验证运行的 detached shell 时，显示 running 指示且无法从弹窗删除。
2. persisted-only 会话的 detached shell 在无 namespace 概念的平台（或 namespace 已确认一致）全部死亡时，无指示且可删除；命名空间声明无法确认的场景降级为第 3 条的 `unknown` 处理。
3. persisted-only 会话存在无法验证的声明时，显示 unknown 指示与弹窗提示；删除仍然可用。
4. 重新打开会话并完成一个新后台任务后，只要旧 shell 还在运行，删除就继续被拦截。新的探测确认旧 shell 退出且 live 会话空闲后，可以删除。
5. 列表响应路径保持有界：命中缓存或预算滚动，绝不无界扫描。
