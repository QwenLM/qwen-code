# Verify-PR 执行预检

[English](verify-pr-execution-preflight.md) | [简体中文](verify-pr-execution-preflight.zh-CN.md)

状态：第一版已实现；验证证据见 E2E 记录。

## 问题与现状

本地 `/verify-pr` 轮次会执行不可信的 PR 代码。skill 的文字规则要求宿主或 VM 轮次在代码运行前得到维护者明确批准，但唯一的机器检查在发布检查器里。于是常见的失败既昂贵又令人困惑：整套电池已经在宿主上跑完，`verify-pr-check.mjs` 才来索要 `boundary.json` 和批准评论永久链接。

不能在 coordinate path 自身套用 `--require-isolation` 来解决这个问题。该模式要求观测到容器标记，而坐标解析按设计必须在宿主上进行，因为它需要经过认证的 `gh`。单纯提前写声明也不行：产物目录位于 PR 可写克隆之内。

当前批准检查也有意保持浅层。有可信 context 时，它比对永久链接中的仓库和 PR 号；没有时只查 URL 形状。它不能证明评论存在、作者有权批准执行，或者批准点名的就是当前 head 和 round。

## 目标与范围

第一版让受支持的本地流程在 PR 代码执行前 fail closed：

1. coordinate prepare 默认按 `container` 执行，保留旧 watch prompt；只有 `vm` 和 `host` 要求显式选择新执行方式。
2. VM 或宿主选择必须有以下两者之一：维护者对本人或同仓 PR 的显式本地信任决定；或对他人 fork、且绑定当前仓库、PR、head、round 和每注册 nonce 的真实维护者批准评论及可信 watch 的 in-flight 注册。每次实际 `--start` 都分配新 nonce。
3. prepare 把形成的声明写入现有宿主 context 快照，并在产物目录保存一份副本。
4. 发布检查器把副本与宿主快照对账，保留现有报告规则和 CI lane 检查。

这是针对使用可信 prepare 与发布命令之轮次的流程约束，不是 OS 安全边界：绕过这些命令的 agent 仍能在宿主执行 shell。特权执行包装器或强制沙箱不在本版范围内。prepare 之后评论被编辑/删除以及仓库权限被撤销时的在线重新验证也不在本版范围内；记录保存预检时看到的评论元数据、权限与正文摘要。

CI lane 继续使用发布方持有的 `container` 与 `ci-lane` 记录。本方案不打算修改 workflow。

## 命令契约

coordinate path 新增以下参数：

| 参数                     | 含义                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `--execution container`  | 下一执行阶段将进入真实容器；prepare 不签发容器声明。                                                              |
| `--execution vm`         | 运营方选择 VM，并提供批准与 attestation。                                                                         |
| `--execution host`       | 运营方选择经豁免的宿主轮次，并提供批准。                                                                          |
| `--trust-pr-head`        | 对维护者本人或同仓 PR head 的显式本地信任；与 `--approval` 互斥。                                                 |
| `--approval <permalink>` | 用于他人 fork 的维护者 issue comment 永久链接；替代 `--trust-pr-head`。                                           |
| `--state-root <dir>`     | 存放批准所在 head/round/registrationNonce in-flight 注册的可信绝对目录，必须位于 PR 克隆之外；`--approval` 必填。 |
| `--round <r>`            | 正整数轮次号；`vm` 和 `host` 必填。                                                                               |
| `--reason <text>`        | 本轮为何在可观测容器之外运行；`vm` 和 `host` 必填。                                                               |
| `--attestation <text>`   | 运营方对 VM 确认了什么；仅 `vm` 必填。                                                                            |

coordinate path 的 `--execution` 默认为 `container`，使旧 watch prompt 保持可用。省略它不会签发宿主/VM 批准或容器证明；真实容器仍须通过 gate。新调用可以显式写 `--execution container`。可信本地配方已经使用 `--context-out`；`vm` 和 `host` 现在必须提供它，使批准拥有 PR 克隆之外的权威落点。现有边界内 `--require-isolation` 形式不接受、也不需要 execution 选择。

每个 VM 或宿主调用必须且只能提供 `--trust-pr-head` 与 `--approval` 之一，使用 `--approval` 时还必须提供 `--state-root`。`container` 不接受批准专用参数；容器仍然只有真实边界内门禁通过后才取得 `boundary.json` 与 `boundary-gate.json`。混入不适用参数或缺少必需批准字段属于用法错误。远端批准、权限、身份、注册或文件系统失败属于 prepare 拒绝（exit 3）。

## 批准验证

### 本地可信 head 批准

对于维护者本人的 PR（包括其 fork）或同仓 collaboration PR，`--trust-pr-head` 记录显式本地决定，不要求公开批准评论。prepare 通过 `gh` 证明：

