# 第二轮 system prompt 精简

[English](2026-09-23-system-prompt-second-pass.md) | [简体中文](2026-09-23-system-prompt-second-pass.zh-CN.md)

## 问题与范围

第一轮精简（#12360）之后，默认主会话 prompt 仍在相邻段落重复同一规则：专用工具策略解释了两遍；验证要求拆成两条重叠的项目符号外加一段重复总结；自适应详略在沟通与风格两处各讲一遍；Git 指导把一条提交信息规则拆成两条、把三条重叠的"以 Git 为准"规则并列。

第二轮仅修改 prompt 文本。公共 API、模型族路由、按声明过滤工具、direct 与 CodeModeOnly 两种调用约定、每一条 gate 行前缀、所有交互模式的提问策略、Todo 指导、output style 处理、安全段（`Executing actions with care`、sandbox、权限规则）全部保持原样。

## 改动

- **工具指导（两种调用约定同步）**。`Reserve shell` 子行只保留规则本身——前面 `Prefer Dedicated Tools` 一句已经说明何时不该用 shell。`Subagent Delegation` 压缩为三条有效规则：任务匹配 agent 描述才委派、不重复子 agent 已在做的的工作、后台结果以通知送达，等待期间不读转录、不预测结果、不重复发起。`Codebase Search` 同样压缩，保留"直接搜索优先"和 Explore 的启用门槛（定向搜索不足或明确需要 3 次以上查询）。
- **工程工作流**。`Verify (Tests)` 与 `Verify (Standards)` 合并为一条 `Verify`，覆盖测试、构建、lint、类型检查，保留"从项目自身识别命令"和"只读轮次无需验证"两条规则；"无法验证"的免责说法并入 `Report outcomes faithfully`。删除结尾的 `Key Principle` 段（与 `Adapt` 重复）。
- **沟通与风格**。保留被测试锁定的自适应详略原句（`Final responses should be concise by default, but their shape and depth must match the request`）和复杂答复需要包含的证据清单；删去 `Tone and Style` 中第二处"use enough detail for clarity"表述和冗余的"lead with the outcome"从句。
- **Git 指导**。两条提交信息规则合并为一条（总是先给草稿；重 why 轻 what）。三条 `Git as Source of Truth` 压成一条：历史与归属以 `git log` / `git blame` 为准而非记忆或快照；调试方案的答案在代码里、上下文在提交信息里。

## 理由与消费方

入口仍是 `getCoreSystemPrompt`，调用方与 `/context` 估算不变。`TOOL_GUIDANCE_LINE_GATES` 的每个行前缀逐字保留，按声明过滤（#12032）行为完全一致——gate 测试断言的正是这些前缀。`prompts.test.ts` 中 `adapts final response detail to the request`（来自 #7085）锁定的原句逐字保留。没有删除、改名或移动任何项目符号标签或小节标题。

## 验证与验收

- `packages/core` prompt 测试（190 个，含 17 个再生成快照）与 Arena worker 测试通过；快照 diff 只含预期文本变化。
- `packages/cli` 的 contextCommand 与 review base-tree 测试通过。
- 构建、typecheck、改动文件的 Prettier/ESLint 全部通过。
- 五个模型族（general、qwen-coder、qwen-vl、gemma4，以及 CodeModeOnly）在 interactive、headless、ACP 三种模式下均正常渲染。
- 前后大小在相同输入下对渲染出的基础 prompt 实测（interactive、Git 环境、无 sandbox、无 Todo/style/context），以 `o200k_base` 作为统一文本度量；不是 provider 计费口径。

## 风险与后续

去重后的更短措辞仍可能影响模型行为；结构化测试不能证明任务成功率不变。真实的同任务、同环境、只换 prompt 的成对 A/B 评测仍是未完成的验证缺口；按能力装配（没有对应 skill 时不注入相应指导）同样留待后续。原计划中的 Todo 指导三处去重与注释规范压缩推迟到下一轮。
