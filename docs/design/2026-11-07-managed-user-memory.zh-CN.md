# Managed Agent 用户记忆

[English](2026-11-07-managed-user-memory.md) | [简体中文](2026-11-07-managed-user-memory.zh-CN.md)

## 状态与问题

实现设计，2026-11-07。Hosted Harness 有意关闭环境中的本地记忆。现有 Mem0
集成提供可复用的 HTTP 与工具语义，但本地配置和工作目录检查不是租户鉴权。
Managed 需要持久化、由调用方显式选择的跨 Session 个人记忆。

## 行为与归属

每个经过认证的 `(tenantId, actorId)` 拥有一个个人 MemoryStore，创建操作幂等。
Session 创建接受可选 `memory_store_id`（WebShell 为 `memoryStoreId`）。省略即完全
关闭记忆。传入的 Store 必须属于创建者；不可变绑定参与创建摘要和事务。恢复读取
原绑定。同一所属用户可以在多个有权访问的 Workspace 中选择同一个 Store。

绑定后的 Session 除现有 Workspace 授权外，仅所属用户可见。列表、详情、SSE、历史、
产物、工具和修改入口均在服务端执行检查。接收私有上下文的子 Session 继承仅所属用户
可见的属性，但不继承记忆访问权。禁止把私有上下文转发到共享 Session。Workspace
文件保留现有共享权限。关闭记忆不关闭 Session 历史。删除记忆影响后续检索，不改写
已记录的历史或已准备的模型请求。

## 接口与持久化

`POST /v1/agents/memory-stores` 创建或返回当前用户的 Store；
`GET /v1/agents/memory-stores` 返回该用户的 Store（零或一个）。两者均不接受租户或
所属用户选择参数。公开接口和 WebShell 创建请求透传可选绑定。OpenAPI、
SurfaceRegistry 和 WebShell 生成类型同步更新。

SQL 保存 Store 归属及其不透明 Mem0 namespace、条目 ID 与删除标记、Session 绑定和
仅所属用户可见属性。Mem0 保存记忆正文。现有请求 receipt 表增加记忆 namespace：
Session、已接收输入和 tool call 标识操作，请求摘要拒绝冲突重试。Receipt 结果还保存
有界的召回上下文用于恢复。首次正式发布前直接修改共享 V1 schema baseline，并重建
开发数据库。

持久化 facade 保留公开入口和事务注解。访问校验、模型目录验证、可见 Schedule 查询、
消息路由校验及 CSI 身份字段元数据使用同包小型 helper，遵守现有类大小门禁。
已固定的上限向下收紧；锁与事务边界保留在原有入口。

## 执行与恢复

Hosted 使用 writer 凭据，通过内部 Session Store 通道调用受控 Memory Service。
鉴权、writer generation 校验及 receipt 受理在同一个短事务内完成。Mem0 HTTP 调用
在事务和 Session 锁之外执行。部署配置使用专用 Mem0 服务并关闭跨服务共享，地址和
API Key 不进入模型、沙箱或 MCP 配置。Managed 注入 Store 的不透明 `user_id`；
provider 过滤条件不是鉴权边界。

部署使用 `qwen.managed-agent.memory.enabled`（默认 `false`）、
`qwen.managed-agent.memory.endpoint` 和 `qwen.managed-agent.memory.api-key`。
启用要求已开启 Session Store，且 Harness 声明 `session-memory/1` 能力。纯记忆工具
批次不获取 Runtime Broker 绑定，其持久化审批 continuation 使用 `runtime:null`，
仅允许四个记忆工具且不能带 command-step 或子模型执行。混合批次保留现有 runtime
要求。

审批恢复分别校验通用 envelope、纯记忆批次限制和 Runtime 身份，不改变已保存的
continuation 格式。同一工具批次内，记忆调用复用一次历史投影及原始 assistant 批次
之前的已接收输入标识；下一批次重新读取历史。恢复仍先重放已提交结果，再分发操作。

每个新接收的真实用户输入（包括排队输入）从原始文本触发召回。沿用现有查询清洗，
截断前通过共享 secret scanner 和规则检查已知凭据形状，命中时跳过召回。检查覆盖
Basic 请求头与裸编码的用户名/密码、带密码 URI（含协议相对形式）、curl 的
`-u`/`--user` 用户名/密码参数、具名密钥参数、`sshpass -p`、MySQL/mysqldump
紧随参数的 `-pPASSWORD`、`docker login -p` 及 `redis-cli -a`。这些检查识别已知模式，
并不穷尽所有凭据。不向 provider 发送空查询。普通 Basic-auth 说明、仅用户名参数与
无关短参数（包括 MySQL/Redis 端口和 Docker 发布端口）仍可参与召回。召回限制为
查询最多 512 字符，最多五条结果，注入上下文最多 4,000 字符，provider 截止时间
五秒。结果为非可信参考材料。恢复复用该输入已保存的结果；工具输出和后台续跑不触发
召回。Provider 不可用不导致主任务失败，鉴权或 fencing 失败则拒绝操作。

成功的绑定校验在驻留 Session 中缓存。绑定读取失败会拒绝当前操作，但不缓存失败：后续
用户输入可以重新校验同一个不可变绑定。这不会自动重试失败输入或任何记忆写删操作。

绑定后的 Session 提供 `context_search`、`context_remember`、`context_get` 和
`context_forget`，参数不含身份、namespace 或 endpoint。仅用户明确请求时允许记住或
删除，并遵循现有工具审批及 Plan Mode。保存使用 `infer:false` 和用户要求的准确内容。
删除先验证 SQL 条目归属、Mem0 权威 scope 及完整预期内容，再执行删除。成功后保存
删除标记，屏蔽搜索索引的残留命中。不增加更新或批量删除 API。

成功结果先持久化，再返回工具结果。已发出写入但丢失结果时标记 `unknown`，不自动
重试，也不声称成功。新 writer 可以重放已受理结果；旧 writer 不能受理新操作或发布
Session 输出。适配器沿用现有 Mem0 协议语义，不引入通用 provider 框架。

## 验证与交付

覆盖不绑定时零请求及零工具、显式保存及跨 Session 召回、两租户两用户和伪造 Store/
条目 ID、同用户跨 Workspace、列表/SSE/产物/修改/子 Session/转发的个人可见性、
审批和 Plan Mode、排队输入与恢复、响应丢失/重启/writer 替换/冲突重试、内容变化时
拒绝删除以及屏蔽残留命中。真实 Mem0 契约测试使用隔离的临时 namespace，验证同步
条目 ID、精确读取 scope 和删除，并完成清理。历史单用户结果不能证明这些保证。

在模块共享本地验证预算内执行相关 Java 契约、MySQL 和真实 Hosted 恢复用例，完整
门禁保留在 CI。执行根目录 TypeScript build/typecheck 和相关消费方测试，明确记录
无法运行的真实路径。功能默认关闭，通过 provider 和隔离验收后启用。交付参数透传
与现有工具展示，不增加独立记忆管理页面。

## 边界

不包含团队共享、自动抽取、Dream、目录挂载、记忆版本管理或隐式子 Session 绑定。
没有待定产品决策。部署对应的 Mem0 契约和不可用测试基础设施是验收门禁，不能据此
削弱隔离或静默回退到本地记忆。