- 当前用户就是预期的本地运营方；
- 该用户对目标仓库有 `write`、`maintain` 或 `admin` 权限；
- PR 作者是该用户，或 `isCrossRepository` 为 false；
- 写出声明前，干净检出的 HEAD 与可信 `headRefOid` 精确相同。

作者相同或同仓位置本身都不会自动选择宿主执行。显式标志信任当前完整 head 在本轮运行，包括合作者写的提交。head 与 round 绑定阻止记录被静默沿用。运营方用认证 login 表示，不设置 `--by`。无人值守 watch 不得自行添加该标志。

### 他人 fork 的批准评论

对于其他 fork，即使是新轮次，也先以 40 位 head 和未使用的正整数轮次运行 `node <trusted-clone>/scripts/verify-pr-watch-state.mjs <n> --start --head <40hex> --round <r> --repo <owner>/<repo> --state-root "<trusted-dir>"`，其中 state root 必须是位于 PR 克隆外的可信绝对目录；注册留在 PR 克隆外，并先于任何 PR 代码执行。轮次继续使用现有 complete/release 命令。prepare 要求单链接普通状态文件中存在该仓库、PR、head 和 round 的唯一实际 in-flight 条目，并且包括每个中间 `.qwen/tmp` 目录在内的完整规范化路径都位于 PR 克隆之外。每次实际 `--start` 都分配并打印一个 `registrationNonce`；head 前缀匹配与当前注册条目的查找统一归 watch-state 所有。该 nonce 在此注册的 in-flight prepare 重试和执行模式切换期间保持不变。完成或释放会消耗该身份：之后的 `--start`（即使 head/round 相同，或位于另一个可信 state root）得到不同的 nonce，无法沿用旧评论。

没有 nonce 的 legacy in-flight 条目仍可由现有 complete/release 命令读取，但不能授权新的评论批准。运营方必须显式释放并重开以分配 nonce，再请求新的标记批准；prepare 绝不静默把旧评论迁移成对新注册的授权。

然后由维护者而不是轮次在 PR 上发布评论。评论包含一个精确标记和人类可读的批准文字：

```text
<!-- verify-pr-boundary-approval: {"mode":"host","head":"<40hex>","round":2,"registrationNonce":"<nonce from this --start>"} -->
Approved host execution for this verify round.
```

VM 的 `mode` 为 `vm`。prepare 在创建产物目录前，通过经过认证的 `gh` 验证以下全部条件：

- 永久链接符合现有允许形状，并指向本仓库和本 PR；
- 指定编号的 issue comment 存在且属于该 PR；
- 恰好一个标记可解析为 JSON，其 `mode`、`head`、`round` 和 `registrationNonce` 分别等于所请求的执行方式、可信 `headRefOid`、正整数轮次号和当前规范化 in-flight 条目；
- 通过 collaborators permission endpoint 而不是自由文本 `by` 证明评论作者拥有仓库 `write`、`maintain` 或 `admin` 权限；
- 标记与权限 API 调用成功，任何错误都 fail closed。

记录的 `by` 取评论作者 login。上一轮的标记、碰巧引用某个 head 的普通评论、以及其他 PR 的批准都不能满足本契约。本地信任与评论互斥，调用方不能组合两份可能分歧的批准声明。

所有 GitHub、Git 调用与 review-state 拉取完成后，评论批准进入与 start、release、complete 相同的协作式 watch-state 锁。prepare 在锁内重新读取注册，复核 repo、PR、规范化 head/round 和精确 `registrationNonce`，然后写宿主 context 与产物声明。因此评论响应暂停期间发生 release 加新 start 时，旧 prepare 必须 exit 3 且不写批准字节。锁竞争同样 exit 3，绝不把旧批准当成仍然有效；不变的 in-flight 注册重试保留 nonce，可以正常签发。实际 release 后重新 start 会轮换 nonce，需要新评论；无 nonce 的 legacy 条目仍可由现有 complete/release 读取，但必须释放并重启后才能由新的评论批准授权执行。

## 记录与发布

prepare 像现在一样先验证当前检出再写入。VM 或宿主批准有效时，把 `executionApproval` 对象加入 `--context-out` 原本就写出的同一份宿主 context 字节。对象包含 `mode`、`source`、`by`、`basis`、`reason`、可选 `attestation`、`head`、`round` 和认证所得权限。`source` 为 `local-trust` 或 `comment`；`basis` 对本地信任为 `own-pr` 或 `same-repository`，对评论为 `maintainer-comment`。本地决定没有 `approval` 永久链接；评论决定增加 `approval`、观测到的评论 id 和正文 sha256，以及它的 `registrationNonce`。声明的 `mode` 沿用现有词汇：`vm` 或 `waived`。

