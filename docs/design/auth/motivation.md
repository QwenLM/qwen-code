目前 Auth 模块有点太复杂了。我希望进行代码重构。

从数据结构来看， API-KEY / OAuth/ Subscribe 这三种方式最终背后都是修改 `~/.qwen/settings.json`中的 llmprovider 配置项。因此，我在想这三种方式是不是都可以统一为 provider的抽象。

我希望的用户入口如下：

- alibaba modelstudio provider
  - coding plan
  - token plan
  - standard api key
- thrid-part providers
  - deepseek
  - openai
  - huggingface
  - minimax
  - z.ai
    - standard api key
    - token plan
  - xiaomi
- custom provider
  - step1: 选择协议
  - step2: 选择baseurl
  - step3: 填写 api key
  - step4: 填写 model id （可多选，则产生多个 models）
  - step5: 填写 高级配置 （thinking，多模态，maxtoken，temperature 等等）

- oauth
  - modelscope
  - openrouter
  - fireworks

这四个入口的区别如下：

- alibaba modelscope：这是因为 qwen code 是 团队的，因此我们把 alibaba modelstudio 这个 provider 独立出来。
- thrid-part providers：qwen 内置了一些常用的第三方提供房的认证，比如 标准 api-key，或者一些 token plan，这部分也明确是希望社区来共建的。
- custom provider：针对本地sever的模型，或者代理的，或者第三方provider没有包含的，则用户可以通过这个入口进行完全的定制：填写协议，baseurl，api key，model id，高级配置。这些刚好也是 ~/.qwen/settings.json 中对应的字段。
- OAuth: 是通过浏览器端 oauth 直接认证，一般针对一些llm routing的平台，比如 modelscope，openrouter，fireworks 等等。用户用起来更简单方便。

## Code organization goals

围绕上面的目标，代码目录树也应该让维护者和社区贡献者一眼看懂。目录名要尽量表达“这个模块负责什么”，而不是暴露历史实现细节。

核心原则是：用户入口和内部模块分层。UI 可以展示四套流程：Alibaba ModelStudio、Third-party Providers、OAuth、Custom Provider；但内部实现仍然应该围绕 provider、setup method、install plan、source 分层。

建议目标结构如下：

```text
packages/cli/src/auth/
├── index.ts
├── types.ts
├── registry/
│   └── providerRegistry.ts
├── install/
│   ├── applyProviderInstallPlan.ts
│   └── settingsPatch.ts
├── providers/
│   ├── alibaba/
│   │   ├── modelStudio.ts
│   │   ├── codingPlan.ts
│   │   └── tokenPlan.ts
│   ├── thirdParty/
│   │   ├── deepseek.ts
│   │   ├── openai.ts
│   │   ├── huggingface.ts
│   │   ├── minimax.ts
│   │   ├── zai.ts
│   │   └── xiaomi.ts
│   ├── oauth/
│   │   ├── modelscope.ts
│   │   ├── openrouter.ts
│   │   └── fireworks.ts
│   └── custom/
│       ├── customProvider.ts
│       └── customProviderWizardTypes.ts
├── sources/
│   ├── types.ts
│   ├── staticModelSource.ts
│   ├── remoteModelSource.ts
│   └── customModelSource.ts
├── flows/
│   ├── alibabaModelStudioFlow.ts
│   ├── thirdPartyProviderFlow.ts
│   ├── oauthProviderFlow.ts
│   └── customProviderFlow.ts
└── cli/
    ├── authCommandHandler.ts
    ├── authStatus.ts
    └── interactiveSelector.ts
```

各目录职责如下：

- `providers/`：放供应商定义。社区新增 provider 时，理想情况下只需要新增一个 provider descriptor，例如 `providers/thirdParty/deepseek.ts`，不需要理解 CLI handler、settings 写入或 UI flow。
- `flows/`：放用户看到的交互流程。这里可以对应四套 UI flows：Alibaba ModelStudio、Third-party Providers、OAuth、Custom Provider。
- `install/`：放把 provider install plan 写入 `~/.qwen/settings.json` 的逻辑，例如 env、modelProviders、selected auth type、model selection 等。
- `sources/`：放模型来源和模型列表发现逻辑。provider 负责“怎么连上供应商”，source 负责“从哪里拿到这个供应商的模型列表”。
- `registry/`：放 provider 注册、查找、分组排序等纯逻辑。
- `cli/`：放命令入口、终端交互 glue code、状态展示等 CLI 专属逻辑。

这样组织后，ACP / SDK 等其他接口也不会直接耦合 CLI UI。`flows/` 可以依赖终端输入输出；但 provider descriptor、install plan、source types 应该尽量保持纯数据或纯逻辑，未来如果 ACP / SDK 也要复用 provider 安装能力，可以再考虑把这部分下沉到 core 或 shared package。第一阶段不需要过早迁移，但目录边界要先留出来。

## 注意点：

1. 这里面我需要额外增加一个字段概念：“llm source list”，我们刚才在「custom provider」中输入的 models，其实是用户直接筛选出有哪些要用的模型名称。但是实际上，一个供应商，可能有非常多的模型，这些模型不会直接放在 ~/.qwen/settings.json 中，而是会放在 llm source list 中,通过 `/manage-models`来enbale 或者 disable

2. 我希望社区用户来共建 thrid-part providers。因此我希望这部分的代码能够非常简洁清晰，贡献者可能只需要简单添加即可，要尽可能让开发者简单。

---

从用户心智上看，`/auth` 最终可以展示为四套 UI 流程：

1. Alibaba ModelStudio
   - 用户心智：这是官方推荐入口，我输入 key / 选择 plan 就能用。
   - 用户看到的主要是接入方式选择，例如 Coding Plan、Token Plan、Standard API Key。
   - 用户需要填写的内容通常很轻量，例如 API key / token，以及可选的 baseUrl（国内、国际或自定义）。

2. Third-party Providers
   - 用户心智：我选择一个常见 provider，填 key 就能用。
   - 用户看到的是一组内置 provider，例如 DeepSeek、OpenAI、HuggingFace、MiniMax、Z.AI、Xiaomi。
   - 用户需要填写的内容通常也是 API key，最多再选择或填写一个 baseUrl。

3. OAuth
   - 用户心智：我点一个链接，通过浏览器登录授权，CLI 自动完成认证。
   - 用户看到的是一组支持 OAuth 的 provider，例如 ModelScope、OpenRouter、Fireworks。
   - 用户主要操作是打开授权 URL，并等待 CLI 接收回调或完成认证结果写入。

4. Custom Provider
   - 用户心智：我要手动接入一个本地 server、代理服务，或者内置 provider 没有覆盖的第三方服务。
   - 用户看到的是一个完整 wizard：选择协议、填写 baseUrl、填写 API key、填写 model id、配置高级能力。
   - 这套流程比前三类更复杂，但它提供了对 `~/.qwen/settings.json` 中 provider/model 字段的完整定制能力。

这四套是面向用户的 UI flows。实现上仍然应该统一产出 provider install plan，并最终修改 `~/.qwen/settings.json` 中的 LLM provider/model provider 配置。API key、OAuth、token plan 和 custom wizard 都只是 provider 的 setup mechanism，不应该成为 settings 写入逻辑的顶层分支。
