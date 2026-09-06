# Ripgrep 运行时可靠性实施方案

## 1. 背景与决策

当 ripgrep 缺失时，Qwen Code 已经提供了主要的回退链路：

```text
内置 ripgrep -> 系统 ripgrep -> GrepTool
                                 -> git grep
                                 -> 系统 grep
                                 -> JavaScript 文件遍历
```

剩余的高 ROI 工作是保证运行时结果的完整性，而不是再引入一个二进制依赖或另一套通用回退层。本方案将以下四项相关改进作为一项有明确边界的改动来实施：

1. 当确认 ripgrep 因创建线程而发生 `EAGAIN` 错误时，以单线程模式重试一次。
2. 只有 stdout 和 stderr 均为空时，才将退出码 1 解释为“没有匹配项”。
3. 区分搜索未完整执行和普通的输出截断，绝不将未完整执行的搜索报告为“未找到匹配项”。
4. 记录不涉及隐私的运行时恢复 telemetry，以便衡量实际收益。

### 不在范围内

- 不引入 `@vscode/ripgrep`；Qwen Code 已经随包提供了针对不同平台的二进制文件。
- 不改变当前“内置版本优先、系统版本其次”的选择顺序。
- 不永久降低 ripgrep 的线程数。
- 不在每一种运行时失败后都自动切换到 `GrepTool`。权限、参数和文件系统错误必须保持可见，不能隐藏在语义不同且速度更慢的搜索之后。
- 不重试 Node.js 子进程启动阶段的 `EAGAIN`。尚未成功启动的进程无法从 ripgrep 的 `--threads 1` 参数中获益；这类问题仍应作为明确的 `spawn` 失败处理。

## 2. 修改目的与前后行为

本次修改不是为了让搜索“永不失败”，而是为了保证 Qwen Code 能准确区分以下三种事实：确实没有匹配项、搜索失败且没有可用结果、搜索失败但产生了部分结果。模型只有看到正确的事实，才能决定是缩小搜索范围、改用其他工具，还是继续使用已有的部分结果。

### 2.1 EAGAIN 单线程重试

**修改目的：** 在资源受限的容器或 CI 环境中，ripgrep 进程可能已经成功启动，但无法创建所需的工作线程。此时搜索逻辑和参数本身没有问题，降低并发度后通常仍有机会完成搜索。重试只针对能够确认的线程创建失败，避免把参数错误、权限错误或子进程启动失败错误地当成可恢复问题。

**修改前：** `RipGrepTool` 固定传入 `--threads 4`。`runRipgrep()` 遇到 EAGAIN 后不会重试：如果该错误未先被退出码 1 分支解释成无匹配项，并且没有 stdout，工具会向模型返回明确的 grep 错误；如果已经产生 stdout，后续逻辑可能继续消费这些部分结果，但不会说明本次搜索因 EAGAIN 提前终止。

```text
rg --threads 4
  -> 创建线程失败
  -> 不重试
  -> 退出码 1：被视为无匹配
  -> 其他错误且无 stdout：返回错误
  -> 有 stdout：可能被当作完整结果使用
```

**修改后：** 只有 stderr 能够确认是 ripgrep 内部线程创建 EAGAIN，且请求尚未取消时，才把当前调用的 `--threads 4` 替换为 `--threads 1` 并重试一次。重试成功后返回完整结果；重试仍失败时返回错误或明确标记的部分结果。后续搜索仍然使用 4 个线程，不会因为一次临时故障而永久降速。

```text
rg --threads 4
  -> 确认线程创建 EAGAIN
  -> rg --threads 1，仅重试一次
     -> 成功：返回完整结果
     -> 失败且无 stdout：返回明确错误
     -> 失败但有 stdout：返回明确标记的部分结果
```

### 2.2 收紧退出码 1 的无匹配项判定

**修改目的：** 防止 Qwen Code 把带有错误信息或异常输出的退出码 1 一律解释成“仓库中不存在该内容”。“没有匹配项”是会影响模型后续推理的强结论，只有在 ripgrep 确实正常表达无匹配时才能使用。

**修改前：** `runRipgrep()` 只要看到 `error.code === 1`，就立即返回空 stdout，并丢弃本次调用携带的 stdout 和 stderr。即使退出码 1 同时带有错误信息，模型最终也会看到 `No matches found`。

