# Agent Host 替换的程序兼容性

## 1. 状态与背景

已实施并完成本地验证，2026-11-18。解决 [#13644](https://github.com/QwenLM/qwen-code/issues/13644)。已通过 `gh` 阅读 Issue 及评论；当前实现基于 `feat/managed-agents/defined-a-capacity` 分支的 `b9da38c7bd`。

Issue 描述了替换 Host 时保留 Agent 固定的 `execution.provider`，却将其移动到不提供该程序的 Host 的问题。实际运行的 `SessionAgentOrchestrator.pickupForHost` 会在 `programForAgent` 无法选择固定程序时跳过该 Agent。因此，替换操作可能引入让任务无限排队的配置。直接更新执行绑定的写入路径已通过 `program_unavailable` 拒绝所有绑定 Host 均不支持的固定程序。

当前代码位于 `packages/core/src/agents/workspace-agents/store.ts`。注册先写入替换身份和 `enrollment.replacementHostId`，再改写 Agent 绑定，最后移除旧 Host 和注册令牌。这些文件在同一个 Workspace 锁下独立提交。现有重试机制有意支持恢复中断的替换。注册最初只提供 provider 声明，不包含 v2 程序探测。

## 2. 目标与范围

如果任一受影响且未退役的 Agent 固定了程序，而替换后的绑定集合中没有可提供该程序的兼容 Host，则拒绝替换，列出所有受影响的 Agent ID，并保留固定程序配置和注册恢复能力。已禁用但未退役的 Agent 可以重新启用，仍参与兼容性检查。已退役的 Agent 不再接收新任务，不参与检查；替换成功时仍更新其绑定中的旧 Host ID，保留退役状态和固定程序配置。

范围包括 core 注册存储、CLI 注册 HTTP 错误映射与客户端密钥恢复、定向回归测试和本设计。不修改 Java/控制平面、schema 或调度，不自动解除固定，不保证运行时可用，也不修复此前已完成的不兼容替换。已有不兼容 Agent 可由所有者显式重新绑定。准入后的心跳变化不属于本配置检查的范围。

## 3. 建议方案

在现有 Workspace 事务中，通过令牌、目标、输入和身份检查后，构造候选替换 Host 及最终 Host 注册表：保留其他 Host，替换相同身份的暂存记录，移除旧 Host，加入候选 Host。

只读取一次 Agent 列表，在内存中准备旧 ID 到新 ID 的绑定映射。沿用当前 Host ID 去重逻辑，保留 Agent/execution 的其他所有字段。对每个受影响、未退役且固定了程序的 Agent，检查替换后的完整 `hostIds` 集合，其中至少要有一个 Host 符合下列规则：

- 存续 Host 必须使用当前接单协议（`protocol === HOST_PROTOCOL_VERSION`），且通过 `hostOffersProgram` 检查。有 `programs` 探测结果时，以探测结果为准；没有该字段时，才使用其 `providers` 声明。未达到协议要求的 Host 即使声明支持该程序，也不计入。
- 本次注册构造的替换 Host 记录没有心跳字段，按本次提交的 `providers` 声明判断，不要求已报告协议。声明接受程序 ID 和旧版展示标签。

中断替换重试时，已绑定到 `replacementHostId` 的 Agent 仍按同样规则检查。前次尝试可能已提交列表，但未完成注册表收尾；重试时缩减程序声明不能因为旧 ID 已消失而绕过检查。不全局重验其他 Agent。

收集所有不兼容 Agent ID，在任何 Host 或 Agent 文件写入之前抛出专用导出错误 `AgentHostReplacementProgramError`。消息只标识 Agent ID，并建议安装固定程序或更新绑定后重试，不包含名称、路径、令牌和密钥。兼容时保留现有写入顺序：暂存身份、按需写入变更列表、最终注册表。不增加文件、锁、持久化抽象或回滚机制。

## 4. 错误与归属契约

`POST /agent-hosts/enroll` 属于持久化 Workspace 范围：解析请求指定的 Workspace，要求信任且已启用 Agent，并使用该 Runtime 的存储。不回退到主 Runtime。路由只特殊处理专用兼容性错误。无效或过期凭证仍返回通用 `401`；意外存储故障仍返回脱敏 `503`。

兼容性错误只能在能力令牌校验成功后抛出，因此无效令牌无法枚举 Agent。必须分类本次具体候选密钥，而不只是判断是否存在待完成替换。如果它匹配暂存替换 Host 的 `secretHash`，则不标记明确拒绝：前次尝试已注册它。否则，前置已注册身份检查已排除其他已注册密钥，可以确定本次密钥没有注册，在存储错误上标记 `enrollmentRefused: true`。这包括待完成替换中提出的新密钥，以及旧客户端未传密钥时本次新生成的密钥。

对确定未注册的密钥，返回既有 `401` 和 `error: AGENT_HOST_ENROLLMENT_REFUSED`，另用 `detail` 提供可操作的兼容性消息。旧客户端仍识别固定拒绝并保留原有清理/恢复契约。当前客户端先依据这个固定状态/错误组合确定拒绝分类，再显示可选字符串 detail；不得用任意 detail 或 wire 布尔值确立拒绝。现有 `isEnrollmentRefusal` 接受该内部生成的分类，使显示详细消息时仍能清理和以 compare-and-swap 恢复原密钥。`AGENT_HOST_ALREADY_ENROLLED` 触发轮换后，如果确定新密钥未注册，应恢复此前已注册身份，避免丢失恢复入口。对已注册的暂存密钥，返回带可操作消息的 `409` 并保留密钥。这个不同的冲突不触发 already-enrolled 轮换分支。这些状态仅指协调端传输；现有免重启本地 `/agent/hosts/connect` 包装路由继续把连接失败映射为 `400`，并保留消息。

首次拒绝时，注册表字节（包括令牌和未暂存身份的状态）和列表字节均不改变。对已经暂存的重试拒绝时，即使本次提出了不同密钥，也保留完整中间状态，不撤销此前成功的文件提交。同一待完成替换仍可沿用现有机制刷新令牌。修正后的重试复用已暂存 Host ID 并正常完成；现有恢复顺序仅可在预检通过后替换其密钥。

## 5. 决策与风险

拒绝策略保留所有者意图。自动解除固定可能静默运行另一个程序。替换预检与 CLI 直接写入路径一样，只要求最终绑定中至少一个 Host 支持固定程序，并对存续 Host 使用当前接单协议作为门槛。区别在于本次注册构造的替换 Host 记录没有心跳字段，预检允许用它的注册声明判断。要求新 Host 自身支持该程序会错误拒绝仍有兼容存续 Host 的多 Host 配置。

准入只证明与可用声明/探测兼容。Host 可能离线，声明可能不准确，后续心跳也可能移除程序。注册成功不能证明下一个任务可执行。本变更阻止替换操作引入这一特定的不支持固定程序配置，不承诺通用排队活性。

新冲突收紧了不兼容替换的行为。操作者需要安装程序、显式更新受影响绑定/固定配置（现有保护要求时，先取消阻塞的排队/运行任务），或保留兼容的存续 Host。无需数据迁移。错误分类必须保留暂存密钥；测试同时覆盖真实客户端处理和路由。

## 6. 验证与验收标准

1. 未退役的 Agent 仅绑定旧 Host 且固定 `claude`，替换 Host 只提供 Qwen：确定未注册时返回 `401`、固定拒绝及可操作 detail，列出所有不兼容 Agent 的 ID，不改注册表、Agent 列表或固定配置。已禁用但未退役的 Agent 仍可触发拒绝；退役 Agent 不触发拒绝，替换成功时只更新其 Host 绑定。拒绝时任何 Agent 都不移动。无效令牌不泄露 Agent ID。
2. 兼容替换成功；未固定程序的 Agent 继续使用默认程序。新 Host 首次心跳前采用本次注册声明，接受旧标签和程序 ID。如果有使用当前协议且支持固定程序的存续 Host，允许替换为只提供 Qwen 的 Host 并保留固定配置。存续 Host 尚未报告当前协议，或已有探测显示程序不可用时，即使声明包含该程序也不能计入。
3. 冲突后修正声明，使用相同且未过期的令牌重试成功。客户端清理确定未注册的被拒绝密钥，already-enrolled 轮换后恢复此前已注册密钥（包括已有另一个暂存密钥的情况），并保留已注册的暂存密钥。该冲突本身不会触发 already-enrolled 轮换分支。任意 detail 或 wire 拒绝标记不能把其他失败变为明确拒绝；缺失 detail 时兼容旧协调端。不得覆盖并发密钥更新。
4. 在列表写入和最终注册表写入处注入故障；保留现有重试行为、稳定替换 ID 和固定配置。最终写入失败后，即使列表已使用新 ID，不兼容声明的重试也必须在进一步修改前失败；兼容重试必须完成。
5. 后续 v2 不可用心跳按上报值存储：注册准入不是执行保证。此前已完成的不兼容绑定和通用调度行为保持现状。

test-engineer 首先尝试全局 `qwen` 基线，若无法触达相关路径则使用测试脚本回退。命令和实际结果记录在 `.qwen/` 下，不将回退测试描述为完整多进程 Host E2E。完成前运行 core/store、CLI 路由和客户端定向测试、根目录 build/typecheck、bugfix 要求的 bundle、格式/lint 检查，并完成连续两轮干净的完整 diff 自审。实施前由一个独立代理完成两轮设计审计，每轮同时执行从需求到方案的正向检查和从失败到不变量的反向检查。

## 7. 审计与实施记录

独立正向/反向设计审计第 1 轮发现了将所有兼容性冲突视为非明确拒绝的恢复缺陷：already-enrolled 轮换后遇到首次冲突会丢失原密钥。第 2 轮发现了同一缺陷的“待完成替换中提出新密钥”变体。最终设计精确检查暂存密钥归属，确定拒绝时保留旧版固定 `401` 错误，并加入可选可操作 detail 及轮换/恢复/并发测试。实现已回应两轮设计发现及混合版本恢复问题；同一个独立代理随后审查了完整实施 diff，结论为“No findings.”。全局 `qwen 0.27.3` HTTP 复现和当前源码存储脚本均复现了不兼容替换；两者均未执行实际排队任务或远程程序。没有待决的产品策略问题：本变更选择严格拒绝，同时保留所有者的显式配置。

## 8. 验证结果

在 macOS、Node.js `v22.18.0`、pnpm `11.24.0` 环境中，针对 `codex/fix-host-replacement-program-compatibility` 分支上的实现运行验证：

- `npm run build`、`npm run typecheck`、`npm run bundle`：通过。构建保留了无关的 bundle 大小、第三方注解/eval 和 IDE companion lint 警告；没有遗留错误。
- 在 `packages/core` 执行 `npx vitest run src/agents/workspace-agents/store.test.ts --coverage.enabled=false`：46 项通过。覆盖两个文件故障边界、字节不变、精确暂存密钥分类、兼容存续 Host、provider 词汇及后续不可用心跳。
- 在 `packages/cli` 执行 `npx vitest run src/serve/routes/agent-hosts.test.ts src/serve/agent-host-client.test.ts --coverage.enabled=false`：123 项通过。详细和旧版拒绝覆盖清理、原密钥恢复、并发密钥保护和暂存冲突保留。
- 对全部六个变更 TypeScript 文件执行定向 ESLint：通过。
- 独立 test-engineer 使用 `node dist/cli.js`、隔离 daemon 和真实 HTTP 路由验证：`VERIFIED_FIXED`。无效令牌返回不带 detail 的 `401`；不兼容首次替换返回固定 `401`、受影响 ID 和建议；注册表/列表字节不变；相同令牌/密钥改为兼容声明后返回 `201` 并保留固定程序。存在兼容的存续 Claude Host 时，只提供 Qwen 的替换也返回 `201`，保留存续绑定和固定程序。

此前全局 `qwen 0.27.3` HTTP 基线对不兼容替换返回 `201`；修改前当前源码脚本也复现了缺陷。首次根构建因已安装 `diff 7.0.0` 不满足所需 `^8.0.3` 而失败；通过 `CI=true corepack pnpm install --frozen-lockfile --ignore-scripts` 和 `npm run postinstall` 同步依赖后构建通过，未修改 manifest/lockfile。一次过早的测试在重建期间被 missing-dist 检查拦下；上述最终测试均在相应构建前置条件完成且依赖稳定后运行。

证据边界：没有执行实际排队任务或远程 Claude/Codex 程序；无限排队的后果由已检查的 pickup 路径支持。暂存 `409` 与文件故障恢复通过定向故障注入测试验证，并未在真实 daemon 提交间隙杀进程。旧客户端兼容性依据保留的固定状态/错误契约，而非完整混合版本进程测试。Linux、Windows、离线/未来心跳可用性及 CI 未由这些本地结果验证。没有截图或录像；实际 HTTP 日志构成前后对比证据。
