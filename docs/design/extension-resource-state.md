# Extension 内部资源状态管理

状态：按本设计实施中。PR 包含 Skill 状态管理的运行时与 SDK 实现；验证结果以实际构建、定向测试和 E2E 报告为准，不代表已经上线。

## 目标与边界

为 Extension 内部资源提供可持久化的 workspace 开关，允许同一个 Extension 在不同 workspace 使用不同的 Skill 组合。声明文件提供默认值，settings 始终拥有最高的 Skill 开关优先级。

新增接口使用通用 `/state` 路径，请求和响应按资源类型分组。本期只实现 `skills`；以后可以增加 `mcpServers` 等分组，而不更换路径。本期不实现 MCP 状态管理、不迁移现有 MCP 开关、不增加通用资源处理框架。

CLI Skill 管理保留现有交互和 settings 保存渠道，不增加 CLI 命令或管理 UI。新增 Extension 接口仅修改内部状态，不替调用者写 settings，也不改变整个 Extension 的启用状态。本期不提供单项写接口、全局内部开关或恢复继承接口。

## 现状

- `ExtensionConfig.skills` 是技能加载路径声明，类型为 `string | string[]`，不能将其改成开关表；`settings` 则用于 Extension 的环境变量设置，不能复用。
- Skill settings 已有 `disabled`、`enabled` 和 `defaultDisabled`。禁用集合按 `disabled > enabled > defaultDisabled` 解析，较高 scope 的硬禁用不能被 workspace 显式开启覆盖。
- Extension Management V2 已有稳定 Extension 身份、精确 workspace 覆盖、带锁的 Extension Store、原子提交和异步操作记录。整个 Extension 的开关使用 `/activation`。
- 现有 Extension MCP 禁用列表保存在全局 `extension-preferences.json`，没有 workspace 维度，不能直接包装成新的 workspace 状态接口。

相关设计：[Extension Management V2](extension-management-v2.md)、[默认关闭但可显式开启的 Skills](2026-07-20-skills-default-disabled.md)、[Skill 批量设置接口](daemon-skill-batch-toggle.md)。

## 声明与优先级

在原生 `qwen-extension.json` 中新增可选的 `skillStates: Record<string, boolean>`：

```json
{
  "name": "example-suite",
  "version": "1.0.0",
  "skillStates": {
    "skill-a": true,
    "skill-b": false
  }
}
```

键使用 `SKILL.md` 中的真实名称，不使用目录名或展示名；名称匹配沿用 Skill settings 的归一化规则。新字段必须是布尔值对象；只校验新增字段，不顺带改变其他声明字段的解析。处理合法名称时使用安全的自有属性读写，避免 `__proto__`、`constructor` 等名称被当成对象继承属性。

未声明字段、声明空对象、或未声明某个 Skill 时，该 Skill 的声明默认值均为 `true`。此字段不是接口权限或选择加入标记：所有已安装 Extension 都可使用新接口，无字段时也可以保存 workspace 覆盖。

内部开关先取当前 workspace 的覆盖值，再取声明值，最后默认开启：

```text
内部值 = workspace 覆盖值 ?? skillStates[skillName] ?? true
```

父 Extension 已启用时，最终 Skill 开关按以下优先级解析：

```text
settings.skills.disabled
  > settings.skills.enabled
  > settings.skills.defaultDisabled
  > workspace 内部覆盖值
  > extension.skillStates
  > 默认开启
```

settings 各 scope 的现有合并及硬禁用规则保持不变。父 Extension 关闭、被移除或不再拥有目标 Skill 时，Skill 不能通过内部开关或 `settings.skills.enabled` 单独复活。`user-invocable`、`disable-model-invocation` 和路径激活仍是独立的调用限制，不由本功能改写。

