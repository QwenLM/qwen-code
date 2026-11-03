# 用户级 Skill 启停

[English](user-skill-activation.md) | [简体中文](user-skill-activation.zh-CN.md)

状态：实施设计。基线：`71119c6fa0`。

## 问题与目标

宿主需要为用户启用或禁用一个、多个 Skill，而不必自行读取、计算和覆盖配置。
daemon 必须串行完成读—改—写，并将变更传播到已有工作区会话。

本设计区分配置名字操作与实际 Skill 身份。裸名 `pdf` 的规则可能影响多个
Skill；修改 `rust:pdf` 不得隐式移除该规则。持久化不依赖完整发现所有工作区
中的 Skill。偏好保存、刷新排队、实际状态观测是不同结果。

## 公开契约

`PUT /skills/activation` 是进程级接口，写入 User 配置。请求包含 `skillNames`
（1–100 个非空名字）和 `state`（`enabled` 或 `disabled`）。名字去除首尾空白，
按大小写不敏感规则去重，保留首次请求的拼写；长度使用现有 Skill 上限。
`disabled` 可带 `mode`，取值为 `hard`（默认）或 `default`；`enabled` 拒绝
`mode`。全部校验完成后才允许持久化。允许未知名字，支持安装前预配置。

对每个显式请求的名字，将其移至唯一一张 User 名单：

| 请求               | 加入                   | 移除                                    |
| ------------------ | ---------------------- | --------------------------------------- |
| enabled            | skills.enabled         | skills.disabled, skills.defaultDisabled |
| disabled / hard    | skills.disabled        | skills.enabled, skills.defaultDisabled  |
| disabled / default | skills.defaultDisabled | skills.disabled, skills.enabled         |

保留其他名字、其他拼写与其他作用域。已有目标条目的拼写在大小写不敏感的
空操作中保持不变。显式请求裸名时遵循现有配置匹配规则。System 硬限制、
其他拼写的限制以及扩展启用规则继续生效。

响应包含 `scope: "user"`、请求的 `state`、禁用时规范化后的 `mode`、
`results: [{ skillName, changed }]` 和 `propagation`：`queued` 表示至少一个
runtime 已将协调工作排队；`deferred` 表示配置已保存但没有 runtime 排队；
`not_required` 表示配置没有改变。这些值均不证明实际启用。现有工作区
config/runtime 查询提供实际状态和就绪信息。

发布 `user_skill_activation` 能力。TypeScript SDK 提供
`setUserSkillsActivation(skillNames, activation)`。浏览器预检允许 PUT。

## 持久化与归属

使用现有 primary settings 写锁。在锁内重读磁盘配置、计算三张 User 名单和
逐项差异、检查 generation 守卫，再用一次 `setValues` 写入所有变更字段。
空操作不写文件、不发事件。不同名字的并发操作保留双方变更；同名操作按锁
顺序提交。不需要目录读取或 Skill 身份排序队列。

路由使用严格 mutation 门禁，接受任一仍受管 runtime 的客户端，包括尚未移除
的 draining runtime。用户级写入不以工作区信任为前提。提交前 generation
关闭时，沿用 settings 路由的可重试 503 响应。

## 运行时传播

提交后失效配置缓存与受管 runtime 的观测缓存。对每个变化字段广播普通
`settings_changed` 事件，携带 `scope: "user"`。现有消费者会刷新由配置驱动的
Skill 视图。不附加 `skill_toggle` mutation 或未经测量的会话计数。

coordinator 通过 ACP 控制平面向工作区 child 和各 Session 传递可选布尔值
`includeUserSettings`。省略时保持只刷新 Workspace 的行为。User 刷新原子重读
Workspace 与 User 配置；现有合并规则继续排除未信任 Workspace 配置。
原子重读失败必须成为错误，不得计为成功的会话刷新。

分别记录 User 重读的请求数与已确认数。刷新在等待 child 之前捕获请求数，
只有配置与会话刷新均成功时才确认该数值，后到请求继续待处理。普通 Workspace
协调不能抹掉待处理 User 工作。冷启动准备和暂停恢复携带待处理工作；失败遵循
现有有界重试与 runtime epoch 行为。只刷新 Workspace 时的会话失败语义不变。
后续刷新失败不回滚已保存配置，runtime capability 状态呈现失败。

当 Managed 会话仍在线而工作区控制通道为 cold 或 starting 时，继续向在线会话
传播，不因本次写入单独启动控制通道。控制通道也能确认前，保留待处理 User
重读。完全冷态的 runtime 仍等待正常启动。

## 实现边界

修改覆盖 CLI 配置计算、serve 持久化/路由/能力、runtime coordinator、ACP 转发
与 Session 重读、TypeScript SDK 和协议文档。核心身份、权限合并、目录完整性、
Skill 目录/层级设置以及 Managed Agent API 保持现有契约。不需要配置迁移。

## 验证与验收

验证三种转换、别名、未知名字、大小写不敏感的幂等、整批校验及无关配置保留。
并发探针必须先确认进入阻塞点，再测试另一写入。故障测试覆盖重读失败、部分
会话失败、刷新期间的新写入、冷启动/starting/暂停/draining 及有界重试。

test-engineer 先记录全局 CLI 基线，再用隔离配置、多工作区、已有会话和 SSE
验证构建后的 daemon。核对真实 Skill 可用性、设置事件、PUT 预检和 SDK 导出。
运行 build、typecheck、bundle、定向测试、格式和 lint；连续两轮自审干净后交付。
明确记录未测试的平台与故障路径。没有未决产品问题。
