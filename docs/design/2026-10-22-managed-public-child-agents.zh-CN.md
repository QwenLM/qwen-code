# Managed 公开子 Agent

[English](2026-10-22-managed-public-child-agents.md) | [简体中文](2026-10-22-managed-public-child-agents.zh-CN.md)

## 状态与问题

已实现，符合资格的新会话默认开启公开子 Agent，已整合 main `605fd5ee17`。已批准设计使用 main `4515275b1727e8f9b509e2c2aefe97e976293acf`，实现使用更新的隔离工作副本。Hosted child Session、结果中继、任务查询和持久取消原本已存在。此前公开 Shell 关闭 child orchestrator。只解除限制会同时暴露团队、工作流和消息，原 child 创建还会复制父会话初始审批模式，而非启动时的有效策略。本次增加明确的公开准入和不可变启动策略。

## 准入与兼容

`QWEN_MANAGED_AGENT_WORKSPACE_CHILD_AGENTS_ENABLED` 默认 true；设为 false 可关闭新委派。不支持的部署 profile 仍正常启动，不获得公开 child 准入。仅新建的内置 qwen-code、LOCAL 存储、session 隔离的 durable local-process 和 `hosted-workspace-shell/1` 会话符合资格。要求 `public-child-agents/1`、审批选择和匹配的内部 child 关闭能力。符合条件的会话持久化 `public_child_agents_version=1`，旧会话保持 0；child 保留此归属。增量 V17 迁移将旧行保留为零。公开与 WebShell 分别公布 `child_agents` 与 `childAgents`，缺省表示不支持。部署开关关闭后，版本 1 的根会话继续公布编排能力，使已接纳任务保持可见；是否允许新启动单独检查。

创建、加载和恢复均传递公开工具范围。公开会话只暴露普通工具及 `agent`，拒绝团队、工作流、消息、隔离、自定义定义和嵌套委派。部署开关关闭后保留已有任务的编排、恢复能力，但拒绝新启动。内部私有路径保留原工具。SSH、CSI/resident、workspace 隔离和持有长期挂载的 MCP/Hooks 不在首版范围。

恢复 cleanup 和定向取消的 load 同样携带公开版本与模型路由；SDK 复制请求时同时保留原 prompt 身份。迟到的取消只为原 prompt 建立 child 停止屏障，仅释放属于原 prompt 的恢复租约，不影响后续回合。异步等待 child 停止屏障后，取消重新核对原恢复身份与并发受理记录，再同步认领回合；重复请求保留相同回执。

## 执行与所有权

复用现有 child 生命周期，并保留终态结果、父接受和父消费三个独立事实。不可变启动资源记录来源 prompt、有效审批模式与 revision、模型和 Skill 快照。可信 Harness 在提交 launch 前构造这些字段；重放使用已提交资源。Java 在相同租户、Workspace、目录、固定定义及已记录所有者下幂等创建唯一 child，保留执行授权检查。公开 child 不提供独立输入、模型或策略修改入口。

模型快照记录实际准备请求的模型 ID、父模型 revision、认证类型、endpoint 摘要和 provider 配置摘要，不携带凭据或父对话。child 使用自己的模型 revision 1，保留匹配的默认运行时模型，或精确解析已配置的模型路由；认证完成后及每次请求前校验 provider 摘要。父请求使用 fallback runtime view 时，可选 `origin` 记录来源模型 ID 和路由摘要。child 恢复并校验该 base，解析同一个 fallback view，校验完整摘要，再在隔离的 runtime frame 内初始化模型客户端。封装不保存采样参数值或凭据。配置漂移失败关闭。公开 Shell 的可恢复审批批次独立保存这一小型路由 pin，不依赖完整模型请求是否可捕获；原工具 ID 和 revision 在重启后保留。纯 Agent 批次恢复时不获取父挂载。

审批模式在启动时固定，与 CLI/daemon 的时机一致。父会话后续修改只影响新 child。保留 Managed default/auto-edit/yolo 语义，不隐式提升权限。默认后台运行并持久通知结果；前台等待保留现有挂载限制。沿用单层、每 scope 四个活跃 child 和累计 64 次启动的限额。

父 Turn 取消形成持久屏障，阻止来源 prompt 的新 launch 和后续唤醒，再为该回合的活动 child 记录停止请求。恢复继续同一请求，不影响其他回合的 child。迟到结果仍可读取，但不重启已取消的父任务。命令受理、停止已记录和物理终止保持独立；不确定结果不表示成功，也不自动重放。

## 公开 API 与 WebShell

现有动作查询增加可选 `include_children`/`includeChildren`，默认 false。聚合父会话和直接 child，分别验证会话读取权限，保留 Action 真正所属会话，并将分页绑定到租户、父会话与聚合模式。应答继续通过所属会话原路由提交 Action/input/policy revision 和幂等键；聚合不会授予审批权限。

页面可见时每三秒串行刷新聚合审批，独立于任务面板。切换 Session、账号或 Provider 时中止请求并丢弃迟到响应。复用任务面板展示活动数量、待审批、停止中及实际 child 审批模式。任务响应增加 `stopRequested` 和实际 `approvalMode`，任务列表的 `activeChildCount` 返回不受分页影响的活动 child 总数。通过 `childSessionId` 和现有 transcript 读取结果，返回父会话时保留草稿。跟踪取消的 child 至权威终态；取消命令完成本身不足以显示已终止。

[会话生命周期 UI](2026-10-22-managed-session-lifecycle-ui.zh-CN.md) 与 child 委派同时可用。WebShell 生命周期能力保留 actor 所有者校验，公开 child 继续只接收委派输入，并保持不可变策略。按归档状态筛选的 Session 分页和历史导出与聚合 Actions、child transcript 对话框相互独立；打开 child 时保持父会话及其草稿挂载。契约版本 1.87 同时包含生命周期/导出、检查点恢复和公开 child 接口。

## 验证与发布

覆盖关闭开关、旧 host/Session、不支持的 profile、伪造调用、前后台执行、写入/Shell 的允许/拒绝/过期/丢回复、模式修改及重启后的策略固定、取消/启动/完成竞争、重复命令、租户与所有者边界、权限撤销、分页、隐藏面板、迟到响应和多标签页。在创建、前台等待且有待处理通知、结果投递期间重启 Java/Harness。验证资源精确释放及不确定副作用不重放。

执行聚焦包测试、build/typecheck/bundle、Java Maven verify、独立 MySQL 8.4 和 Linux 真实进程 Hosted/WebShell 验收。分别验证契约准入、执行停止、UI 与资格验证。默认开启仅在既有 Runtime 与 Harness 资格检查通过后生效。同步维护共享增量 schema 和 inventory，不修改已发布迁移。设计保持完整双语，E2E 计划同步在 `.qwen/e2e-tests/`。没有未决产品选择。

资格验证使用本地确定性模型端点和独立数据库。E2E 报告分别记录通过场景和中断尝试；单元测试、HTTP 路由测试或通用进程恢复测试都不能证明完整的公开 child 故障矩阵。浏览器渲染和多标签页验收需要独立证据，部署公布这些场景已获资格前必须完成相应验证。