产物中的 `boundary.json` 携带同一对象。发布使用与宿主 `executionApproval` 的深度严格对账，不是忽略额外字段的子集检查：声名字段键必须完全一致，评论批准还必须包括同一个 `registrationNonce`。prepare 打印的 context sha256 同时覆盖批准字节。

`verify-pr-check.mjs` 遇到 `vm` 或 `waived` 产物声明时，要求可信 `--context` 快照中经过验证的 `executionApproval` 与产物声明深度相等，并且其中的 `head` 等于可信 `headRefOid`。它还按快照的 author 与 `isCrossRepository` 重新验证 `basis`。与旧的可选 context-digest 警告不同，VM 和宿主发布必须提供 `--context-sha256` 且字节匹配，同时沿用现有的克隆外、非软链和单链接规则。PR 树内的快照副本绝不作为权威来源。写入任何 context 或批准文件之前，带时间戳的产物目录必须是真实目录（不是软链或其它文件），且其完整规范路径恰好是真实 `tmp/` 目录下预期的直接子目录。普通同秒重试仍可以复用已有的真实目录；重定向或非目录以 exit 3 拒绝，不写入其目标。产物 `context.json` 同样必须不存在或是单链接普通文件，防止 symlink/hardlink 覆盖原物。`--context-out` containment 使用规范化 PR clone root 和父目录存在后的完整规范化父路径；不存在的新 leaf 不直接传给 `realpath`，真实父目录重定向回 clone 的 alias 在写批准字节前以 exit 3 拒绝。外部与树内 context、产物坐标与批准、review 快照属于同一写入组。prepare 在首次改变前保存其旧字节；稍后的失败恢复这些字节并移除本组新创建的文件。若某项恢复失败，prepare 以 exit 3 明确点名，不宣称已恢复。

容器与 CI lane 行为不变。缺少宿主记录的旧宿主或 VM 产物会被有意拒绝，不再呈现为已经预检批准的轮次。

## Skill 与 watch 流程

本地说明保留现有 register-ahead 交付规则：

```text
解析当前 head
→ 每个新的评论批准 head/round 都注册；watch / re-verification 在批准等待前注册（R17-2）
→ 选择 container / vm / host
→ vm / host 选择显式本地信任，或注册并请求他人 fork 的批准评论
→ 用匹配的 execution 与批准参数运行 prepare
→ 只有相关边界/批准门禁通过后才执行 PR 代码
```

等待批准不移到注册之前：watch cursor 已经交付 head，等待中被杀也必须留下可恢复的 in-flight 标记。从 container 切换到 host/VM 时，同一注册贯穿 prepare、电池、发布和 `--complete`，不得仅为切换模式而释放。注册也先于本地信任，但后者的 prepare 不需要公开标记或 `--state-root`。评论路径一旦使用显式 state root，后续每次 prepare 重试以及该注册的 `--complete`/`--release` 都必须沿用同一个可信 root；默认 container 路径仍不需要评论标记。

新单次本地信任轮次没有标记时使用 round 1，因为每次调用都带新的显式信任决定。评论批准轮次（包括新轮次）也要注册：第一次注册可以用 round 1，后续执行需要另一个未使用的正整数轮次，而不是静默重放旧评论。in-flight 状态唯一的 schema 新增是 `registrationNonce`；没有平行批准文件或新的 next-round 命令。瞬时 prepare 失败保留注册和 nonce，所以其重试可以沿用匹配评论。实际释放后再 `--start` 总是分配新 nonce：即使 head/round 相同，也需要新的评论标记。非评论容器重试或后续轮次只需匹配的 head/round 注册，不需要评论批准。

无人值守 watch 不得编造宿主批准。它选择容器，或停下等待维护者，不能为未来未知 head 持久保存 `--trust-pr-head`。未带 `--execution` 的旧持久 watch prompt 保持容器默认值：既不会在 cursor 交付后被拒绝，也不会被提升为未经批准的宿主轮次。

请求本地信任时说明：作者或仓库匹配不是自动豁免，标志信任的是当前完整 head。索要他人 fork 的批准时说明：评论记录不可信代码将在哪里运行；它位于 PR 可写产物树之外；不是代码评审或合并批准；并且在执行前而不是只在发布时检查。

## 涉及文件

