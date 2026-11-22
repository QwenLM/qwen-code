# 创建会话时配置模型连接

[English](managed-session-model-config.md) | [简体中文](managed-session-model-config.zh-CN.md)

## 问题与当前行为

Hosted 执行从运维配置的 CLI settings 解析模型连接。WebShell 可以选择已登记的模型
ID，公共创建 API 没有模型选择字段。业务应用无法在不修改 Harness 部署配置的情况下，
为单个 Session 提供自己的模型连接。

## 预期行为

公共创建请求增加可选 `model_config`，WebShell 创建请求增加 `modelConfig`。两者使用
相同对象：`protocol`、`model`、`base_url`、`api_key` 和可选的
`generation_config`。支持基于 API Key 的 `openai`、`openai-responses`、
`anthropic` 和 `gemini` 协议。生成参数使用明确校验的采样参数，不能覆盖连接字段。
省略 `generation_config` 时保留正常请求的采样默认值；显式对象用于下发 wire 采样参数。
Anthropic 适配器忽略 `seed`、`presence_penalty` 和 `frequency_penalty`；
接受字段不代表每个服务商都支持这些参数。
OAuth、ADC、任意请求头、环境变量展开和凭据轮换不在本次范围内。不新增浏览器凭据编辑器。

完整连接在 Session 内不可变。不能同时提交显式 `modelId` 和完整配置。已有 Session
以及省略新字段的请求保持原有行为。使用完整配置的 Session 不能切换到宿主模型目录；
使用其他连接时创建新 Session。子会话继承父会话的连接。

## 控制面与持久化

准入前校验配置，将其规范化摘要纳入创建请求幂等摘要，并在创建 Session 和首轮的同一
事务中保存加密配置。复用 `SecretProtector`，将加密上下文绑定到租户和 Session 身份。
Session 仅保存密文、密钥 ID 和配置摘要。API 响应、公共事件、回执和日志资源不包含凭据。

部署通过 `qwen.managed-agent.model-config-base-urls` 配置允许的模型 API 地址，并提供
`SecretProtector`。默认空列表禁止新的内联配置。URL 必须匹配允许的端点，不能包含用户
信息、查询参数或片段。这项策略约束新增的调用方指定出站连接，不会在 Harness 中登记
模型 ID 或凭据。

按仓库规则原地更新尚未发布的共享 V1 schema。已有开发数据库需要重建，不修改正在运行
的用户数据库。准入子 Session 时复制配置，并按子 Session 上下文重新加密。schema
清单与恢复投影同步覆盖新增列。

## 私有执行协议

声明 `session-model-config/1` 能力。私有 create/load 请求只携带
`modelConfigDigest`，并将其写入托管定义。复用驻留会话和冷加载时核对绑定。旧 Harness
必须拒绝挂接，不能使用部署默认值执行。

增加 Session Store 读取接口，校验租户、工作区、writer token、writer ID 和 generation。
仅向当前执行所有者返回摘要匹配的配置，并设置 `Cache-Control: no-store`。生命周期读取
继续校验已有生命周期授权。配置缺失、改变或不可用时拒绝执行。读取秘密不创建日志资源。

## Harness 配置隔离

只有绑定摘要时才通过鉴权存储读取完整配置。通过仅宿主可用的选项注入每次新建的执行
Config。该连接跳过环境变量和用户 provider 解析，清除宿主模型注册表、辅助模型选择和
回退配置，保留其他运维设置。不修改进程环境或 settings 文件，不在宿主注册表中查找
下发的模型。
从下发的模型名称推导输入模态和上下文容量，保留运维的日志与推理强度偏好，但不引入
宿主连接或生成设置。未知模型保留仅文本的默认能力。

普通 Turn、审批继续执行、workflow Turn、上下文压缩和生命周期模型 Hook 使用同一绑定。
已有 provider pin 校验继续保护恢复请求和子会话执行。子会话请求其他路由时，不能借用
该配置的凭据。

## 多租户部署边界

预期调用方是可信业务服务，在下发连接前鉴权并确定租户和 actor 身份。平台签名密钥
必须保留在该服务或可信网关中。绑定租户/Session 的存储和 writer 授权提供应用层
隔离；共享 Harness 进程仍处于同一个运维信任域。

地址白名单作用于整个部署。本次不授予或检查租户专属的模型使用权限。不同租户采用
不同策略时，可信调用方必须约束允许的端点、协议和生成参数上限。租户配额和出站网络
限制仍由部署侧负责。

每个 Session 保存独立加密、不可变的凭据快照，子会话继承后也是如此。服务商吊销
凭据可能使既有 Session 无法继续执行；按当前契约，更换 key 需要创建新 Session。
未来若引入租户名下的连接/秘密引用，需要明确版本、轮换和恢复语义。已经管理凭据的
上层应用可以继续直接下发，无需在这里再建一套模型注册表。

## 涉及组件

- 公共和 WebShell 契约、创建服务与 SQL Session 准入。
- 会话配置校验、加密持久化及仅执行所有者可用的读取接口。
- Java SDK create/load 请求及单实例、池化 Harness connector。
- Hosted create/load 定义与所有模型执行入口。
- CLI 配置构建、OpenAPI 及生成的 WebShell 类型。
- 共享 schema 清单、定向回归测试和真实进程集成测试。

## 验证与验收

使用隔离的模拟 provider 和测试密钥。并发创建两个模型 ID 相同、地址、密钥和采样参数
不同的 Session，确认各 provider 仅收到自己的配置。覆盖省略配置、无效协议/字段/URL、
幂等重放和冲突、SQL 加密保存、错误租户或 writer 读取被拒绝，以及公共响应和日志资源
不含秘密。重启 Harness 后重新挂接，确认连接绑定不变。覆盖 workflow、压缩、Hook 和
子会话继承。

实现前用全局 CLI 验证基线，再执行定向 Java/SDK 和 TypeScript 测试、build、typecheck
及 bundle。Java 本地验证共享模块的十分钟预算；无法运行的 MySQL 或真实进程检查明确
保留为 CI 验收缺口。最后完成两轮干净自审和独立评审。本文件描述拟实现方案，不代表
验收已经完成。

## 待定事项

初版不可变、基于 API Key 的连接没有必须先解决的开放问题。已有 Session 的凭据更新
需要单独定义修订与恢复契约。