| 场景                                            | 最终开关       |
| ----------------------------------------------- | -------------- |
| 声明开启，settings 硬禁用                       | 关闭           |
| 内部关闭，settings 显式开启                     | 开启           |
| settings 同时声明 disabled 和 enabled           | 关闭           |
| 内部开启，settings defaultDisabled 且无 enabled | 关闭           |
| workspace A 关闭，workspace B 无覆盖且声明开启  | A 关闭，B 开启 |
| 无新字段、无 workspace 覆盖、无 settings 覆盖   | 开启           |
| 父 Extension 关闭，内部和 settings 均声明开启   | 关闭           |

## 分组批量接口

### 写入

```http
PUT /workspaces/:workspace/extensions/:extensionId/state
Content-Type: application/json

{
  "skills": [
    { "name": "skill-a", "state": "enabled" },
    { "name": "skill-b", "state": "disabled" }
  ]
}
```

每项独立指定 `enabled` 或 `disabled`。单个操作使用相同接口，传长度为 1 的数组；不新增包含 `:skillName` 的写路径。

写入只更新数组列出的 Skill，未列出的状态保持不变，并不是替换整个 Extension 的状态。内部显式开启即使与声明默认值相同，也作为 workspace 覆盖保存，不因未来声明变化而丢失调用者的选择。

本期只接受 `skills` 分组，数组长度为 1–100。收到 `mcpServers` 或其他未支持分组时返回明确错误，整批不写入；不能忽略未知分组后声称请求已成功。未来新增分组时再实现对应语义和能力协商，不提前提供不可用的处理器。

### 参数、重复项与归属

参数校验包括请求对象、非空数组、数量上限、合法非空名称，以及 `state` 的枚举值。名称按现有规则归一化；同一请求中 `skill-a` 和 `Skill-A` 属于重复项，无论开关值是否相同都拒绝，避免依赖数组顺序解决冲突。

归属校验以目标 Extension 的完整已加载 Skill 声明为准，不以 workspace 当前可调用列表为准：

- Skill 当前关闭、父 Extension 当前关闭，或 Skill 未列在 `skillStates` 中，均不阻止保存内部状态。
- 不能用项目目录、用户目录或其他 Extension 的同名 Skill 代替目标 Extension 的 Skill。
- 例如 Extension X 实际包含 A、B，请求修改 B 可以成功；请求同时修改 A、C，而 X 不包含 C，则整批失败，A 也不写入。
- 本期不允许为尚未包含在目标 Extension 中的 Skill 预声明内部开关。这与现有通用 Skill settings 接口允许未安装名称是两个不同契约。

结构非法、重复项或未支持分组在入队前返回 HTTP 400。Extension 身份和 Skill 归属等需要读取安装状态的检查在操作任务内、提交前完成；失败时操作标记为 `failed`，没有部分写入。提交点重新检查身份及制品代次，防止排队期间更新或卸载使归属检查过期。

路由复用现有 workspace 选择器、认证、信任、运行时生命周期及 generation 检查。它属于选中 runtime 的 workspace 操作，不能使用 primary workspace 的管理服务，也不能在未知、不可信或已关闭的 workspace 上回退到 primary。

GET 沿用现有 V2 只读接口的信任规则：允许读取已登记的不可信 workspace，但忽略其 workspace settings；PUT 必须针对可信 workspace。两者均不回退到 primary。

### 查询与操作结果

```http
GET /workspaces/:workspace/extensions/:extensionId/state
```

查询返回 `v: 1`、目标 workspace 和 Extension 身份，以及按类型分组的资源列表。本期只有 `skills`，每项包含：

| 字段               | 含义                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `name`             | 所属 Extension 中的真实 Skill 名称                                                        |
| `defaultEnabled`   | 声明值；未声明时为 `true`                                                                 |
| `workspaceEnabled` | 持久化的内部覆盖值；未设置时为 `null`                                                     |
| `effectiveEnabled` | 结合父 Extension 和 settings 计算的最终开关                                               |
| `disabledReason`   | 可选；沿用 `hard`、`default`、`inactive_extension`，内部关闭按可覆盖的 `default` 禁用表达 |
| `lockedScope`      | 可选；仅表达现有较高 scope 的 settings 硬禁用                                             |

