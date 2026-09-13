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

| 提供商协议                     | 模型 `wireApi`            | 实际内部协议       |
| ------------------------------ | ------------------------- | ------------------ |
| `openai`                       | 未填或 `chat-completions` | `openai`           |
| `openai`                       | `responses`               | `openai-responses` |
| 映射至 `openai` 的自定义提供商 | 同上                      | 同上               |
| 其他已知协议                   | 已填写                    | 配置错误           |

未知 `wireApi` 值属于配置错误。该字段不能使未知提供商 id 变为合法，保留现有未知
提供商警告。配置流程使用同一个 OpenAI 凭据命名空间，两种 API 都写入 `openai`。
在受支持的格式中，显式 `envKey` 的含义保持不变。`wireApi` 是路由元数据，不能发送
到模型请求体。

本次重构紧接着 Responses 首次实现合入。受支持的配置统一为 `openai` 加模型级
`wireApi`，明确不兼容之前的 `modelProviders.openai-responses` 格式，也不做自动
迁移。草案字段 `api` 不作为别名保留。不要增加旧配置组的查找、清理、凭据回退或迁移
代码。内部 `AuthType.USE_OPENAI_RESPONSES` 仍用于标识 Responses 传输和会话记录
路由，它不是独立的提供商配置选项。

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
的既有行为，必要时要求显式选择修改后的路由。重启可以重新解析已编辑的启动配置。
现有会话记录无需增加字段，因为实际 auth type 已能区分两种 API。

Ink 与 OpenTUI 共用配置 hook，两者都应提供 API 选择，预览与实际保存的配置一致。
VS Code 和 Web Shell 提供相同选择。Web Shell 使用带标签的确认摘要并遮蔽凭据，
展示已选 API，不虚构生成配置或默认值。ACP 和 daemon 安装输入
接受 `wireApi`，写入前校验。
ACP 对两种运行时 API 使用同一个 OpenAI Key 认证入口。删除模型
时逐项匹配实际协议，删除另一 API 的同名配置不能清除当前活跃选择。

实现涉及：core 模型类型、registry、配置和 provider 安装；CLI 配置、认证查找和
热重载；配置界面；ACP 与 daemon 安装契约；SDK daemon 请求类型；settings schema
和用户文档。不改变 daemon 路由归属或 workspace 解析规则。

## 验证与验收

- 单元测试覆盖配置表、非法输入、混合 API 配置、精确端点凭据、安装合并和事务性重载。
- 配置测试覆盖初始 `openai` 选择解析至 Responses、精确路由优先、模型切换和会话恢复。
- 配置流程测试覆盖 API 选择、预览与保存一致性、共享凭据、新格式配置检查、请求校验，
  以及仅删除目标 API 配置。
- 隔离的 localhost 服务记录实际 CLI 请求路径和负载：隐式 Chat、显式 Chat、新格式
  Responses、自定义提供商 Responses、非法 API 拒绝和两种 API 的工具调用续接。
- 先对全局 `qwen` 执行基线，再验证本地构建 CLI。使用临时 `QWEN_HOME` 和 mock key，
  不修改真实设置，不向远端模型发送测试提示。
- 完成 build、typecheck、相关单元测试、bundle、格式和 lint 检查、两次干净自审及
  独立 review 后才宣布完成。

验收依据是正确的请求格式和保留的路由身份，不能只看 JSON 解析成功或进程退出码。
详细运行结果放在 git 忽略的 `.qwen/e2e-tests/pr11538-canonical-wire-api/` 目录，
验证报告发布到 PR，供 reviewer 直接查看。
