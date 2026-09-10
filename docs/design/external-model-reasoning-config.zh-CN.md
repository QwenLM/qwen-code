# 外部模型思考配置

[English](external-model-reasoning-config.md) | [简体中文](external-model-reasoning-config.zh-CN.md)

## 问题与范围

模型提供方已经支持端点、凭证、生成参数及部分思考能力声明，但思考请求格式、支持档位和默认值仍依赖模型名与域名判断。新模型和别名需要一份界面与实际请求共同遵守的外部声明。

在 `generationConfig.reasoningConfig` 下增加三个可选字段：`profile`、`supportedEfforts` 和 `defaultEffort`。复用现有协议、配置作用域和模型身份。不增加任意请求模板、新的用户可见档位或分档 token 预算配置。固定预算继续使用 `reasoning.budget_tokens`。

## 配置

```json
{
  "generationConfig": {
    "reasoningConfig": {
      "profile": "dashscope-effort",
      "supportedEfforts": ["low", "medium", "xhigh"],
      "defaultEffort": "medium"
    }
  }
}
```

Profile 复用已有思考请求格式：

- OpenAI Chat Completions：`openai-reasoning`、`openai-effort`、`deepseek-openai`。
- OpenAI Responses：`openai-reasoning`。
- Qwen：`dashscope-thinking`、`dashscope-effort`、`qwen-chat-template`。
- Anthropic：`anthropic-manual`、`anthropic-adaptive`、`anthropic-adaptive-only`、`deepseek-anthropic`。
- Gemini：`gemini`。

省略 profile 时使用已有推断；其余字段省略时继承推断或所选 profile 的行为。显式声明覆盖与思考相关的模型名和域名推断，不选择 SDK、端点或凭证。保留已有 `capabilities.reasoning` 的兼容性；提供新生成配置时，以新配置为准。

档位使用 `low/medium/high/xhigh/max`。仅支持开关的 profile 拒绝档位字段。校验 profile 与协议匹配、档位无重复、默认值属于支持集合。Gemini 使用已有 low/medium/high 映射。无效声明需指出模型与字段。

## 解析与生命周期

区分模型默认值和用户显式选择。保留现有选择优先级；没有选择时，外部默认值同时影响请求与界面。界面只展示具体思考档位。仅按有效支持集合归一档位，不再进行内部名单的二次归一。保留已有原始参数覆盖、请求级关闭、强制思考规则和预算上限。默认值不能覆盖请求级关闭。

Core 提供统一解析结果，供提供方和客户端使用。OpenAI 必须支持其与采样参数共存；Anthropic 与思考相关的历史消息处理跟随 profile。未配置路由保留既有行为。新声明跟随精确模型与端点选择、运行时快照和子代理，不能在模型路由间泄漏。

Workspace 重载先校验新配置。已有会话在整个当前轮内，包括工具调用和重试，保留原配置。当前轮结束后，在下一次用户发送前应用最近一次有效重载。新会话使用最新配置。更新失败保留原运行配置并报告错误。复用现有 workspace 所有权和发送入口。

ACP 保留 `reasoning_effort`，使用已有元数据携带默认值及思考可用性。CLI 和 WebShell 展示相同的有效状态；分档 profile 只展示具体档位，仅支持开关的模型仍展示开关。

## 验证与验收

记录全局 CLI 基线，再通过受控兼容端点验证本地构建产物。覆盖陌生模型名及代理地址、全部 profile、默认值、显式选择、关闭、固定预算、采样参数共存、原始覆盖和无效配置，断言最终请求内容。

覆盖同名不同端点、切换、快照、子代理、Default 恢复及显式选择保留。在包含多次请求的一轮对话中重载两次：该轮所有请求使用原配置，下一次用户发送使用最新配置。验收 CLI、ACP 和 WebShell 控件，包括首屏与已有会话。

完成相关包定向测试、build、typecheck、bundle 和完整差异自审。新鉴权、响应格式以及非思考模型限制不属于本次改动；配置不能实现新协议。
