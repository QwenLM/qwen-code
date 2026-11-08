# 内部 TeamLead 准入与公开前台 Shell 并存

[English](2026-10-11-internal-team-lead-admission.md) | [简体中文](2026-10-11-internal-team-lead-admission.zh-CN.md)

状态：已在 PR #13674 实现，定向本地验证进行中，Linux/MySQL 验收待完成。作者选择保留公开 Shell 边界，并为内部 TeamLead 提供独立准入。Store 探针通过不代表物理 TeamLead 验收。

## 问题与现状

公开前台 Shell 通过默认关闭的部署开关及询问审批开放 `hosted-workspace-shell/1`。其公开 Session 抑制 child agent，因而没有 team 工具，并排除公开生命周期。main 新增的 H4e-b1 进程夹具创建空内置 Session，用 SQL 把 profile 改为 Shell/1，再使用公开输入、Action 和 close。它只开启 Workspace files，两项用例继承 `yolo`。当前持久化数据无法区分这个内部验收环境与公开 Shell。

在 `da4679f3e7242bbee91e0acbf4734578716c1600`，三项 TeamLead MySQL 用例均在首个 Turn 前失败：实际 HTTP409 `workspace_unavailable`，预期202。精确 PR/main 的生产 Store 探针用同样绑定复现差异，拒绝时无新增 Turn。仅开启 Shell 开关只解决第一道守卫；询问审批、child suppression 和公开 close 仍不兼容。

## 目标与范围

保留公开 Shell 策略，恢复明确且可评审的内部 TeamLead 创建路径。身份必须经持久化、重放、child 创建、冷 attachment 与恢复保留。公开 REST/WebShell 创建及存储 AgentDefinition 内容不得取得该身份。内部执行仍受既有 Workspace 授权和 Runtime authority 约束，不新增授权绕过。

本次不新增 HTTP 路由、公开 DTO 字段、部署开关或数据库列。不实现公开 TeamLead、公开 Shell 生命周期、新的后台 Shell/Monitor 准入、files/1 之外的 Workspace 迁移，或在 macOS 上认证 Linux 物理恢复。

## 准入身份

在已有 `tool_profile` 列保留 `hosted-workspace-team-lead/1`。profile 已固定执行策略且被复制到 child 行，再增加独立可变 origin 位会重复表达同一身份。Java 策略谓词继续把 `hosted-workspace-shell/1` 和 `/2` 定义为公开 Shell 家族。认证后的私有 Harness 把内部 profile 识别为 Shell 执行路径，保留既有 child/team 能力，不获得 `/2` search。

| 属性               | 公开前台 Shell                      | 内部 TeamLead                                                |
| ------------------ | ----------------------------------- | ------------------------------------------------------------ |
| 创建               | 既有公开内置/定义准入               | 仅可信 Java Store 入口，固定内置 `qwen-code`                 |
| 持久化 profile     | Shell/1；防御性守卫覆盖既有 Shell/2 | `hosted-workspace-team-lead/1`                               |
| 公开 Shell 开关    | 新 Shell 工作必须开启               | 不控制此私有 profile；仍要求 Workspace files 和执行前提      |
| 审批               | `default` 或 `auto-edit`            | 既有私有配置模式，包含 `yolo`                                |
| child/team 工具    | 抑制                                | 遵循既有 lead/child lineage 规则                             |
| Action 响应        | 仅记录 owner                        | 既有私有 Workspace Action 授权                               |
| close              | 公开拒绝                            | 既有 owner/operator 授权的 protocol-0 close 与 child cascade |
| 公开创建或定义覆盖 | 不得选择内部身份                    | 不开放                                                       |

“内部”描述可信创建来源和固定执行策略，并不对已获得访问授权的 actor 隐藏 Session：既有公开输入、Action 与 close 路由可以在正常 tenant、Workspace、owner 和生命周期检查下操作该内部创建的 Session。这些路由不能修改 profile 或创建另一个内部根 Session。

部署校验不变：开启公开 Shell 时仍拒绝部署级 `yolo` 模式。内部 Session 可以
在公开 Shell 关闭时固定 `yolo`，在后续部署以询问模式默认值开启公开 Shell 时
保留原绑定。内部准入不会绕过启动校验。

## 可信创建与重放

增加 `ManagedAgentStore.insertInternalTeamLeadSessionCommand`，只进行空创建。接收既有 tenant、actor、幂等键/digest、title 和 Workspace selection，由入口自身固定内置身份、当前 revision、私有配置审批及保留 profile。公开请求或定义不会被转发到这个方法。H4e-b1 夹具成为具体调用方，删除 SQL profile 重写。

新内部创建要求 Workspace files 开启、创建者具备创建授权、解析的 registry 为 ACTIVE、执行 config/policy ref 固定、存在准入本地 mount，且 migration state 开放。保留既有 tenant migration lock 及新工作之前的重放顺序。profile、审批、binding、creator/owner 与创建命令一并提交。不得用 UPDATE 把已有公开 Session 转为内部身份。