```text
退出码 1 + 空 stdout + 空 stderr -> No matches found
退出码 1 + 非空 stderr           -> No matches found
退出码 1 + 非空 stdout           -> stdout 被丢弃，No matches found
```

**修改后：** 只有退出码为 1 且 stderr 为空时，才返回正常的无匹配项结果。退出码 1 但 stderr 不为空时按执行失败处理。stdout 不参与判定：ripgrep 的退出码 1 不可能携带匹配结果，而在 `--json` 模式下即使零匹配也会在 stdout 输出末尾的 summary 事件。

```text
退出码 1 + 空 stderr   -> No matches found
退出码 1 + 非空 stderr -> 明确的执行错误
```

### 2.3 区分截断结果与未完整执行结果

**修改目的：** 让模型知道“为了控制输出长度只展示了一部分”和“底层搜索没有执行完”是两件完全不同的事。前者仍能证明完整搜索中存在这些匹配项；后者不能用来证明其他文件中没有匹配项。

**修改前：** `runRipgrep()` 使用 `truncated` 同时承载超时、超过最大缓冲区等底层终止情况，`RipGrepTool` 又把它和行数、字符数限制合并展示。发生错误但已经产生 stdout 时，工具只在 stdout 为空时抛错；非空 stdout 会继续被解析。它可能表现为普通结果、`(truncated)`，甚至在 stdout 为空或未解析出有效匹配项时进入两个 `No matches found` 分支。模型无法可靠判断搜索是否真正完成。

**修改后：** 展示层主动裁剪只使用 `truncated`；超时、超过最大缓冲区或其他执行错误导致的提前终止使用 `incomplete`。处理顺序先判断执行完整性，再判断是否存在有效匹配项：

| 修改后的执行结果             | 模型看到的结果                           | 模型可以得出的结论                                 |
| ---------------------------- | ---------------------------------------- | -------------------------------------------------- |
| 完整执行且没有匹配项         | `No matches found`                       | 可以认为本次搜索范围内没有匹配项                   |
| 完整执行但展示内容超限       | 结果加 `(truncated)`                     | 搜索已完成，只是未展示全部匹配行                   |
| 未完整执行且没有有效匹配项   | 明确的搜索未完成错误                     | 不能认为仓库中没有匹配项，应调整搜索或改用其他方法 |
| 未完整执行但有有效匹配项     | 部分结果加 `(incomplete)` 和固定警告     | 可以使用已返回的匹配项，但不能据此排除其他位置     |
| 同时发生展示裁剪和执行未完成 | 同时显示 `(truncated)` 与 `(incomplete)` | 既没有展示所有已获得结果，底层搜索也没有完成       |

### 2.4 运行时恢复 Telemetry

**修改目的：** 衡量 EAGAIN 重试和结果完整性保护在真实环境中的发生频率、成功率和失败类型，以数据决定是否值得继续投入更复杂的运行时回退能力，同时避免采集用户的查询内容和仓库信息。

**修改前：** 现有 `RipgrepFallbackEvent` 只在启动探测失败、Qwen Code 从 `RipGrepTool` 切换到 `GrepTool` 时发送。启动后发生的 EAGAIN、超时、超过最大缓冲区、异常退出或 spawn 失败没有专门的结构化指标，因此无法回答“运行时恢复是否真的有用”。

**修改后：** 新增语义独立的 `RipgrepRuntimeRecoveryEvent`，只在发生重试或最终执行异常时发送。事件记录内置/系统二进制选择、是否触发重试、重试是否成功和固定失败分类，但不记录搜索表达式、路径、stdout、stderr、文件名或原始错误信息。正常成功搜索不发送事件，避免增加无意义的日志量。

### 2.5 单次结算保护

**修改目的：** 保证新增重试逻辑最多执行一次。`execFile` 的回调和子进程 `error` 事件可能针对同一次启动失败先后到达；如果两个通道分别决定重试，可能启动两个单线程搜索。

**修改前：** 两个通道都可以尝试 resolve 同一个 Promise。由于 Promise 只接受第一次结算，而当前又没有重试逻辑，通常不会产生用户可见的重复执行，但该结构不适合直接加入恢复分支。

