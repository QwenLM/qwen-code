# Hosted Shell 输出故障门禁

[English](hosted-shell-output-fault-gates.md) | [简体中文](hosted-shell-output-fault-gates.zh-CN.md)

## 范围与现状

这是 #12872 中 FG6f 的 Shell 输出部分，基于已合入的 #12848。
显式私有 `hosted-workspace-shell/1` profile 已通过打包 Harness、生产 Broker、
worker 和 HTTP Session Store 执行前台 Shell。已有覆盖包含完整大输出、start 与
原始 write 应答丢失、内容发布失败、取消，以及保留输出的读取。

缺失的门禁针对捕获期间的进程丢失和持久 `tool.receipt` 事务，扩展现有 Hosted
MySQL 集成测试系列，不开放能力，也不改变生产协议。七字段 provider reference
及关闭准入的 release 门禁仍依赖 #12868，不属于本切片。完成本切片不代表整个
FG6f 完成。

## 场景与所需证据

| 场景           | 故障边界                                                                  | 所需结果                                                                   |
| -------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Publisher 丢失 | SQL 已提交一个输出片段且原命令仍存活时，SIGKILL 承载 publisher 的 Harness | 保留的部分输出不能被接纳为完整结果；没有后续模型请求、终态 Turn 或替代执行 |
| Worker 丢失    | 在相同持久前缀边界 SIGKILL 实际 worker                                    | 原执行变为未知；不完整输出不能允许继续                                     |
| 回执失败       | 仅针对该 Session 的 SQL trigger 拒绝 `recordToolResult`                   | 没有已提交回执或暂存的 outcome 资源；物理命令执行一次，但仍阻塞继续        |
| 回执应答丢失   | 应用原回执事务，再丢弃其 HTTP 响应                                        | 恰好一个持久回执及匹配的 outcome；未结算 Turn 仍阻塞，不能重跑命令         |

每个场景验证原预留与派发各一次、选中 Workspace 内一次文件副作用、Harness 目录
的诱饵不变，以及 Workspace 所有权保留。旧 writer 租约过期后，由新 boot 的
Harness 加载同一 Session。冷加载必须拒绝未结算输入，不调用模型或 Broker。
当原 Harness 在故障后仍存活时，新 prompt 也必须被拒绝，返回
`hosted_turn_recovery_required`，且不增加模型或 Broker 调用。
仅有持久回执不能解决现存 `await_runtime` 检查点，也不能授权自动续跑。

## 夹具设计

独立 TypeScript 驱动使用确定性本地模型和既有 Hosted 进程 helper，代理 Harness
的 Store 与 Broker 请求以选择精确故障，并记录原身份和事务字节。Publisher 位于
Harness 内，仅杀代理不能验证 publisher 进程丢失，因此不作为替代。
成功的执行响应必须指向原执行；捕获身份字段必须存在，才能与保存的引用比较。

进程故障场景的命令写入仅追加证明、发布已知的 1 MiB 输出前缀，并等待 FIFO。
注入前必须确认实际已提交的内容资源、处于执行中的 Broker 行，以及原 worker
和 Shell 子进程仍存活。publisher 丢失后，夹具允许原命令完成并访问已死亡的
publisher；worker 丢失后，在清理时回收仍等待的子进程。这样避免依赖定时休眠，
或在工具启动前、输出全部完成后才注入故障。

Java 测试探针独立读取 MySQL 或 MariaDB，核对执行与所有权身份、journal 连续性
和资源哈希，并负责 worker/子进程信号及清理。它只针对选定夹具所拥有的进程。
回执失败 trigger 仅作用于唯一 tenant 和 Session，并在清理时移除。每个场景均
可单独选择，用于故障诊断与突变检查。

## 验证与验收

先以隔离配置和本地模型尝试安装的全局 CLI。若其私有 Hosted profile 不可用，
记录启动限制，不将其作为 Shell 故障已复现的证据。验证使用当前本地打包 CLI 和
真实 MySQL/MariaDB，不用 H2 作为 FG6f 的证明。

运行 build、typecheck、bundle、定向 Shell 与 Hosted 单测、新门禁，以及既有
Hosted 门禁系列。独立于驱动成功标记，核对原执行、持久回执的存在或缺失、检查点、
输出字节与进程退出证据。在隔离突变运行中移除相关生产防护，要求未经修改的门禁
命中行为断言。最终正常运行前恢复源码与产物。

即使注入或断言失败，失败清理也必须回收所拥有的 Harness、worker 与 Shell
进程。对完整 diff 进行无方向及反向审计，直到连续两轮干净；第 5 轮之后仅修复
Critical 问题。

## 边界与风险

门禁验证当前“阻塞、绝不重放”的契约，不验证或实现 worker 接管、租约回收、
自动续跑、公开 Workspace 准入、provider controls、后台 Shell、PTY、远端
provisioner、对象存储或真实模型行为。部分输出和所有权保持保留，直到独立恢复
工作处理。进程控制使用 POSIX 信号，不声明 Windows 覆盖。
