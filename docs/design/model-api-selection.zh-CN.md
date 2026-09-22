# 模型级 OpenAI API 选择

[English](model-api-selection.md) | [简体中文](model-api-selection.zh-CN.md)

## 问题与范围

OpenAI Chat Completions 与 Responses 共用凭据配置，但目前 Qwen Code 将它们作为
不同认证选项和提供商配置组。用户必须将 `openai` 改为 `openai-responses` 才能选择
请求格式。

在每个 OpenAI-compatible 模型中增加 `wireApi: "chat-completions" | "responses"`，
与 `id`、`baseUrl`、`envKey` 同级。界面统一为 OpenAI-compatible 入口，再选择 API。
保留内部协议身份和已记录会话的精确路由。这是 Qwen Code 自身功能，并非从其他代码库
移植。原生 computer-use 行为、reasoning 默认值、传输实现、协议自动探测以及凭据
自动迁移不在本次范围内。

## 配置契约

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "gpt-6-astra",
        "wireApi": "responses",
        "envKey": "IDEALAB_API_KEY",
        "baseUrl": "https://gateway.example.com/v1",
        "generationConfig": {
          "reasoning": { "effort": "xhigh" },
          "contextWindowSize": 272000
        }
      }
    ]
  }
}
```

| 提供商协议                                  | 模型 `wireApi`            | 实际内部协议       |
| ------------------------------------------- | ------------------------- | ------------------ |
| `openai`                                    | 未填或 `chat-completions` | `openai`           |
| `openai`                                    | `responses`               | `openai-responses` |
| 映射至 `openai` 的自定义提供商              | 同上                      | 同上               |
| 已发布 `openai-responses`（含映射的提供商） | 未填                      | `openai-responses` |
| 已发布的 OpenAI 协议声明                    | 已填写                    | 选定的 `wireApi`   |
| 其他已知协议                                | 已填写                    | 配置错误           |

未知 `wireApi` 值属于配置错误。该字段不能使未知提供商 id 变为合法，保留现有未知
提供商警告。配置流程使用同一个 OpenAI 凭据命名空间，两种 API 都写入 `openai`。
在受支持的格式中，显式 `envKey` 的含义保持不变。`wireApi` 是路由元数据，不能发送
到模型请求体。

Responses 已先于本次重构随 v0.23.3 发布。继续读取已发布的
`modelProviders.openai-responses` 配置组，以及指向 `openai-responses` 的
`providerProtocol` 映射，包括空配置组和未引用映射。显式提供商映射仍优先于配置组
名称；显式模型 `wireApi` 可以覆盖两种 OpenAI 协议，未填时保留声明的协议。
加载和热重载不改写设置，也不添加凭据引用。已有显式引用和默认凭据解析保持发布版
语义。草案字段 `api` 不作为别名。

新配置写入 `openai` 加模型级 `wireApi`。重配置保留所选精确路由的元数据和凭据引用，
仅清理当前可写作用域中实际 API、模型 id 和精确配置 URL 都匹配的旧条目。
提供商 id 含点号的分组保持原样，因为设置适配器会将其写成嵌套路径；若其中的旧条目
仍然生效，安装在写入前失败。
其他端点、API、模型和作用域保持不变，不改写自定义映射。若所选已发布声明被更高优先级作用域覆盖，写入前拒绝重配置，
应回到没有该覆盖的所属上下文重新配置。其他覆盖导致新配置无法生效时回滚。内部 `AuthType.USE_OPENAI_RESPONSES` 继续标识 Responses
传输和已记录会话路由。界面仍只有一个 OpenAI 提供商入口。

`wireApi` 明确表示请求协议，借鉴 Codex 的 `wire_api` 含义，同时遵循本项目配置的
camelCase 风格。该字段仍放在模型层，使同一提供商可以提供两种 API。

## 运行时与配置流程设计

使用一个共享的模型级协议解析函数，覆盖模型注册、启动配置、凭据查找、现有配置检查
以及模型编辑。保留实际 `(authType, model id, configured baseUrl)` 路由身份。
同一模型、同一 URL 的两种 API 仍是不同配置。同一实际路由的重复项沿用首项优先。
提供商安装合并也必须比较实际 API。

明确选择了模型且原始启动选择为 `openai` 时，如果目标模型没有匹配的 Chat 路由，可以选择显式配置的
Responses 模型。优先精确匹配实际协议的路由，包括配置 URL 的区分。解析后，创建
generator、模型选项和会话记录均使用实际协议。显式模型切换和已记录会话保持精确
路由语义，不能给通用 registry 查找增加跨协议回退。已有 enforced-auth 策略不放宽。

热重载保持事务性：非法编辑不能破坏原 registry。修改或移除活跃路由的 API，不能
将新路由的凭据与旧 generator 混用，也不能静默替换为另一个 API。沿用路由不可用时
的既有行为，必要时要求显式选择修改后的路由。此类编辑后重新认证失败时，向用户提示一次，并说明需
重新选择路由或重启。重启可以重新解析已编辑的启动配置。
现有会话记录无需增加字段，因为实际 auth type 已能区分两种 API。

Ink 与 OpenTUI 共用配置 hook，两者都应提供 API 选择，预览与实际保存的配置一致，但自定义请求头的值会被遮蔽；
当安装计划拒绝当前输入时，确认步骤显示拒绝原因而不是预览。
VS Code 和 Web Shell 提供相同选择。Web Shell 使用带标签的确认摘要并遮蔽凭据，
展示已选 API，不虚构生成配置或默认值。ACP 和 daemon 安装输入
接受 `wireApi`，写入前校验。
ACP 对两种运行时 API 使用同一个 OpenAI Key 认证入口。删除模型
时逐项匹配实际协议，删除另一 API 的同名配置不能清除当前活跃选择。

初次认证失败后的普通重试保留已经解析的启动 wire。成功执行显式模型选择或
提供商安装后，启动映射即结束，即使此时尚未创建第一个 generator。
ACP 持久化 User 自己的 OpenAI wire 选择，与 Workspace 推导出的运行时认证分开。
删除时按每个可写作用域自己的有效设置校验选择；清空 User 选择时，保留仍有效且
继承了其字段的 Workspace 选择。Workspace 的 `model` 只在其 name 与 baseUrl 都不由
workspace 自身拥有时，作为一对字段一次性决定：继承的选择在 workspace 中失去路由时，
就地写入空值墓碑；被保留的选择以整对字段固定，其中带凭据的 URL 以空墓碑代替，
不复制到可共享的 workspace 文件。fast 和 full 启动路径均在加载 workspace 环境值之前
捕获不可变快照。User 选择校验使用该快照、User 自身设置以及 home 级 `.env` 文件，
环境文件从 home 开始发现，不从 workspace 或其父目录发现。shell 和 home 凭据仍是
有效的全局输入，仅属于 workspace 的环境值不能保住过期的 User 选择。
该快照仅用于删除校验，不改变 daemon 或 Workspace 运行时环境。
剩余条目必须是注册顺序中真正胜出的路由，且可用于对话。

预览与提交读取同一个已有模型的新格式视图，包含已发布声明，不修改源设置。
预设提供商重连未显式输入 API 时，逐模型保留精确相同端点上的已保存 API，
包括同一模型 id 同时使用两种 API 的情况。所有入口都由共享安装构建器执行保留逻辑。
保存的选择只决定安装计划的活跃路由，不能决定其他模型的 API；通用自定义提供商入口
继续遵循可见的 API 选择，并按识别出的已保存路由预填。新模型保留预设默认值。安装保留 API 标记时，清除未标记模板
无法复现的模板版本元数据。

轮换凭据时，每次写入必须与生成其输入时的同一解析快照比较，以保留 `${...}` 引用。
旧声明清理使用自身最新的写入快照；最终运行时读取重新解析新保存的环境值。
CLI 在写入模型后刷新可写作用域内的所有提供商配置组，避免重复的映射路由在轮换凭据后
仍缓存旧 header。
占位符恢复遵循 registry 跨提供商配置组的首项优先顺序，但仍拒绝胜出配置组内部
有歧义的引用。显式凭据引用不能自动迁移。

`protocolOptions` 控制 SDK 协议选择，不限制模型能否设置 `wireApi`。
当前语音转写只支持 Chat Completions：Responses 语音配置必须在写入前拒绝，
包括预构建模型和保留的服务元数据。对话和图片模型仍可选择两种 wire。

实现涉及：core 模型类型、registry、配置和 provider 安装；CLI 配置、认证查找和
热重载；配置界面；ACP 与 daemon 安装契约；SDK daemon 请求类型；settings schema
和用户文档。不改变 daemon 路由归属或 workspace 解析规则。

## 验证与验收

- 单元测试覆盖配置表、非法输入、混合 API 配置、精确端点凭据、安装合并和事务性重载。
  已发布提供商 id 和映射仍可读取，不自动迁移磁盘配置。
- 配置测试覆盖初始 `openai` 选择解析至 Responses、精确路由优先、模型切换和会话恢复。
- 配置流程测试覆盖 API 选择、预览与保存一致性、共享凭据、新格式配置检查、请求校验，
  以及仅删除目标 API 配置。
- 回归覆盖认证失败重试与显式选择的区别、User/Workspace 相反的认证选择、
  继承模型字段时的删除、服务别名遮蔽对话路由、保存元数据的预览、预设提供商重连，
  以及持久化前的语音/wire 校验。
- 隔离的 localhost 服务记录实际 CLI 请求路径和负载：隐式 Chat、显式 Chat、新格式
  Responses、自定义提供商 Responses、已发布 Responses 声明、在请求前拒绝非法 API，
  以及两种 API 的工具调用续接。
- 先对全局 `qwen` 执行基线，再验证本地构建 CLI。使用临时 `QWEN_HOME` 和 mock key，
  不修改真实设置，不向远端模型发送测试提示。
- 完成 build、typecheck、相关单元测试、bundle、格式和 lint 检查、两次干净自审及
  独立 review 后才宣布完成。

验收依据是正确的请求格式和保留的路由身份，不能只看 JSON 解析成功或进程退出码。
详细运行结果放在 git 忽略的 `.qwen/e2e-tests/pr11538-canonical-wire-api/` 目录，
验证报告发布到 PR，供 reviewer 直接查看。