**修改后：** 单次执行 helper 使用共享的 settlement guard，只生成一个结构化执行结果。外层逻辑必须等待该结果后再决定是否重试，因此一次搜索最多启动一个恢复调用。

### 2.6 整体行为变化

```text
修改前
执行 rg
  -> code 0：处理结果
  -> code 1：一律视为无匹配
  -> 其他错误且无 stdout：返回错误
  -> 其他错误但有 stdout：可能作为完整或截断结果继续处理

修改后
执行 rg
  -> code 0：处理完整结果
  -> code 1 + stdout/stderr 均为空：确认无匹配
  -> 已确认线程 EAGAIN：单线程重试一次
  -> 最终失败且无 stdout：返回明确错误
  -> 最终失败但有 stdout：保留可用匹配项并标记 incomplete
  -> 除取消外的最终异常或恢复：发送不包含查询内容的结构化 telemetry
```

## 3. 必须满足的运行时语义

### 3.1 单次执行结果

重构 `packages/core/src/utils/ripgrepUtils.ts` 中的 `runRipgrep()`，提取一个内部的单次执行 helper。该 helper 必须保留现有的 20 MB 缓冲区、平台相关超时、`AbortSignal`、部分 stdout，以及移除可能不完整的最后一行等行为。

该 helper 必须确保只结算一次。`execFile` 可能同时通过回调和子进程的 `error` 事件报告启动失败，因此回调和事件处理必须共用同一个结算保护。只有在第一次 helper 调用返回之后才能决定是否重试；任何一个完成通道都不得直接发起重试。

使用固定且不包含敏感信息的值对失败进行分类：

```typescript
type RipgrepFailureKind =
  | 'eagain'
  | 'timeout'
  | 'max_buffer'
  | 'exit'
  | 'spawn';
```

取消操作不属于运行时失败 telemetry，也不得触发重试。

### 3.2 无匹配项的判定

只有同时满足以下两个条件时，才将一次调用解释为成功完成但没有匹配项：

```text
退出码 === 1
stderr.trim() === ''
```

ripgrep 的退出码约定：0 = 找到匹配，1 = 无匹配且无错误，2 = 出错。退出码 1 不可能携带匹配结果，因此不需要检查 stdout。在 `--json` 模式下，ripgrep 即使零匹配也会在 stdout 输出末尾的 `summary` 事件，所以 stdout 是否为空不能作为判据。

退出码为 1 但 stderr 不为空时，属于执行失败。

### 3.3 EAGAIN 恢复

只有同时满足以下所有条件时，才重试一次：

- 当前是第一次执行，而不是重试。
- 请求尚未被取消。
- stderr 能够确认是 ripgrep 内部创建线程失败：匹配简短标记 `os error 11`，或者要求线程创建上下文和完整的资源不可用错误信息同时存在。不得只匹配通用的资源不可用文案。
- 现有参数列表包含当前的 `--threads 4` 参数对。

重试时，将线程数的值替换为 `1`。不要增加延迟，不要支持没有实际需求的其他参数写法，也不要为后续搜索持久化单线程模式。重试成功后返回完整的成功结果，不保留第一次尝试产生的错误或不完整状态。

### 3.4 完整、截断与未完整执行

明确区分以下三种状态：

- **完整（Complete）：** ripgrep 正常执行完成。
- **截断（Truncated）：** Qwen Code 为了展示，按行数或字符数主动限制了一份原本完整的输出。
- **未完整执行（Incomplete）：** ripgrep 在产生 stdout 后因执行错误而终止，包括超时和超过最大缓冲区导致的终止；现有匹配项只是仓库搜索结果的一部分。

扩展 `RipgrepRunResult`，使用结构化元数据，而不是原始 stderr 或错误文本：

```typescript
interface RipgrepRecoveryMetadata {
  selectionMode: 'builtin' | 'system';
  retryTriggered: boolean;
  retrySucceeded?: boolean;
  failureKind?: RipgrepFailureKind;
}

interface RipgrepRunResult {
  stdout: string;
  incomplete: boolean;
  error?: Error;
  recovery: RipgrepRecoveryMetadata;
}
```

实现时可以进一步简化具体结构，但 utility 的结果不得继续使用当前的 `truncated` 字段表示超时或超过最大缓冲区的失败。展示层截断由 `RipGrepTool` 计算；utility 负责报告执行未完成状态和重试结果。恢复元数据不得包含搜索表达式、搜索路径、stdout、stderr 或原始错误信息。