`effectiveEnabled` 不代表该 Skill 一定在同名竞争中胜出，也不取代调用可见性、路径激活等限制。它是配置计算结果，不是所有现有会话已刷新成功的证明。

GET 从选中 workspace 的 ExtensionManager 获取完整所属 Skill，结合对应 settings 和 store 快照计算，不依赖先创建 ACP 会话，也不借用缺少 Extension 数据的 daemon-local `/skills` 回退目录。

PUT 沿用 `202 + operationId` 和 `/extensions/operations/:operationId` 查询。`202` 只表示受理，操作名为 `set_extension_state`，成功结果使用 `status: updated`，不使用 `enabled` 暗示所有目标最终开启。新增 `result.resourceStates.skills` 按请求顺序返回本次涉及的状态；现有 `ExtensionOperationResult.states` 表示版本更新检查结果，不能复用或改变其类型。

例如 settings 禁用了 A，PUT 仍可以成功保存 A 的内部开启值，但查询和操作结果中的 `effectiveEnabled` 必须保持 `false`。用户在 settings 显式开启后，内部关闭同样不能越过该显式开启；需要修改 settings 才能移除这层覆盖。

### SDK 与能力标记

在 `WorkspaceDaemonClient` 增加 `extensionState(extensionId)` 和 `setExtensionState(extensionId, update, clientId?)`，请求体保留资源分组与数组，不提供单项写方法。导出 `WorkspaceExtensionState`、`ExtensionStateUpdate` 及对应 Skill 状态类型。

客户端通过现有 `workspaceById()` 或 `workspaceByCwd()` 选择目标。新接口使用 REST，能力标记为 `extension_state`；本期契约明确只支持 `skills`，不能据此认定 daemon 已支持 MCP。不能向旧 Skill 设置接口自动降级，因为旧接口写 settings，会改变优先级和影响范围。

## 持久化、刷新与运行时

### 一次原子提交

在现有 `ExtensionPolicy` 增加可选的 `skillWorkspaceOverrides`，按规范化 workspace 路径和 Skill 名称保存布尔值。复用 Extension Store 的身份、锁、原子写入和 generation，不另建偏好存储；旧 version-2 快照缺少该字段时无需迁移。

一个批次只针对一个已安装 Extension 和一个 workspace。使用一次单 Extension 的 store mutation 合并全部条目，一次提交、一次 generation 更新，再发布新快照；不循环调用单项 mutation，也不创建不存在的 Extension 声明。所有条目校验通过后才允许提交，写入失败不刷新。

精确 workspace 路径沿用现有规范化规则，同一路径的符号链接别名不能形成独立覆盖；不引入祖先路径匹配。不同 workspace、不同 Extension、未列出的 Skill 状态均保留。并发批次在锁内读取最新快照并合并，不覆盖其他批次的无关更新。

Extension 更新保留覆盖值，包括新版本移除 `skillStates` 的情况；字段缺失只改变默认值，不取消已保存的覆盖。卸载清理对应策略及内部状态。更新移除的 Skill 不参与当前状态查询，其历史覆盖不影响其他来源。

### 刷新与真实执行

复用现有操作提交和 runtime 定向刷新链路，为本操作增加仅刷新 Skill 相关内容的模式。成功接收新代次的 runtime 先应用 Extension 状态快照，再更新 Skill 缓存、命令和模型上下文；覆盖 bootstrap 和目标 workspace 的全部会话，而不是只刷新一个 live channel。

新模式不重启无关 MCP、LSP 或 hooks；旧 Extension 操作不启用该模式，行为不变。并发刷新合并必须区分模式，防止 Skill 请求复用会吞掉错误的旧刷新，或全量刷新误复用 Skill-only 刷新而遗漏其他能力。