- `scripts/verify-pr-prepare.mjs`：execution 参数、远端批准验证、context/声明写入和输出/用法说明。
- `scripts/verify-pr-check.mjs`：宿主 context 批准对账及拒绝场景。
- `scripts/tests/verify-pr-prepare.test.js`：fake-`gh` API 回复、参数与顺序覆盖、拒绝与成功见证。
- `scripts/tests/verify-pr-check.test.js`：可信权威记录、篡改、陈旧 head、缺 context/digest、CI/容器回归覆盖。
- `scripts/tests/verify-pr-model-proxy.test.js`：覆盖 skill 中全部 prepare/checker 调用的 trusted-path pin。
- `scripts/tests/qwen-triage-workflow.test.js`：register-ahead、shell replay 与发布器兼容 pin；workflow 本身不变。
- `.qwen/skills/verify-pr/SKILL.md`：本地、容器配方与 watch 调用顺序、批准说明、产物/检查器示例。
- `docs/design/verify-pr-execution-preflight.md` 与 `docs/design/verify-pr-execution-preflight.zh-CN.md`：本设计。
- `.qwen/e2e-tests/verify-pr-execution-preflight.md`：基线与本地 E2E 证据（git-ignored 工作产物）。

## 设计决定与风险

- **除向后兼容的容器调用外，显式选择执行方式。**无人值守 watch 退出本地信任。只有宿主/VM 必须选择新模式；省略参数保留旧容器行为，但不宣称容器 gate 已通过。
- **批准随现有可信 context 保存。**第二个宿主文件、摘要参数和 containment 实现会重复已经审计的信任路径。容器与 CI 快照不含 `executionApproval`；共享坐标只增加 `isCrossRepository`。
- **强制绑定 head、round 与一个注册身份。**只匹配 PR、head/round 会让已完成的批准在另一个可信 state root 中新的 `--start` 后被复用。标记评论必须携带当前 in-flight 注册持有的精确 nonce；新短 head 注册走同一规范化查找，无 nonce 的 legacy 注册 fail closed，而不是猜测身份。
- **远端验证权限与本地信任资格。**直接查询仓库权限；本地信任还要求当前用户是 PR 作者或该 PR 不是 cross-repository。两个事实各自都不构成隐式豁免。
- **发布仍是审计。**预检不替代 checker；副本对账抓住 PR 一侧替换声明的行为。
- **本改动有意拒绝旧宿主/VM 产物，而不是拒绝旧容器调用。**新流程可以显式指定容器，旧流程继续工作；宿主与 VM 调用方必须提供新批准字段，评论批准还需可信注册。CI 自有记录不使用这份契约。
- **预检不是 containment。**文档不得把它描述成后续命令确实运行在所选边界内的证明，也不得声称能防御绕过 prepare 的调用方。

## 验证与验收标准

- 单元测试与 CLI 测试证明参数拒绝早于产物创建，且拒绝不会写出新的权威批准快照。
- fake-`gh` 见证覆盖本人 fork 与同仓 PR 的合法本地信任、保留 attestation 的本地信任 VM、评论支撑的合法宿主和 VM 批准、不合格他人 fork 的本地信任尝试、评论不存在、错误 PR、重复或畸形标记、错误 head/round/nonce、评论作者权限不足（带管理员诱饵）以及 API 失败。替身按请求投影 PR 字段，并按 login 响应权限查询。
- 合法 prepare 产生相同的产物声明与宿主 context 批准；checker 接受匹配的副本。
- 编辑或删除产物声明、替换批准、改动 source 或 round、或移动可信 head 后，发布失败。
- 现有容器夹具测试与边界内门禁套件保持全绿，宿主 coordinate prepare 不增加 observed-marker 要求。
- watch/re-verification 的注册仍在批准等待之前，等待中被杀会留下现有可恢复标记。本地信任和评论批准两条路径都在无 earlier verdict 时完成 start → 模式回退 → prepare → checker 成功 → complete。匹配的在飞重试保留 nonce。state root A 完成后，在 root B 以相同 head/round 新 start 时拒绝 A 的标记、接受 B 的新标记，并有源码删除红对照。无 nonce 的 legacy 条目明确记录并测试 fresh-marker 迁移。旧持久 prompt 保留容器默认值，而不是丢失已交付 head。
- 冻结时钟真实 CLI 探针以受控 exit 3 拒绝软链或非目录的时间戳产物父目录，且不在外部写 context/批准；普通同秒重试继续成功，删除规范父目录守卫会让用例转红。只读批准文件产生受控 exit 3。checker CLI 对本地信任与评论批准的真实 VM 记录均接受，对无 context/无 digest 形态均拒绝。
- 每次本地 prepare 前移除陈旧宿主 context/digest 文件；宿主/VM checker 调用没有当前 digest 时 fail closed。
- 实现后运行脚本夹具套件、格式化、lint、build、typecheck，以及规定的 bundle 和定向 E2E 探针。
- 实现前用全局 `qwen` 0.28.3 记录缺少新选择/预检行为的基线；实现后用本地构建 CLI 与真实脚本验证，不发布评论，也不执行不可信 PR 电池。

## 待决问题

第一版没有待决问题。prepare 后撤回评论或权限，以及强制执行 confinement，是明确推迟的后续边界，不是被静默省略的实现要求。