在 `packages/core/src/tools/ripGrep.ts` 中，必须先判断执行是否完整，然后才能进入现有的两个 `No matches found` 分支：

| 执行结果                                  | 工具行为                                         |
| ----------------------------------------- | ------------------------------------------------ |
| 发生错误且没有 stdout                     | 返回明确的 grep 执行错误                         |
| 发生错误且有 stdout，但未解析出有效匹配项 | 返回明确的搜索未完整执行错误；绝不返回没有匹配项 |
| 发生错误且至少解析出一个有效匹配项        | 返回部分匹配项，并使用固定提示说明搜索未完成     |
| 执行完整但没有有效匹配项                  | 返回现有的无匹配项结果                           |

部分结果在 `returnDisplay` 中使用 `(incomplete)`，并向 LLM 输出固定提示，例如：`搜索未完整执行：以上结果可能未包含所有匹配项。`普通的结果数量限制继续使用 `(truncated)`。这两个标签可以同时存在，但不能相互替代。执行失败时，不得继续产生当前这种容易误导的 `[0 lines truncated]` 提示。

## 4. 运行时 Telemetry

新增独立的 `RipgrepRuntimeRecoveryEvent`；不要复用 `RipgrepFallbackEvent`，后者专门表示启动阶段注册的工具从 `RipGrepTool` 切换到了 `GrepTool`。

只有发生重试或最终执行异常时才发送新事件。必需字段如下：

```typescript
selection_mode: 'builtin' | 'system';
retry_triggered: boolean;
retry_succeeded?: boolean;
failure_kind: 'eagain' | 'timeout' | 'max_buffer' | 'exit' | 'spawn';
```

不得记录搜索表达式、路径、stdout、stderr、原始错误信息或文件名。没有进行恢复的正常成功搜索不发送新事件。

`ripgrepUtils.ts` 继续保持不依赖 `Config` 和 telemetry。它只返回恢复元数据；持有 `Config` 的 `RipGrepTool.performRipgrepSearch()` 在返回部分结果或抛出最终错误之前发送事件。

通过现有 telemetry 层接入该事件：

- `packages/core/src/telemetry/types.ts`
- `packages/core/src/telemetry/constants.ts`
- `packages/core/src/telemetry/loggers.ts`
- `packages/core/src/telemetry/qwen-logger/qwen-logger.ts`
- `packages/core/src/telemetry/index.ts` 中的 telemetry 公共导出

覆盖现有的 Qwen logger 和 OpenTelemetry 日志路径。不需要额外设计一套独立的 Clearcut 集成。

## 5. 实施顺序

1. 添加单次执行 helper，以及 mock `execFile` 的聚焦单元测试框架，其中包括子进程 `EventEmitter` 和单次结算行为。
2. 收紧退出码 1 的判定并添加失败分类，此时暂不改变重试行为。
3. 添加针对已确认线程 EAGAIN 的单次重试，将 `--threads 4` 替换为 `--threads 1`。
4. 将结构化的 `incomplete` 和恢复元数据从 `runRipgrep()` 传递到 `RipGrepTool`。
5. 更新两个无匹配项判定位置，分别渲染未完整执行和截断提示。
6. 在工具层添加并接入独立的运行时恢复 telemetry 事件。
7. 运行聚焦验证，然后执行仓库要求的 build、typecheck 和自审流程。

保持这些步骤相互独立，有助于快速定位回归问题，也能避免 telemetry 工作掩盖核心的结果语义变更。

## 6. 测试方案

### `packages/core/src/utils/ripgrepUtils.test.ts`

使用 Vitest hoisted mock 模拟 `node:child_process`，并覆盖：

- 退出码 1 且 stdout 和 stderr 均为空时，得到完整的无匹配项结果。
- 退出码 1 但 stderr 不为空时，得到 `exit` 失败。
- 退出码 1 但 stdout 不为空时，保留 stdout 并标记为未完整执行。
- 确认线程 EAGAIN 后重试一次，并使用 `--threads 1` 成功完成。
- 确认线程 EAGAIN 后重试一次，但重试仍然失败。
- 重试只替换现有线程数，且不修改调用方传入的参数数组。
- `AbortError`/`ABORT_ERR` 不触发重试。
- 子进程启动阶段的 `EAGAIN` 不触发重试，并被分类为 `spawn`。
- 超时和超过最大缓冲区时，部分输出会移除可能不完整的最后一行。
- 回调和子进程 `error` 事件不能导致重复结算或发起两次重试。

