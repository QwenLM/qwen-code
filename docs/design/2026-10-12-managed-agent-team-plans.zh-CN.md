# Hosted 团队计划：b3d 实现

[English](2026-10-12-managed-agent-team-plans.md) | [简体中文](2026-10-12-managed-agent-team-plans.zh-CN.md)

## 状态与范围

本文是实现计划，不是验证证据。本切片以前置 PR #13955 已合入 main 的成员消息能力为基础，实现
[成员命令设计](2026-10-11-managed-agent-team-member-commands.zh-CN.md)的决策 9、13 和 14。
不增加 D6 卡片、公开 Actions、只读 shell、迁移或新中继。已有双语设计仍是行为契约。

## 当前缺口

命令通道和成员消息已经存在，但 `plan_submit` 被拒绝。命名启动不能请求计划模式，
也未声明计划提交和队长审批工具。前置批次已提供回滚安全所需的失败关闭前言与按 run
执行的只读限制。

## 实现

- 复用 `team_plan` 记录契约和团队、子任务写链。提交将计划保存为资源，取消被替代的
  等待计划，并以命令 id 为请求 id 开启新修订。重放先查本次已提交的计划，再执行新准入检查。
- 仅向处于计划模式且具备准入资格的成员声明 `exit_plan_mode`，复用持久命令等待。
  每个 run 至多接受一次提交，以持久命令证据判断，不依赖进程内存。未知结果或已交接的
  提交阻止再次提交：未收到答复不代表队长没有接受。
- 仅在计划 domain 启用时，向命名启动声明 `plan_mode_required`，向队长声明
  `team_plan_approval`。所有续跑路径继续遵守现有团队、成员审批规则。
- 决策落库前先准入：必须是最新的等待计划，成员已结算且未请求停止，续跑满足容量、
  启动预算和信封限制。重放与恢复读取以调用键控的持久证据。决定已落库但没有续跑时，
  返回包含请求 id 和恢复指引的分段结果，不声称已交付。
- 成员结果通知与队长任务列表展示等待计划。`show` 只读等待或已决计划。计划替代、
  shutdown、团队删除，以及决策发现成员已结束或已停止时，撤回等待计划。
  计划 domain 关闭时，shutdown 和删除无法撤回，历史计划保持可读和等待状态。
  对已正常完成、未停止且仍有等待计划的成员，shutdown 在副作用前明确拒绝；
  正常完成抢先于停止请求落库时，也明确拒绝。该拒绝不阻止重新启用后决定此计划。
  运行中成员的停止与团队删除仍可使用：已结束或已停止的 head、非活动团队阻止续跑。
  但续跑在启动前停止后可能回退到已完成的前驱，因此回滚期间的 shutdown 并不保证
  阻止所有后续计划决策。已落库提交的重放仍返回原始答复。
- 同步 TS、Java 输入预览清单及测试。b3d 在启用计划 domain 之前就把它加入 Hosted reopen 白名单。

## 集成位置

运行时变更位于 `hosted-team-session.ts`、`hosted-session-command-session.ts`、
`hosted-child-agent-session.ts`、`hosted-workspace-tool-turn.ts`、
`hosted-runtime-recovery.ts`、`hosted-harness-session.ts` 和
`hosted-tool-approval.ts`，并添加同目录测试。现有 managed team 记录助手与 domain
启用配置提供契约；Java 仅按现有实现需要同步启用配置和输入预览位置。

## 约束与验收

- 经 XML 转义和 JSON 编码后的计划必须适配 32 KiB 续跑信封，包含描述、定义、前言、
  决策文本与 4 KiB 反馈预留。队长侧的拒绝会写明计划经 XML 与 JSON 转义后的大小和
  剩余字节数，便于成员缩短到能放下。
- 拒绝、交接前取消或中继拒绝允许修正后再提交；已接受、在途或未知结果不允许。
- 驳回后成员在所有续跑路径上保持只读；首次批准解除后续 run 的计划模式，不改变当前 run。
- 中断的提交、决策与续跑不得重复写记录或启动。延迟重放不得替代更新 run 的计划。
- 所有服务中的 Harness 与部署回滚下限必须包含 b3a。队长一旦落库过 `team_plan`
  记录，所有可能重开它的 Harness 以及回滚下限都必须包含 b3d，即使 `team_plan`
  domain 仍关闭。不含 b3d 的 Harness 会拒绝加载该队长：回应 409
  `hosted_turn_recovery_required`（原因 `restore_verification_failed`），日志中包含
  `Hosted recovery domain is unsupported.`。新 Turn 在准入前重试用尽后被控制面结束为
  `hosted_harness_unavailable`；已准入的 Turn 会一直重试，直到由 b3d Harness 服务该队长。
  启用或合入前必须通过真实栈验证，回滚场景不能要求 b3a 重开其不支持的队长记录。

## 验证

定向测试覆盖准入、大小限制、持久提交去重、各提交边界后的重放、决策预检、分段恢复、
撤回、结果渲染和全部续跑入口。执行 build、typecheck、bundle 与定向包测试。
真实 Hosted 栈使用脚本模型验证驳回、修订、批准后才能编辑；批准前队长发送消息必须
保留计划模式。单独验证回滚安全。按上层设计，启用前真实模型验收需要用户授权。
基础设施不可用必须报告为阻塞，不能记为通过。
