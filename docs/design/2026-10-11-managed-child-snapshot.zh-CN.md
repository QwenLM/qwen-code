# Managed child 快照与串行共享（隔离切片 I3）

[English](2026-10-11-managed-child-snapshot.md) | [简体中文](2026-10-11-managed-child-snapshot.zh-CN.md)

状态：在本变更中实现。已落地：hosted child agent 可以作为其父 Workspace 的只读快照运行（`isolation: "snapshot"`）。child 读取一份冻结的副本，即一个总会被丢弃的 child Workspace，所用的工具 profile 不声明任何写入工具。串行化的裁定为最终结论：串行共享没有单独的取值。这是 [#13753](https://github.com/QwenLM/qwen-code/issues/13753) 的 I3，建立在 I1（[child Workspace 能力](2026-10-09-managed-child-workspace.zh-CN.md)，#13781）与 I2（[worktree 准入](2026-10-10-managed-child-worktree-admission.zh-CN.md)，#13841，及其跟进 #13872）之上。

## 问题与范围

Issue #13753 对 I3 提出两点：

- **视图。** “父绑定的只读冻结视图（如果有 provider 能提供）。”验收：“`snapshot` child 无法写入。”
- **串行化。** “决定在 Workspace lease 之外是否还需要按 child 的 generation/barrier，如果需要，用哪个取值命名它。”验收：“同一父的两个串行 child 不能同时持有同一个 generation，或者该决定记录下为什么 lease 已经保证了这一点。”

方向已记录在 I1 决策 15：`snapshot` 复用 child Workspace 能力，child 的工具 profile 拒绝一切写入。I1 留下一个问题：profile 级别的拒绝是否足以作为“不能写”的证据？本设计回答这个问题，并确定细节。维护者于 2026-10-11 裁定：

- 拒绝方式是在丢弃的 child Workspace 之上使用只读 hosted profile，而不是操作系统层面的只读沙箱；
- 该 profile 只声明 `read_file` 与 `glob`。

## 现状

以下事实基于 `main` 的 `415925cbda`，此时 schema 合并（#14069）已把 child Workspace 移入 `ma_workspace`（类型 `CHILD_GIT`），其步骤状态位于 `ma_operation`。

**Profile。** hosted 工具 profile 有 `hosted-workspace-files/1..2`（`read_file`、`write_file`、`edit`，`/2` 另有 `glob`）、`hosted-workspace-shell/1..2`（再加 `run_shell_command` 与 `monitor`），以及团队 leader 的 Shell profile `hosted-workspace-team-lead/1`。创建、加载与 Workspace 恢复读取同一套词汇（`hosted-workspace-profiles.ts`）。

**唯一的强制点。** hosted tool turn 会在获取 Broker 之前拒绝任何未声明名称的调用，并结束该 Turn（`hosted-workspace-tool-turn.ts` 中的 `prepareRequests`）。它之下没有任何地方强制 profile：

- Broker 只检查载荷的形状；
- worker 以 YOLO 模式构建所有文件与 shell 工具。

**没有操作系统沙箱。** hosted 路径中没有任何工具运行在沙箱里。

- local-process Broker 用普通的 `ProcessBuilder` 以控制面的用户启动 worker。
- 按命令生效的 `tools.executionSandbox`（bwrap 或 Landlock，可以只读挂载）只支持 Linux，而且 `qwen serve` 配置了它就拒绝启动。
- 因此 shell 不受任何限制。
- child Workspace 位于父的 storage 之内，所以 child 的 shell 能触及父的目录树。

**Child。**

- **Profile。** child Session 在 `ManagedAgentStore.insertChildSession` 中复制父的 `tool_profile` 与 `approval_mode`（`INSERT … SELECT`）。child 只存在于带 Shell lane 的父之下，所以今天每个 child 都有 `run_shell_command`。
- **Relay。** `ChildResultRelay` 只在 `workspaceMode` 为 `worktree` 时把 run 当作隔离的。其他任何模式（包括 `snapshot`）都会把 child 创建在父的目录里。
- **准入。** TS 在准入时拒绝 `snapshot`（`MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` 为 `['shared', 'worktree']`）。两种语言的记录契约都已接受这个取值。

**消息与 lane。**

- child 只能通过自己的消息 lane 接收 Session 消息（H4d-b），而这个 lane 只存在于 Shell lane 上。
- 没有该 lane 的 Session 对消息路由答以 `409 hosted_messages_unavailable`。
- 今天父的 `send_message` 会向任何运行中的 child 发送。

**Lease。** 一个 storage lease 串行化 storage 的每个写入方：父、`shared` 与 `worktree` child，以及 child Workspace 维护（I1 决策 1 与 10，H4b 决策 3）。

## 决策

1. **由模型按每次 launch 选择。** managed `agent` 工具的 `isolation` 参数增加第二个取值 `"snapshot"`。
   - **何时出现。** 只在提供快照的主机上出现（决策 2）。那里的枚举是 `["worktree", "snapshot"]`；只提供 child Workspace 的主机上仍是 `["worktree"]`。团队版本（H4e-b1）同样获得它。
   - **记录。** launch 记录 `workspaceMode: "snapshot"`，即 H4a 已定义的固定键与取值，所以每个后续修订与重放都带着它。`MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` 变为 `['shared', 'worktree', 'snapshot']`。
   - **告诉模型什么。** 声明说明 child 需要 Git 仓库，读取这个 Workspace 在它开始时的冻结副本（决策 3；child 必须看到的修改要在启动前完成），不能修改文件、不能运行命令，也不接收消息。因不支持快照而拒绝时，提示从不把可写的 launch 当作替代方案。团队版本的声明还说明成员不能作为快照（决策 6）。

2. **能力有自己的开关。**
   - **配置。** 新的运维属性 `qwen.managed-agent.runtime-broker.child-snapshots-enabled`（默认关闭）要求 `child-workspaces-enabled`，单独开启时启动会拒绝。开启后，Java 在每个 hosted 创建与加载请求中，于 `childWorkspaces: true` 旁边加上 `childSnapshots: true`，与 I2 决策 2 加入其标志的方式相同。
   - **准入。** 只有当 Session 最近一次被证明的创建或加载同时带有两个标志时，TS 才放行 `snapshot`。否则 `admitChildLaunch` 在任何东西提交之前以 `workspace_mode` 拒绝它。重放的 launch 从不重新准入。续跑像任何 launch 一样重新准入。与 `worktree` 一样，这个取值在所有主机上都能通过参数校验，所以开关打开时已提交的 launch 在开关关闭后仍能重放；因此没有开关的主机在准入阶段拒绝新的快照 launch，并给出专门的说明，而以前它会答以参数错误。
   - **为什么要单独的开关。** 本变更之前的副本把 `snapshot` 当作 `shared`：它会以父的 Shell profile 在父的目录里创建 child，也就是一个写入者。
     - 本变更逐台副本滚动上线时，child Workspace 可能已经开启。滚动期间，新副本可能宣告支持快照，而老副本认领了这个 run。
     - 这个开关给运维一个开启快照的时机：所有控制面副本都运行本变更之后。
     - 本变更之前的副本在新副本迁移数据库后仍会继续运行，但一旦 #14316 及之后的服务端迁移过数据库，它就无法再启动：它的启动 schema 检查会拒绝这些迁移新增的列。因此开关防护的窗口，持续到升级前启动的最后一台副本被替换为止。
     - 之后关闭它只会停止新的准入。已提交的 snapshot run 仍按快照运行。
     - 回滚同理：把任何副本退回到本变更之前的版本前，先关闭开关，等所有未结算的 snapshot run 结算完（或其父关闭），包括仍在创建 child、还没有 child Workspace 行的 run。开关关闭前已开始的 Turn 仍保有它开始时的能力，所以要等正在运行的 Turn 结束后再做这项检查。较旧的 relay 会把尚未创建的 snapshot run 创建为共享的写入者，并且直到父关闭才会丢弃它的副本。只有在 #14316 及之后的服务端从未迁移过的数据库上，控制面副本才能退回到本变更之前；在其他数据库上，较旧的服务端会拒绝启动。较旧的 `qwen serve` 会拒绝只读 profile，而 Workspace 恢复会检查 storage 中的每个 Session，包括已关闭的，所以对存有 snapshot child Session 的 storage，即使该 Session 已关闭，它的恢复也会中止。把 CLI 回滚到本变更之前，就放弃了对这些 storage 的 Workspace 恢复。

3. **冻结视图是一个 child Workspace。** relay 准备 snapshot run 的 child Workspace，方式与准备 worktree run 的完全相同（I2 决策 3）。
   - **包含什么。** 基线是 I1 对父工作树的快照提交：已跟踪与未跟踪的文件，不含被忽略的文件。
   - **何时拍摄。** 在准备 child Workspace 时拍摄，准备需要获取 storage lease（I1 决策 10）。前台 launch 在其 Turn 持有 mount 时会被拒绝，而它的 Turn 会等待它，所以父的任何 Turn 都不会在拍摄副本之前改动目录树；但兄弟的合并或 `shared` 兄弟的 tool turn 仍可能改动。后台 launch 的副本可能落在发起它的 Turn 后续修改之前，也可能在之后：该 Turn 持有 Workspace 时准备会等待，但一个批次未持有 Workspace 的 Turn 可能在副本拍摄之后才写入。此后副本即被冻结。告诉模型的是：副本在 child 开始时拍摄，child 必须看到的修改要在启动它之前完成。
   - **绑定。** child Session 创建在这份副本里。
   - **拒绝。** 被拒绝的布局（没有 Git 仓库、稀疏检出）、被阻塞的准备、没有该能力的主机，或无法接纳该行的父，会把 run 以 `creation_failed`（从未启动）结算，与 `worktree` 相同。
   - **为什么用副本。** 父继续写入时，视图保持在 launch 时的样子，而且父的目录树永远不会成为 child 的工作目录。

4. **“不能写”就是 profile，并由存储层设置。**
   - **Profile。** 新的 hosted profile `hosted-workspace-read/1` 只声明 `read_file` 与 `glob`，无论 Session 有什么 lane、child 编排或 MCP：不声明 `write_file`、`edit`、`run_shell_command` 或 `monitor`，不声明 Agent 或团队工具，不声明 `send_message`、MCP 工具或 `skill` 工具。只读 profile 的 Session 也不从 agent definition 获取 skill 目录：目录的说明会提到一个该 profile 拒绝的工具，而未声明的调用会让 Turn 失败。
   - **由谁设置。** 只要 child 绑定的 child Workspace 行记录的是 `snapshot`，`insertChildSession` 就给 child 只读 profile。它在检查该行就绪的同一个事务中读取该行，所以任何调用方都无法把快照副本绑定到可写的 profile 上。只有 profile 不同；审批模式仍是父的。
   - **审批。** `read_file` 与 `glob` 在 `default` 与 `auto-edit` 下都预先批准，所以 snapshot child 自身不发起审批询问。
   - **保留 hooks（#13905 第 37 项）。** child Session 沿用父的 agent definition，所以自 #14319 起，snapshot child 像任何 child 一样运行父的 hook 目录。
     - **为什么。** hook 目录是运维的策略，不由模型选择。`PreToolUse` hook 可以拒绝 `read_file` 或 `glob` 调用，或改写其输入，例如阻止读取密钥。如果去掉 hooks，只要模型选择 `isolation: "snapshot"`，snapshot child 就能读到同一个 agent 在其他任何地方都被拒绝读取的内容。skill 目录被去掉另有原因：它的说明会提到该 profile 拒绝的工具，而 hook 不向模型提供任何工具。
     - **代价。** 下面这些都不是 snapshot 特有的：
       - `PreToolUse` hook 可能发起询问，所以 child 可能像任何 child 一样等待审批；
       - hook 命令以副本为工作目录运行，所以它在副本内写入的内容随副本一起丢弃。但它没有隔离：写到副本之外的内容（例如写到绝对路径的日志）以及其他任何副作用，都不会随丢弃消失；
       - Runtime 被替换后恢复的 turn 通过 Session 的 Hook owner 重新 acquire，而不走决策 8 的第 3 步路径；该路径只服务既没有 hooks 也没有 MCP 的 Session，`hosted-workspace-files/1` 也是如此；
       - command、http 或 function 类 hook 一旦运行，child 的 Hook owner 就会一直占用 storage，直到 child Session 关闭，任何 Session 的 Hook owner 都是如此，所以父的工具回合以及其他 child 的工具回合都要等到那时。因恢复而阻塞的 turn 可以更早释放：一旦确认其 hook 工作已结束或从未派发，owner 就会归还 mount，而 Session 仍保持打开。
   - **凭什么成立。** 每一环本来就对所有 hosted Session 成立：
     - 声明集合中没有任何会写入的工具；
     - tool turn 在获取 Broker 之前拒绝任何其他名称，并结束该 Turn；
     - 文件路径相对于 child 在副本中的目录，拒绝绝对路径与 `..` 段。
   - **不声称什么。** 它不是操作系统边界。操作系统层面的只读沙箱经过权衡没有采用：hosted 路径中没有沙箱，唯一的实现只支持 Linux，而且 `qwen serve` 拒绝它。若保留 shell，它还得限制一个位于父 storage 之内的进程。没有 shell，child 能用的工具里就没有任何会写入的。副本还位于父的 storage 之内，所以它只是相对控制面与 child 自身冻结，而不是相对父或兄弟不受限制的 shell：后者仍可能在 child 的两次 turn 之间改动它。

5. **快照从不合并。** 快照的 child Workspace 把模式记录在其 child Workspace 操作的请求中（`ma_operation.request_json` 里的 `workspaceMode`），该请求在行被准入时写入一次，之后从不改写。没有指名模式的请求属于 worktree，所以 worktree 行（包括本变更之前准入的所有行）都读作 `worktree`，其请求保持原样。这不需要 schema 变更。`snapshot` 行的每次收尾都是丢弃。
   - **relay** 从不请求快照的合并，也从不为合并扣住结算。完成的 snapshot run 提交结果时回执不带 `workspace` 成员，也没有 workspace 行到达父的模型：child 什么也没改。
   - **丢弃** 随结果提交一起请求，在 child 关闭后执行（I2 决策 4）。失败、停止与放弃分支以及关闭级联对它的丢弃与 `worktree` 相同。
   - **存储层** 把对快照行请求的合并记录为它本来就是的丢弃。relay 从不请求合并；这条规则防止一次误发的请求停放一个永远无法执行的合并。本变更之前的存储层会照录较旧 relay 对任何就绪行请求的合并，所以扫描也把记录在快照行上的合并按丢弃执行。
   - **行的模式是固定的。** 对已有行指名另一种模式的请求是冲突。
   - **未知模式按关闭处理。** relay 遇到它不支持的 `workspaceMode` 时，把 run 以 `creation_failed`（从未启动）结算，而不是按 shared 创建。记录契约只接受三个取值，所以这是为将来的模式防备较旧的 relay。

6. **snapshot child 运行期间不接收消息。** 它没有消息 lane（决策 4）。
   - **发送时拒绝。** 父的 `send_message` 拒绝运行中的 snapshot child，工具错误会说明原因，并建议等待其结果。无论按 `task_id`、按成员名还是在广播中寻址都如此，广播中该接收者的那一行会说明。拒绝位于 `sendToChild`，即所有形式都走的那条路由，所以不会提交 child 永远无法接收的消息。
   - **为什么在发送方拒绝。** 到达没有 lane 的 Session 的消息会让消息 relay 一直重试，并扣住 child 的结算（H4d-b 决策 8），直到 relay 放弃。
   - **已完成的 snapshot child** 照常续跑。续跑是一个新的 snapshot run，会按父目录树当时的样子准备一份新的副本。
   - **团队成员不能作为快照。** 成员的指令告诉它用 `send_message` 向 leader 提问，leader 也通过消息给它派活（H4e-b2）。快照两者都不具备，而未声明的调用会让成员的 Turn 失败。所以 Agent 工具把带 `name` 的 `isolation: "snapshot"` 当作参数错误拒绝，在任何东西提交之前；从团队 Session 启动的普通 child 仍可以是快照。拒绝提示只建议主机支持的隔离方式。

7. **Glob 的推广。** 只读 profile 使用 `glob`，而 #13166 把 glob 的推广定为由运维执行：排空旧 worker 并升级每个 provisioner。child 快照只在 durable local-process Broker 上运行，它从已安装的 CLI 启动 worker。运维只在完成该推广之后才开启快照（决策 2）。较旧的 worker 对 `glob` 答以工具错误，绝不会写入。

8. **恢复能读取新的 profile。** `hosted-workspace-read/1` 加入已保存 profile 的词汇，所以创建、加载与 Workspace 恢复都接受它。
   - 恢复不认识的 profile 会中止整个共享 storage 的恢复。W1b 把 hosted 文件与 Shell profile 放在那个捕获闭包之内。
   - 存储迁移仍只接受 `files/1` Session，所以带有存活 snapshot child 的父会被拒绝，与带有任何 Shell child 的父一样。
   - 既没有 hooks 也没有 MCP 的 Session，其已提交的读取结果在 Runtime 被替换后仍可恢复（决策 4）。G3 第 3 步的路径（#14059）不重新 acquire 已退役的 owner，直接恢复 `results_ready` checkpoint；它在 `hosted-workspace-files/1` 之外也接受只读 profile。只读 profile 的批次永远只有 `read_file` 与 `glob`，正是该路径本就允许没有文件历史而恢复的批次。

9. **串行共享不需要单独的取值（最终）。** 这确认了 I1 决策 15。
   - **保证。** storage lease 一次只接纳一个 holder，storage 的每个写入方在写入前都获取它：父、`shared` 与 `worktree` child，以及 child Workspace 维护。snapshot child 的读取也获取它。所以同一父的任何两个 child 都不能同时持有 storage。
   - **generation 就是 lease 的 holder。** 2026-10-04 问题框架要求的 barrier 已经存在。为它命名的取值不会增加 lease 没有强制的规则。
   - `workspaceMode` 保持三个取值。

## 非目标

- 操作系统层面的只读边界，或给 snapshot child 的 shell。
- 更多读工具（内容搜索、目录列表）：`read_file` 与 `glob` 是 worker 今天提供的。
- 读取被忽略的文件，或为 Git 仓库之外的目录做快照。
- 父目录树的实时只读视图：issue 要求的是冻结视图。
- snapshot child 与父之间的并发：lease 仍串行化它们的 tool turn。
- 作为快照的团队成员（决策 6）。
- `workflow` child，仍保持禁用。
- 任何公共契约变更：OpenAPI 契约、路由与记录体保持不变。没有 schema 变更：模式随 child Workspace 操作的请求保存。

## 涉及文件

- **`packages/core/src/managed-runtime/managed-child-operations.ts`：** 准入的模式与快照能力的拒绝。
- **`packages/cli/src/serve/`：**
  - `hosted-workspace-profiles.ts`：只读 profile；
  - `hosted-workspace-tool-turn.ts`：只读声明、`isolation` 取值及其准入；
  - `hosted-tool-approval.ts`：在只读 profile 上预先批准 `glob`；
  - `hosted-harness-session.ts`：创建与加载时的 `childSnapshots` 标志；
  - `hosted-child-agent-session.ts`：拒绝给运行中的 snapshot child 发消息，以及续跑的准入。
- **`packages/sdk-java/qwencode`：** `CreateHarnessSession` 与 `LoadHarnessSession` 携带 `childSnapshots`。
- **`packages/managed-agent-server`：**
  - `ManagedAgentProperties`：开关；
  - `QwenHostedHarnessConnector`：标志；
  - `ChildResultRelay`：为两种模式准备、丢弃快照、不给它回执成员；
  - `ChildWorkspaceStore` 与 `ChildWorkspaceService`：操作请求中的模式，以及把对快照行请求的合并记录为丢弃；
  - `ManagedAgentStore`：绑定到快照行的 child 使用只读 profile；
  - `WorkspaceToolProfiles`：`READ` 常量，即 profile 词汇表的 Java 副本。
- **文档：** 各处的测试、本设计的两种语言版本，以及 I1、I2 与 G3 第 3 步恢复设计中的说明。

## 验证

- **准入**（`managed-child-operations.test.ts`）：只有同时具备两个主机标志时才放行 `snapshot`；只有其中一个时拒绝；snapshot 标志对 `shared` 与 `worktree` 毫无影响。
- **Agent 工具**（`hosted-workspace-tool-turn.child-agent.test.ts`，新增 6 个用例、更新 1 个；`hosted-workspace-tool-turn.team.test.ts`，新增 2 个用例；`hosted-child-wait-recovery.test.ts`，新增 3 组参数）：
  - 快照声明（普通版与团队版）就是 worktree 声明再加 `snapshot`，只有同时具备两个标志的主机才看得到（只有 snapshot 标志时团队版仍是普通声明），且只有团队版说明成员不能作为快照；
  - 没有 snapshot 标志或没有 child Workspace 的主机，在任何记录之前以专门的说明拒绝快照 launch，两种说明都不会建议可写的 child；
  - 具备能力的主机上 launch 记录为 `snapshot`；任何其他 `isolation` 都是参数错误，且只列出主机提供的取值；
  - 在具备能力的主机上，不指定 isolation 的 launch 或成员仍以 `shared` 运行；
  - 快照成员在任何提交之前被拒绝，而普通快照 child 会被准入；
  - 前台快照的回答、已启动快照 child 的失败，以及恢复时折叠的快照孤儿，都不带 `[child workspace]` 行；
  - 运行中发给快照的消息被拒绝后，完成的快照 child 可以通过两种形式的 `send_message` 续跑为快照。
- **只读 profile**（`hosted-workspace-tool-turn.test.ts`，新增 7 个用例、更新 1 个；`hosted-workspace-tool-turn.child-agent.test.ts`；`hosted-tool-approval.test.ts`；`hosted-workspace-profiles.test.ts`）：
  - 它在任何 lane 上都声明 `read_file` 与 `glob`，即使 turn 带有 Shell lane 与第 0 层的 child 编排，也不声明其他任何工具；
  - 两个工具都能派发到 Broker；
  - `write_file`、`edit`、`run_shell_command`、`monitor`、`agent` 与 `send_message` 都在获取 Broker 之前被拒绝；
  - 两个读工具在 `default` 与 `auto-edit` 下都预先批准，且 `glob` 只在 `/2` 与只读 profile 上预先批准。
- **消息**（`hosted-session-message-session.test.ts`）：snapshot child 运行期间（attach 前后）都会被拒绝，且不提交任何东西，而运行中的 worktree child 仍能收到消息；快照完成后，只有在提供快照的主机上才续跑，续跑为 `snapshot` run；正在关闭的 Session 的拒绝不承诺续跑。
- **主机标志与恢复**（`hosted-harness-session.test.ts`，新增 3 个用例；`workspace-recovery-session.test.ts`）：只有创建或加载重申了两个标志时才宣告 `snapshot`（只有 snapshot 标志或文本 `"true"` 都不算）；只读 profile 的 Session 可以创建，并声明它的两个工具；agent definition 发布了 Skills 时也不获取 skill 目录；恢复接受只读 profile，带捕获容量时仍会拒绝。
- **Runtime 被替换**（`hosted-recovery.test.ts`，新增 2 个用例）：只读 profile 的 child 在 `read_file` 结果提交后 Runtime 被替换，恢复已保存的模型请求而不重跑工具，释放原 owner，并拒绝该 Turn 中的新工具调用。
- **Relay**（`ChildResultRelayTest`，新增 6 个用例）：
  - snapshot run 以自己的模式准备副本，并以隔离方式创建 child；
  - 完成的快照立即提交，回执不带 `workspace` 成员，只请求丢弃；
  - 消息仍在运行时，它已完成的任务不请求合并；
  - 超出上限、停止与放弃分支都立即结算它，请求丢弃，从不请求合并；
  - relay 不支持的模式以从未启动结算，不创建任何东西；而写明 `shared` 的 run 以共享方式创建 child。
- **Child Workspace 状态机**（`ChildWorkspaceServiceTest`，新增 4 个用例，H2 加真实仓库）：
  - 快照副本包含父未提交与未跟踪的文件，不含被忽略的文件；
  - 它的 child Session 获得的正是 `hosted-workspace-read/1` 与父的审批模式；
  - 对它请求的合并被记录为丢弃，写进副本的文件永远不会到达父，行以 `discarded` 结束且不留 pin；
  - 按原样记录在它上面的合并（较旧 relay 的存储层就是这样记录的）仍按丢弃执行，写进副本的文件不会到达父；
  - worktree 的请求不指名模式，其行读作 worktree，会合并，并保留父的 profile；
  - run 的模式是固定的。
- **控制面接线**（`ManagedAgentPropertiesTest`、`QwenHostedHarnessConnectorTest`、`HostedHarnessClientTest`）：开关默认关闭，没有 child Workspace 时拒绝开启，在有效的 child Workspace 配置旁可以正常启动；只有开关开启时，`childSnapshots` 才随创建、加载、恢复、生命周期结算与消息停止加载发送，经过每一次请求复制都保留，且从不在没有 `childWorkspaces` 时出现。
- **流水线**（基于 `main` 的 `415925cbda`）：
  - 与 CI 一致的 MariaDB 流水线（`-Pmysql-integration clean verify checkstyle:check`，使用 CI 的 64 MiB 包上限）：2762 个单元测试与 548 个集成测试，Checkstyle 与 SpotBugs 干净；另有 `qwencode` 的 `HostedHarnessClientTest`。
  - 干净 `pnpm` worktree 中的 TypeScript：core 与 CLI 的 `tsc`，所有改动文件的 ESLint 与 Prettier，core `managed-runtime` 套件（3402 个测试）与 CLI `serve` 套件（14828 个测试）。
  - 其中的失败都与本变更无关，每一个在同一主机的 `main` 上都同样失败：
    - 两个 Java 测试类：`WorkspaceCsiNativeActivationGateTest`（16 个）与 `ManagedExtensionRecordStoreTest`（4 个）；
    - 三个预期写入失败的 `serve` 测试（以 root 运行时写入不会失败）。
- **合入 `main` 的 `8bd79c9192` 之后**（该提交把模块移到了 `packages/managed-agent-server`）：
  - 同一流水线运行 3870 个单元测试与 673 个集成测试，Checkstyle 与 SpotBugs 干净。唯一的失败是 `SessionRowLockOrderTest`（`Row.snapshot/0` 的锁顺序固定项），已在本变更中修复；修复后单元套件运行 3871 个测试，无失败；
  - CLI `serve` 套件运行 15018 个测试。`managed-runtime-tool-executor.test.ts` 中一个计时测试在高负载下失败，单独重跑三次均通过。
- **变异检查**：47 个变异，每个关掉一处守卫（Java 24 个，TypeScript 23 个），全部变红；两轮评审又分别新增 6 个与 11 个，同样全部变红。另有一个变异（从团队形式的 `send_message` 中去掉 snapshot 标志）是等价的（该形式只到达成员，而成员永远不是快照），不计入。

## 验收标准

- **不能写。** `snapshot` child 无法写入：它声明的工具是 `read_file` 与 `glob`，任何其他调用在到达 Workspace 之前就被拒绝。
- **冻结。** 它读取的是父目录树在 launch 时的样子，无论如何结束，它的副本都会被丢弃；它的任何部分都不会合并。
- **受开关控制。** 没有快照开关的主机在任何东西提交之前拒绝 `isolation: "snapshot"`。
- **消息。** 运行中的 snapshot child 永远不会收到它无法接收的消息。
- **串行化。** 串行化的裁定记录了为什么 lease 已经保证一次只有一个 holder。
- **无回归。** `shared` 与 `worktree` child 的行为与之前完全一致。

## 开放问题

1. **读取所用的 lease。** snapshot child 的读取是否应跳过 storage lease？它读取的副本只有控制面会写入。跳过可以让它与父并行运行，但 lease 现在也覆盖对这份副本的 child Workspace 维护。留待以后的需求。
2. **更多读工具。** 内容搜索或目录列表会让 snapshot child 更有用。每一个都需要 worker 工具与 Broker 载荷形状。
