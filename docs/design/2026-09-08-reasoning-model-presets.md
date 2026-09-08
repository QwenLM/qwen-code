# Kimi、Qwen 与 DeepSeek 推理模型配置补全

## 问题与边界

PR #10999 已提供声明式 reasoning capability，但只有原生 DeepSeek V4 Pro
配置了档位。其他模型仍依赖旧表或通用档位，原生 Kimi 还会安装不属于其
协议的 `enable_thinking`。本次扩展 provider 预设及其回归测试，复用
安装、模型注册、ACP/WebShell、TUI 和请求流水线，不增加模型名判断。

Qwen 3.8 Flash 暴露了 DashScope 的旧 Max-only 判断：声明档位之后仍会追加
enable_thinking。让现有 tiered 协议判断优先读取已解析 capability，同时
让 UI 的高优先级参数提示使用相同判定。未配置模型保留原来的名称回退。
阿里云 Kimi K3 仅开放文本/图片；原生 Moonshot K3 保留视频输入能力。

CLI mock 验收另发现全局关闭偏好在初次认证时被 provider 默认值覆盖；
refreshAuth 原先只恢复档位。现在同时恢复 live 与可重建配置中的
reasoning=false，使 headless 的连续两次认证也保留关闭状态；强制思考
模型仍豁免。认证或热重载引发的重建按已有档位策略保留会话偏好；
模型切换仍通过已有流程应用新模型默认值。

## 配置矩阵

| 路由 / 模型                                                      | 档位或开关           | 默认档位      | 关闭字段              |
| ---------------------------------------------------------------- | -------------------- | ------------- | --------------------- |
| Moonshot K3                                                      | low / high / max     | max           | 不允许关闭            |
| Moonshot K2.7 Code / Highspeed                                   | 强制思考，无可选档位 | provider 默认 | 不允许关闭            |
| Moonshot K2.6                                                    | 开关                 | provider 默认 | thinking.type         |
| 原生 DeepSeek V4 Pro / Flash                                     | low / high / max     | high          | thinking.type         |
| Alibaba Standard Qwen 3.8 Max / Max-0902 / Flash                 | low / medium / xhigh | xhigh         | reasoning_effort=none |
| 已有 Alibaba Qwen 3.5 / 3.6 / 3.7 与 Qwen3 Max-0123 混合思考条目 | 开关                 | 保留预设开启  | enable_thinking       |
| Alibaba DeepSeek V4 Pro / Flash                                  | high / max           | high          | enable_thinking       |
| Alibaba DeepSeek V4 Pro-0813 / Flash-0731                        | low / high / max     | high          | enable_thinking       |
| Alibaba Standard Kimi K3                                         | low / high / max     | max           | 不允许关闭            |
| Alibaba Standard / 已有 Token Plan Kimi K2.7 Code                | 强制思考，无可选档位 | provider 默认 | 不允许关闭            |
| Alibaba Standard / 已有套餐 Kimi K2.6 / K2.5                     | 开关                 | 保留预设开启  | enable_thinking       |

已有 Token Plan DeepSeek V3.2 也补上 enable_thinking 开关能力。

Token Plan 补充已列出的 Qwen 3.8 Flash 和 DeepSeek V4 Pro-0813，保留
3.8 Max / Preview 现有强制思考限制并同步 canDisable。Preview 作为已有
兼容别名保留。Coding Plan 只补已有混合思考条目的能力，不增加模型。
原生 DeepSeek 的稳定 ID 已指向新快照；不把阿里云的快照 ID 猜测为原生 API ID。

## 实现与验收

修改 moonshot、deepseek、alibaba-standard、alibaba-token-plan 和
alibaba-coding-plan 预设。原生 Kimi 删除 enableThinking；其 API 默认开启
思考。强制思考模型同时保留 thinkingMandatory 和声明 canDisable=false，
照顾已有 generation config 消费者。toggleOnly 不声明虚构档位。

预设安装测试覆盖真实配置产物；请求测试从真实预设生成配置并断言最终
payload；ACP 测试验证精确选项和默认值。测试包含关闭、副请求关闭、非法
档位和未知模型。执行 build、typecheck、bundle、聚焦测试与 lint，并使用
隔离配置的 mock API 完成 CLI 验收；真实供应商付费调用不作为本地验证。

这些预设影响新安装或重新配置 provider。已有 settings 不会自动迁移，
不修改用户当前配置。地域可用性取决于账号和供应商，不扩大既有 endpoint
范围。GLM、MiniMax、Step、OpenRouter、ModelScope、Idealab 及 #11328 中
与本次条目无关的边界不在范围内。

## 官方依据（2026-09-08 核对）

- [Kimi K3](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)：三档、默认 max、始终思考。
- [Kimi K2.7 Code](https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart)：thinking 默认开启且不允许关闭。
- [Kimi K2.6](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart)：thinking.type 开关。
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) 与 [模型入口](https://api-docs.deepseek.com/)：原生稳定 ID 的版本、三档和关闭形状。
- [Alibaba Chat 参数](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)：各系列档位、默认值、enable_thinking 与 Qwen 3.8 互斥字段。
- [Alibaba DeepSeek](https://help.aliyun.com/zh/model-studio/deepseek-api)：稳定版与快照的档位差异。
- [Alibaba Kimi](https://help.aliyun.com/zh/model-studio/kimi-api)：模型及路由；不加入仅支持 max 的 kimi/kimi-k3。
- [Token Plan 模型列表](https://help.aliyun.com/zh/model-studio/token-plan-personal-overview)：新增 Flash、Pro 快照和 Preview 别名。