创建命令键按 actor 和 tenant 共享。即使 request digest 相同，公开重放也必须拒绝内部记录，内部重放必须拒绝公开记录。匹配的内部重试返回原绑定，不重新解析部署策略。在正常重放与公开 DuplicateKey fallback 中均检查类型，不匹配返回 `409 idempotency_conflict`。

## 执行、attachment 与生命周期

Java 谓词明确识别公开 Shell。开关、强制询问审批、child suppression、Shell Action 的 owner-only 规则与公开生命周期排除继续约束这个家族。内部 profile 遵循既有私有行为；registry facts、Workspace access、mount 验证、选定 Runtime、worker fencing 和失败语义保持一致。

Connector 在四处 create/load/冷 lifecycle/rename attachment 路径传递内部 profile，不为其设置公开 Shell suppression。child 插入已复制父 Session 的 profile 与审批，保留这一不可变继承。Harness 在实时准入与存储定义恢复中使用共享 profile 词汇表。未知 profile 仍拒绝，旧 reader 不得把新标识解释为 files。使用可信创建入口前先部署兼容 Harness。

内部 close 使用既有 protocol-0 路径。protocol-1 生命周期及 receipt 仍只支持 files/1。离线 Workspace 迁移也仍只支持 files/1；新增私有执行路径不得扩大这两类验收门禁。

## 公开与定义边界

公开内置创建仍根据既有开关选择 files 或公开 Shell。公开 DTO 不增加内部 profile 选择器。`AgentDefinitionCompiler` 必须硬拒绝保留标识，即使 operator 将它加入部署 allowlist：当前 allowlist 能接受任意 profile 字符串，不能建立内部创建来源。

不需要改变 OpenAPI 结构或生成公开类型。公开 `foreground_shell` 继续描述公开 Shell 家族的能力，既有授权操作 capabilities 描述内部创建记录。保留公开 Shell 负对照，包括初始输入、关闭发送、owner-only Action、child suppression 与生命周期拒绝。

## 受影响层

| 层                                    | 修改或已确认消费方                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Java Store/profile 词汇表             | 保留 profile、可信空创建、重放类型检查；既有 Session mapper/INSERT 与 child INSERT SELECT 传递绑定 |
| Java definition compiler              | 硬拒绝保留 profile                                                                                 |
| Java service、Action Store、Connector | 明确公开 Shell 谓词；保留既有私有授权及 attachment 行为                                            |
| CLI profile 词汇表                    | 在准入/恢复识别私有内部 Shell 执行；不增加 search profile 或公开覆盖                               |
| H4e-b1 夹具                           | 通过可信创建替代 SQL 修改；保留三项原断言及 Linux/MySQL lane                                       |
| 设计/测试文档                         | 两种语言同步，区分现状与已验证证据                                                                 |

## 验证计划与验收标准

使用全局 CLI dry-run 基线，记录其实际 Managed Gateway 限制。进程验证前执行本地 CLI build/typecheck/bundle。运行 package-local 定向测试、Java 编译/静态检查与两轮干净完整 diff 自审，再进行独立代码评审。

验证公开 Shell 开关开启或关闭时，内部创建/重放均保留保留 profile 和审批。公开/内部幂等键碰撞在双向均应拒绝且无新行。无效创建者、缺失 mount、files 关闭、registry 不匹配或 migration 关闭，均在创建前拒绝。公开和定义选择内部标识的尝试不得产生内部行。child 继承私有绑定，冷 Connector 请求保留该绑定且 suppression 为 false。CLI 对照必须声明内部 agent/team 工具，同时公开 Shell suppression 继续有效。

在 CI 的 Linux/MySQL8.4 上运行原三项 `HostedTeamLeadMySqlIT`：两个命名成员及 task/带标签结果流程、lead close 等待成员，以及询问审批卡片。不得跳过或削弱这些用例。本地重跑公开 Shell Allow/Deny 进程对照。本地非 durable/test-script fallback 可以证明较窄行为，不能认证 Linux durable close 或 MySQL receipt 故障门禁。既有本地补充 CLI661/663 失败独立保留，除非直接修复并验证。

只有新 head 的进程门禁通过，才消除该阻塞。线程解决与人类 approval 仍是独立合并要求。

## 风险与开放问题

主要风险是公开输入或定义意外取得保留的内部策略。固定 Store 创建、显式 compiler 拒绝与重放类型检查构成边界；调用方意图或夹具注释不是 authority。另一风险是在冷加载或 child 创建中丢失绑定，由既有持久化 profile 链和定向对照覆盖。

已有 SQL 修改的 Shell 验收记录不会自动取得新私有 profile。在可信调用方创建新的内部 Session 前，它们仍遵循公开 Shell 拒绝。通用内部管理 API、更广的私有 agent 支持和此类记录迁移不属于本次范围。
