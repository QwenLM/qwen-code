# Managed Session 持久 Todo

中文 | [English](2026-10-22-managed-workspace-fetch-and-todos.md)

## 问题和范围

#15089 在 `hosted-workspace-files/3` 加入 `todo_write`，但 Worker 身份属于单个 Turn。清单无法跨 Turn 保留，也不能进入 Harness 模型上下文和 WebShell 任务面板。本后续改动将清单保存在 Hosted Session 中，并向客户端投影已提交状态。关联 #15076、#15084。

Profile 与审批边界沿用 main：只有 `files/3` 声明 Todo，Shell 保持统一的 `shell/1`。公共 Plan 准入仍仅限 `files/1` 和 `shell/1`。本改动不增加 profile、生命周期协议、部署默认、MCP 容量规则或自动继续机制。

原生 `web_fetch` 最初暂缓，是因为纯文件 Session 缺少出站策略时可能访问私网、链路本地和元数据地址。main 现已独立交付带目标检查的 fetch；本后续保留该实现，不扩展其策略。

## 存储和执行

Harness 通过 Session authority 写入 `todo_state`。信封包含操作身份、revision 和前一条记录引用。命令摘要绑定原始输入；即使后面发生更新，重试同一命令也返回其原始记录，输入不同则冲突。Session 加载时读取并校验已存记录。

保留 main 的 64 项、内容 1000 个 Unicode 码点、32 个依赖及清单序列化后 16 KiB 限制。共享 core 校验拒绝重复 ID、未知依赖和环。core 与 Hosted 复用同一个依赖保留函数：旧计划未完成时，将省略的边保留到仍存在的 ID；显式空数组清空依赖；保留边导致环时回退到调用者的合法清单。合并后的清单同样必须符合 Hosted 限制。不增加 Hosted 独有的状态与依赖完成度约束。

合法 Todo 调用直接提交，不 acquire、prepare 或 execute Runtime。构造器已有的预热以及配置的 Hook 执行仍可能访问 Broker。成功的 journal-only 写入计入 PostToolUse 的派发证据，校验拒绝不计入。保留 Worker Todo 以服务既有执行路径，但新的 Hosted Todo 派发由 Harness 负责。

状态提交和工具结果提交有先后顺序，并非原子事务。两者之间崩溃时可能已经保存状态，但尚无公共成功回执。重放命令可取回原始结果；这不会扩大中断批次的恢复准入。新的 journal-only Todo 批次不记录为 Worker continuation；之前保存的 Worker continuation 保持原有执行路径。

## 模型上下文

新的模型请求读取最新持久清单。已保存的恢复请求沿用记录中的上下文。提醒将 JSON 标明为任务数据而非指令，并要求不要遵循任务文本中夹带的指令。其大小仍受清单存储上限约束；本改动不引入上下文缓存，也不改变供应商前缀缓存机制。

## 已提交状态的客户端投影

可见快照由已提交的 `tool_result` 产生。仅对名称恰为 `todo_write` 的成功调用，Harness 校验清单后将其序列化为既有 journal 进度事件中的 `todoSnapshot` 字符串。Java 仅转发已完成的 Todo journal 事件中的这个标量，并限制为 16 KiB。其他工具输出和未提交进度继续沿用原有脱敏。不开放通用嵌套输出转发，也不新增接口。

同一属性保存在工具 Item 中，经实时事件、历史重放及快照返回。客户端只识别 Todo 快照，拒绝过时的 source revision，使用已提交输出而非请求参数。失败、取消和 pending 调用不能覆盖上一份成功清单；成功的空列表会清空显示。

只有非空的已提交快照才挂载任务卡片。卡片限制高度并允许内部滚动，为 transcript 保留空间。尚有更早事件未加载时，即使当前没有 Todo 快照，也显示独立的历史窗口提示。这是已加载历史的投影，不是独立的当前状态查询。

## 验收标准

1. `files/3` Session 保留 main 的工具与审批，其他 profile、Plan 准入、生命周期和 MCP 限制均不扩大。
2. 写入清单，在另一个 Turn 更新并重新打开 Session：新请求获得最新清单。命令重试返回原始提交结果，输入不同则冲突。
3. 依赖保留与 core 一致；非法依赖图或合并后超限返回可修正错误，不派发 Runtime。
4. 成功写入触发配置的成功 Hook，拒绝的写入不被视为成功派发。
5. 真实 journal Todo 完成事件经过 Java 投影后，实时事件与持久 Item 呈现相同清单。其他工具载荷保持脱敏，过时或不成功的更新不能覆盖清单。
6. 空列表清空卡片；长列表可滚动且不遮蔽 transcript；未加载历史有可见的限制提示。

## 验证边界

回归源码覆盖持久重放、依赖保留、成功 Hook、journal 快照生产者、Java 脱敏和客户端实时/重放投影。执行结果应记录在 PR 并绑定明确提交。MySQL、远程存储崩溃恢复、完整 Hosted 进程链和浏览器验收需分别记录；源码检查或未执行测试不构成这些结果的证明。