直接的 Skill 缓存、命令发送和会话刷新失败必须进入现有失败计数或 warning，不能只写日志然后报告完全成功。持久化成功后不因刷新失败回滚；无会话时由下次启动读取，部分刷新失败则保留已提交状态并通过操作结果说明。刷新前后失效目标 workspace 的状态缓存。现有共享 store 代次观察可能随后触发其他 runtime 重新读取，但其他 workspace 的开关值不变。

新增带来源的实时开启判断，保留 settings-only 禁用集合的含义，不将 Extension 内部关闭的名称塞进全局禁用集合。它使用所属 ExtensionManager 的 workspace 状态及实时 settings，覆盖 SkillTool、模型可用列表、slash commands、CLI 管理和状态映射。保留关闭项的发现信息，不因为内部关闭而把它从管理目录中删除。

执行防线必须放在技能正文、权限授予、参数文件写入和 hooks 之前，并重新检查实际来源。对已应用新代次的 runtime，旧 command action 和旧 invocation 也不能凭捕获的旧布尔值执行已关闭 Skill。独立的同名 Skill 或普通命令继续按现有来源选择和回退规则处理，不借本功能统一 core 与 slash 的既有优先级。

不承诺撤回已经发出的模型请求，也不在桥接刷新失败时声称所有会话已经采用新状态。

## 现有 Skill 管理的兼容性

CLI Skill 管理保持原有交互，只写 workspace settings，不写 Extension 内部 store。开启内部关闭项时记录 `skills.enabled`；关闭时写 `skills.disabled` 并移除对应显式开启。较高 scope 的硬禁用锁继续生效。

现有单个及批量 Skill REST 开启请求统一作为显式 opt-in：移除该 workspace 的 disabled 项，并记录 enabled 项。无需查询是否安装，也不增加 Extension 归属限制。关闭流程保持现有语义。

这有一项明确的持久化行为调整：以前部分开启请求被视为默认已开而不写文件，实施后会记录显式 `skills.enabled`，包括未安装名称。重复同值请求保持最终状态不变。此调整用于确保原管理入口可以覆盖 Extension 的内部关闭，不能继续让 enable 请求无写入却声称已经开启。

## 实施与验收

实现涉及原生 Extension 声明解析、Extension Store/Manager、core 的来源感知开关判断、CLI settings 与执行入口、workspace 状态映射、daemon 路由、ACP 刷新和 TypeScript SDK。只在这些链路补齐所需行为，不实现未来资源的注册框架，也不修改现有 MCP preferences。

实现前由 test-engineer 建立全局 CLI 基线；定向测试与隔离 E2E 按风险覆盖以下行为，不为矩阵数量重复测试：

1. 声明缺字段、空对象、缺项、显式真假、非法值及特殊合法名称；无字段 Extension 也能保存内部覆盖。
2. 完整 settings 优先级矩阵、父 Extension 关闭、同名其他来源不串状态；保留已有模型及用户调用限制。
3. 长度为 1、混合开关、数量边界、空数组、重复名称、未知分组、无效末项；任意校验失败均零写入、零刷新。
4. 关闭的自有 Skill 可写，外来或尚未包含的 Skill 不可写；旧通用 Skill settings 接口仍接受未安装名称。
5. 两 workspace、路径别名、重启、更新、移除声明字段、卸载；并发批次不丢无关条目，制品或 workspace 代次变化时不提交过期请求。
6. 每批一次提交和一次定向刷新；冷启动、bootstrap、多会话、写入失败、提交后刷新失败及两种刷新模式并发。
7. 旧 action/invocation 在 runtime 应用关闭状态后不可执行正文或产生权限等副作用；独立命令回退仍正常。
8. CLI 保存、原单个/批量 Skill API、通用 SDK、GET 状态、slash commands 和模型实际执行一致；现有 MCP 行为不变。

实现交付需要相关包的定向单元测试、build、typecheck、bundle、E2E 和完整 diff 自审。全局基线已确认声明关闭未生效且缺少新接口；该全局版本早于多 workspace API，其路由缺失不作为当前源码回归。最终验证报告单独附在 PR，不将验收清单当作已完成的测试证据。
