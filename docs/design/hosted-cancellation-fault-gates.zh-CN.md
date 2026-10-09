# Hosted 取消故障门禁（FG6d）

[English](hosted-cancellation-fault-gates.md) | [简体中文](hosted-cancellation-fault-gates.zh-CN.md)

## 问题与当前行为

Issue #12872 要求取消门禁跨越打包后的 Harness、Session Store、Runtime Broker 和真实 worker。
FG6a 已覆盖预留阶段取消应答丢失，但不能证明工具实际运行中的取消行为。
收到取消应答并不代表工具已经停止。当前私有 Hosted 文件工具配置支持 Read、Write 和 Edit。

## 范围与设计

在现有 Hosted Workspace 集成夹具中增加独立取消驱动。
Spring 和独立 JDBC 断言运行在 Java 测试进程内，打包后的 Harness、真实 worker
和 MySQL/MariaDB 保持独立进程。设计不改变产品协议或行为。

| 场景                 | 注入                                         | 必须满足的结果                                                                                                  |
| -------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `prepared`           | 暂扣真实 prepare 应答，通过 Harness API 取消 | 不 start，不调用 Runtime execute 或 cancel；派发代数为零；结果和 Turn 均为 cancelled；释放 owner；冷加载成功    |
| `running`            | Edit 进入 worker 读取屏障后取消              | 先保持取消待定，无终态 Turn、无结果，owner 不变；只有操作返回后才能结算取消 Turn 并释放所有权                   |
| `status-unavailable` | 运行中取消后使 Harness 的 status 请求失败    | Session 阻塞，无终态 Turn、结果提交或 release；之后物理结算也不能解除阻塞；冷加载准确返回 recovery-required 409 |
| `cancel-reply`       | 运行中取消实际生效后丢弃应答                 | 尽力取消和后续物理结算后仍遵守相同阻塞契约；所有请求保持原执行身份                                              |

worker 导入仅测试使用的 `hosted-file-read-gate.mjs`，包装
`fs.promises.readFile`。备份准备后，驱动在转发 start 前创建
`proof.txt.read-gate`。原生 Edit 到达读取点时，包装器写入
`proof.txt.read-entered`，等待 gate 删除后再调用原 reader。检查取消时，
普通文件保持为 `x`。只观察真实 Runtime transport，不改变其结果：
预留阶段取消没有 execute/cancel 调用，运行中取消时 execute 尚未完成。
独立 JDBC 检查要求 `CANCEL_REQUESTED`、空结果、原存储 owner、
`await_runtime` checkpoint，以及没有终态或结果记录。

对于确认成功的运行中取消，在检查这些事实时暂扣取消后的第一个 status 应答。
对于无法确认的两个场景，在 Harness 报告阻塞前一直保持工具等待。
之后删除 `proof.txt.read-gate`。虽然执行状态是 cancelled，真实 Edit 仍可能完成
一次 `xx` 写入：此配置不会在文件读取中途打断 Edit。
只有预留阶段取消保证零物理副作用。

物理完成后，必须只有一个原执行；已启动场景只有一次派发、cancelled 结果和一次物理效果。
成功场景持久化一个工具结果和一个 cancelled Turn，释放 owner，并在全新 Harness 中加载。
阻塞场景保留 owner 和未结算输入，拒绝新 prompt 与冷加载；重载期间不访问模型或 Broker。
Harness 本地目录中的诱饵文件保持不变。

## 实现边界

- `integration-tests/helpers/hosted-cancellation-driver.ts`：真实 HTTP 故障、worker 读取屏障协调、公开 status/transcript 检查和全新 Harness 重载。
- `HostedWorkspaceToolTurnIT.java`：在现有真实数据库夹具内增加四场景测试，现有 Hosted CI 选择会自动纳入。
- 仅测试使用的取消探针：观察真实 Runtime 调用，在屏障期间和完成后检查 SQL，独立于驱动断言。

HTTP、驱动和测试均有截止时间；退出时恢复 transport 观察，关闭驱动拥有的监听器，
由父夹具强制终止并等待所属 worker 退出，包括读取屏障进入前的失败路径。
清理未知副作用时，不能只为让 Edit 继续而删除仍保持的读取 gate。
保留普通流程和 FG6a/FG6b/FG6c 门禁。两个语言版本保持同步。

## 验证与验收

先使用全局安装的 CLI 尝试基线验证；如果该版本不能进入私有 Hosted 路径，记录这一限制。
之后用打包后的本地 CLI、确定性假模型和真实 MySQL 或 MariaDB 验证。
运行 build、typecheck、bundle、相关 CLI 单测、Checkstyle、四个取消场景及现有 Hosted 对照测试。
确认数据库版本与实际子 worker。

突变必须保持门禁不变，只移除被覆盖的产品保护：信号已中止仍 start、
将 cancel-requested 当作 settled、释放不确定工作，或允许未结算冷加载。
每项突变都必须因行为断言失败；编译、启动失败和超时均不计入。
最终验证前完整恢复原源码和运行产物。

对完整差异做无方向与反向审计，直到连续两轮无问题。第 5 轮之后只接受 Critical 修复。
不包含 Shell/provider 取消、SSE 恢复、自动续跑、孤儿接管、回收或原生 Windows 执行验证。
读取屏障使用普通文件；当前进程夹具仍依赖 POSIX 进程清理。
没有尚未解决的设计问题。
