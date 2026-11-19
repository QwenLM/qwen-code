# 主会话的常驻 Auto-Memory 策略

[English](2026-11-04-auto-memory-reference.md) | [简体中文](2026-11-04-auto-memory-reference.zh-CN.md)

**状态：** 实现 [#16291](https://github.com/QwenLM/qwen-code/issues/16291)。属于 [#12028](https://github.com/QwenLM/qwen-code/issues/12028) 和 [#12781](https://github.com/QwenLM/qwen-code/issues/12781) 的一部分。第一版（[#16303](https://github.com/QwenLM/qwen-code/pull/16303)）还附带了一个内置的 `auto-memory` 参考 skill，会话在保存前加载它；第 3 节说明为什么去掉了它。

## 1. 问题

默认配置下（`memory.enableManagedAutoMemory: true`），每个界面（Ink、OpenTUI、headless 与 SDK、ACP）的每次请求，主会话的 system prompt 都带着一段 `# auto memory`，子 agent 也会继承。2026-11-04 在 main 上抓到的一次 `qwen -p` 请求，system prompt 共 35,792 字符，其中这一段占 16,140 字符（45%），仅 `## Types of memory` 就有 7,939 字符。

主模型自己写 memory 的轮次很少，大多是用户要求记住或忘掉某件事的时候；其余 memory 由后台抽取 agent 用它自己的 prompt 写入。所以详细的类型说明和示例只在这少数几轮用得上，却每次请求都要付费。

## 2. 设计

主会话使用 `buildResidentAutoMemoryPrompt`（`memory/prompt.ts`）生成的**常驻策略**。它包含会话正确保存和使用 memory 所需的内容：

- catalog 说明，以及 USER / PROJECT（开启时还有 TEAM）目录；
- 立即处理"记住"和"忘掉"的请求；
- 四种类型各一行，附上决定目录的 scope，以及 **Why:** / **How to apply:** 正文规则；
- 开启 team memory 时：TEAM 的路由规则、禁止把机密写入 TEAM、team 索引自动生成；
- 一句话说明哪些内容不保存，并说明即使用户要求也是如此；
- 保存的两个步骤、原样的 frontmatter 模板和 category 名称；
- 去重，以及删除错误的 memory；
- 何时读取 memory、遵从"忽略 memory"的要求、在依赖某条 memory 或推荐其中提到的文件、函数、开关之前先核对当前状态。

所有读取方拿到同一份文本。legacy 刷新时构建一次，`Config.getAutoMemoryPrompt()` 直接返回它，因此主会话和每个子 agent 的派生 Config 看到的是同一份策略，与子 agent 能用哪些工具无关。structured recall（[#12947](https://github.com/QwenLM/qwen-code/issues/12947)）仍使用它自己的简短 prompt。

完整指南仍保留在 prompt 常量中（`TYPES_SECTION_INDIVIDUAL` 及其示例、`MEMORY_CATEGORY_SECTION`、`WHAT_NOT_TO_SAVE_SECTION`、`WHEN_TO_ACCESS_SECTION`、`MEMORY_WRITING_RULES`、`TEAM_SCOPE_SECTION`、`TRUSTING_RECALL_SECTION`、`MEMORY_PERSISTENCE_SECTION`）：

- 抽取、Dream、User Dream、`/remember` 和导入 agent 依旧由它们构建 prompt；
- `buildManagedAutoMemoryPrompt` 在所有参数组合下的输出与 #16303 之前相同。

## 3. 为什么不再使用内置参考

第一版把完整指南放进内置的 `auto-memory` skill。常驻策略末尾有一个指针，要求模型在保存前加载它；这个 skill 会列在 `<available_skills>` 中；另有一个路由解析器，让没有 Skill 工具的子 agent 改用完整策略。

2026-11-09 的首轮行为评测对比了指针路由和只使用常驻策略的表现。评测使用 Token Plan 的 `qwen3.8-max` 与 `qwen3.8-flash`，以 headless `-p --yolo` 模式运行，每次使用隔离的 HOME 和项目。九个场景覆盖保存到正确层级且元数据合法（s1–s3）、拒绝保存代码里已能看到的事实（s4）、更新已有记录（s5）、忘掉（s6）、对照代码核实过期 memory（s7）、遵从「不要使用 memory」（s8），以及无关任务（s9）。每次运行依据磁盘上的 memory 文件和主模型的工具调用评分。

| 场景                             | 指针 + skill | 只有常驻策略 |
| -------------------------------- | ------------ | ------------ |
| s1 记住个人偏好                  | 6/6          | 5/6          |
| s2、s3、s5–s9                    | 42/42        | 42/42        |
| s4 拒绝保存可推导的事实（12 次） | 8/12         | 7/12         |

s1 唯一一次失败是把偏好存成了 `user` 而不是 `feedback`，目录正确，其余均合法。指针路由下，18 次显式保存中有 14 次加载了 skill；没加载的那几次同样通过。

| 每次运行的平均输入 token | 指针 + skill                          | 只有常驻策略                          |
| ------------------------ | ------------------------------------- | ------------------------------------- |
| 需要保存（s1–s3、s5）    | 88.2k（未缓存 19.2k，5.1 轮模型调用） | 57.7k（未缓存 16.8k，3.8 轮模型调用） |
| 不需要保存               | 61.0k（未缓存 17.6k）                 | 52.3k（未缓存 16.2k）                 |

加载参考会在会话历史中增加约 15k 字符。另一轮复验使用本 PR 的打包构建和默认设置，需要保存的场景平均输入 67.5k token，其余场景平均 56.5k。s1 的六次运行全部通过，s3 有一次保存的 reference 只包含一个关键词（5/6 通过），s4 有 6/12 次拒绝保存可推导的事实。为减少输入 token，设计采用常驻策略。

首轮评测还试了一个压缩得更短的策略（约 3.6k 字符）。它没有进一步节省 token，因为常驻文本的大部分是 frontmatter 模板和 category 列表。而且除非保留「即使用户要求也不保存」这句，它在 s4 上失败得更多。所以常驻策略的措辞保持不变。

## 4. 实测效果

长度单位为字符，路径取典型值（`/home/alice/.qwen/memories` 与 `/home/alice/.qwen/projects/-home-alice-work-app/memory`）：

| 形态                    | 未开 team | 开启 team |
| ----------------------- | --------- | --------- |
| #16303 之前（完整策略） | 15,868    | 17,243    |
| #16303 指针路由         | 4,686     | 5,470     |
| 常驻策略                | 4,451     | 5,235     |

默认会话每次请求比 #16303 之前少发送 11,417 字符。与指针路由相比，还去掉了 235 字符的指针和 233 字符的 `<available_skills>` 条目；`BUNDLED_LISTING_BUDGET` 回到 6,800。

## 5. 风险

- **元数据可能变弱。** 常驻策略保留了 frontmatter 模板、category 名称和正文规则。后台抽取和 Dream 仍使用完整指南。普通 legacy 文件写入会接受 s3 中只有一个关键词的 memory。结构化召回的就绪扫描会把它计为待迁移记录，迁移 agent 会在修复提示词中使用 `MEMORY_METADATA_ITEM_BOUNDS`。
- **用户要求保存可推导的事实。** 当用户明确要求记住代码里已能看到的内容时，较小的模型常常照存。评测中所有方案都是如此，包括完整策略（`qwen3.8-flash` 在完整策略下 0/6，常驻策略下 2/6），所以这是另一项待改进的问题，不是本设计带来的回退。在 `qwen3.8-max` 上，指针路由在这一项略好（6/6，常驻策略两轮合计 9/12）；两个模型合计，它在 12 次 s4 运行中有 3 次加载了 skill。

## 6. 验证

- **单元测试：**
  - `memory/prompt.test.ts`：常驻策略保留第 2 节列出的每条规则、不含详细类型说明，并且不超出体积预算；
  - `config/config.test.ts`：主会话和没有 skill manager 的派生 Config 拿到同一份常驻策略；
  - `skills/bundled-skills.integration.test.ts`：内置 skill 列表不超过 6,800 字符。
- **行为。** 第 3 节记录了首轮评测和打包构建复验。完整复验结果见 [PR #16739](https://github.com/QwenLM/qwen-code/pull/16739)。