### `packages/core/src/tools/ripGrep.test.ts`

覆盖面向工具调用方的语义：

- 完整执行产生空输出时，仍然返回 `No matches found`。
- 未完整执行但包含有效匹配项时，返回这些匹配项和明确的未完成提示。
- 未完整执行的 stdout 未解析出任何有效匹配项时，返回未完整执行错误，而不是 `No matches found`。
- 发生错误且没有 stdout 时，仍然返回明确的 grep 执行错误。
- 截断和未完整执行标签保持独立，并且可以同时存在。

### Telemetry 测试

扩展 logger 和 Qwen logger 测试，验证：

- 重试成功事件包含选择模式、触发状态、成功状态和 EAGAIN 分类。
- 最终异常结果包含固定的失败分类。
- 正常成功的搜索不会产生运行时恢复事件。
- OpenTelemetry 事件名称、body 和 Qwen logger 属性正确。
- 事件中不存在搜索表达式、路径、stdout、stderr 或原始错误字段。

## 7. 验证与验收条件

按照 `AGENTS.md` 的要求，从对应 package 或仓库位置运行：

```bash
cd packages/core && npx vitest run src/utils/ripgrepUtils.test.ts
cd packages/core && npx vitest run src/tools/ripGrep.test.ts
cd packages/core && npx vitest run src/telemetry/loggers.test.ts
npm run typecheck
npm run build
```

如果实现修改了 `loggers.test.ts` 之外的 Qwen logger 专用测试，还需要运行相应的聚焦测试文件。

只有满足以下条件，才能认为改动已经完成：

- 一次确认的 ripgrep 线程 EAGAIN 最多触发一次单线程重试。
- 取消操作和子进程启动失败绝不触发该重试。
- 只有退出码 1 且 stderr 为空时，才表示没有匹配项（不检查 stdout）。
- 任何未完整执行路径都不能进入两个 `No matches found` 返回分支。
- 部分匹配项对模型仍然有用，但必须明确标记为未完整执行。
- Telemetry 能够衡量恢复情况，同时不采集查询内容或仓库内容。
- 聚焦测试、typecheck 和 build 全部通过。
- 按照仓库要求对完整 diff 进行自审，并在最后一次修复后连续完成两遍无问题检查。

## 8. 成本、收益与回滚

预计实施成本约为 1.5–3 个工程师工作日，其中包括测试和 telemetry 接入。该范围有意控制得比通用运行时回退重构更小。

直接收益包括：

- 当 ripgrep 无法创建正常数量的工作线程时，可以在资源受限的 CI 或容器环境中恢复搜索。
- 消除退出码 1 伴随错误时产生的假阴性。
- 消除部分搜索结果伪装成完整仓库证据的问题。
- 获得生产数据，用于判断是否值得继续投入其他恢复能力。

回滚范围是局部的：可以移除重试分支和运行时事件，而无需改变二进制选择或现有启动回退逻辑。即使回滚重试本身，也应保留更严格的无匹配项判定和未完整执行语义，因为它们对正确性的保护与 EAGAIN 的实际发生频率无关。

## 9. 已吸收的 Review 意见

一名 Sub Agent 已基于当前仓库源码 review 本方案。其 review 对初始草案做出了以下实质性调整：

- 不再复用启动回退 telemetry，改为独立的运行时事件；
- 将 telemetry 发送位置从 utility 层移动到 `RipGrepTool`；
- 移除对子进程启动阶段 `EAGAIN` 的推测性延迟重试；
- 将 EAGAIN 检测收窄为已确认的线程创建失败；
- 移除对当前不可能出现的缺失线程参数和其他参数写法的支持；
- 区分 `incomplete` 和 `truncated`；
- 要求在两个无匹配项分支之前检查执行完整性；
- 要求退出码 1 的无匹配项判定以 stderr 为空为准（不检查 stdout）；
- 添加单次结算和零有效匹配项的回归测试；
- 恢复未来实施验证所需的仓库 build 步骤。
