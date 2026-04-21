# Phase 2 技术设计文档：能力扩展

## 1. 设计目标与约束

### 1.1 目标

- 将 13 个 built-in 命令的 `supportedModes` 扩展到包含 `non_interactive` 和/或 `acp`
- 确保每个扩展命令在 ACP/non-interactive 路径下返回适合 IDE 消费的文本内容
- 打通 prompt command 的模型调用通路（`SkillTool` 消费 `getModelInvocableCommands()`）
- 实现 mid-input slash command 基础检测

### 1.2 硬性约束

- **interactive 路径零退化**：所有扩展命令的现有 interactive 行为严格不变，只在 action 内部新增模式分支，不触碰 interactive 路径代码
- **实现策略：模式分支，而非双注册**：13 个命令均采用在 `action` 内部增加 `executionMode` 判断的方式，不使用 Phase 1 设计文档 §10.2 描述的双注册模式（双注册仅在 interactive 和 non-interactive 逻辑差异极大时才有必要，本阶段命令复杂度不达到该门槛）
- **ACP 消息格式**：ACP 路径返回的文本内容不含 ANSI 样式，以 Markdown 或纯文本为宜，面向 IDE 插件消费
- **跳过环境相关副作用**：打开浏览器（`open()`）、操作剪贴板（`copyToClipboard()`）等依赖图形环境的操作，在 non-interactive/ACP 路径下必须跳过

---

## 2. Phase 1 完成后的基础状态

Phase 1 结束后的架构要点（Phase 2 直接在此基础上扩展）：

- `commandType` 字段已从 `SlashCommand` 接口中删除，所有命令改用显式 `supportedModes`
- `getEffectiveSupportedModes()` 为两级推断：显式 `supportedModes` → `CommandKind` 兜底
- `CommandService.getCommandsForMode(mode)` 取代原 `ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE` 白名单
- `btw`、`bug`、`compress`、`context`、`init`、`summary` 已在 Phase 1 中扩展到全模式，**不在本阶段列表中**
- `createNonInteractiveUI()` 中各方法均为 no-op：`addItem`、`clear`、`setDebugMessage`、`setPendingItem`、`reloadCommands` 均静默忽略调用

---

## 3. 变更范围总览

本阶段共涉及 13 个命令，按实现复杂度分为四类：

| 类别      | 命令                                         | 变更要点                                                                           |
| --------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| **A 类**  | `export`、`plan`、`statusline`               | 只改 `supportedModes`，action 所有路径已返回合法类型                               |
| **A+ 类** | `language`、`copy`、`restore`                | 改 `supportedModes` + 少量 non-interactive 分支处理                                |
| **A' 类** | `model`、`approval-mode`                     | 有参数路径已返回 `message`，无参数路径需新增 non-interactive 分支（现触发 dialog） |
| **B 类**  | `about`、`stats`、`insight`、`docs`、`clear` | action 所有路径均无返回值或调用 `addItem`/`clear`，需新增完整 non-interactive 分支 |

---

## 4. A 类：只改 `supportedModes`

这三个命令的所有 `action` 路径已经返回 `message` 或 `submit_prompt`，完全无 UI 依赖，`handleCommandResult` 可直接处理。

### 4.1 `/export`（及子命令）

**当前状态**：`supportedModes: ['interactive']`，所有子命令 action 均返回 `MessageActionReturn`。

**变更**：将父命令及所有四个子命令（`md`、`html`、`json`、`jsonl`）的 `supportedModes` 改为 `['interactive', 'non_interactive', 'acp']`。

**ACP 消息内容**：action 现有返回内容已包含完整文件路径（如 `Session exported to markdown: qwen-export-2024-01-01T12-00-00.md`），对 IDE 消费友好，无需修改文本。

> **注意**：`/export` 父命令本身没有 `action`，只有子命令。将父命令 `supportedModes` 改为全模式后，`parseSlashCommand` 能够匹配子命令路由，但若用户只输入 `/export` 不带子命令，`commandToExecute.action` 为 undefined，`handleSlashCommand` 返回 `no_command`，调用方会显示可用子命令提示。这是预期行为。

### 4.2 `/plan`

**当前状态**：`supportedModes: ['interactive']`，action 所有路径返回 `MessageActionReturn` 或 `SubmitPromptActionReturn`。

**变更**：将 `supportedModes` 改为 `['interactive', 'non_interactive', 'acp']`，action 无需任何修改。

**ACP 语义**：`/plan <task>` 在 ACP 中提交 prompt，让模型进入 plan 模式分析任务；`/plan exit` 退出 plan 模式返回确认消息。两者对 IDE 均有意义。

### 4.3 `/statusline`

**当前状态**：`supportedModes: ['interactive']`，action 始终返回 `SubmitPromptActionReturn`（将 subagent 调用 prompt 提交给模型）。

**变更**：将 `supportedModes` 改为 `['interactive', 'non_interactive', 'acp']`，action 无需任何修改。

---

## 5. A+ 类：少量 non-interactive 分支处理

### 5.1 `/language`

**当前状态**：action 所有路径均返回 `MessageActionReturn`（读取/设置语言设置）。

**需要处理的副作用**：`setUiLanguage()` 内调用 `context.ui.reloadCommands()`，在非交互 UI 中已是 no-op，无需额外处理。

**变更**：

- 将父命令及子命令（`ui`、`output`，以及 `SUPPORTED_LANGUAGES` 动态生成的子命令）的 `supportedModes` 改为 `['interactive', 'non_interactive', 'acp']`。
- action 无需添加模式分支，现有返回文本已适合机器消费。

**ACP 语义说明**：在 non-interactive（单次调用）中执行 `/language ui zh-CN` 会修改持久化设置（写入 settings 文件），该变更对后续 session 生效，本次 session 内 i18n 也立即生效。这与用户预期一致。

### 5.2 `/copy`

**当前状态**：action 调用 `copyToClipboard()`，在 ACP/headless 环境中可能抛出异常或无声失败（clipboard 不可用）。

**变更**：

1. 将 `supportedModes` 改为 `['interactive', 'non_interactive', 'acp']`。
2. 在 action 内新增模式分支：

```typescript
// 获取 last AI message（现有逻辑，可复用）
if (context.executionMode !== 'interactive') {
  // 非交互/ACP：跳过剪贴板，返回内容本身
  if (!lastAiOutput) {
    return {
      type: 'message',
      messageType: 'info',
      content: 'No output in history.',
    };
  }
  return {
    type: 'message',
    messageType: 'info',
    content: lastAiOutput,
  };
}
// interactive 路径：原有剪贴板逻辑不变
await copyToClipboard(lastAiOutput);
return {
  type: 'message',
  messageType: 'info',
  content: 'Last output copied to the clipboard',
};
```

**ACP 语义**：IDE 收到最后一条模型输出的原文，可自行决定是否写入剪贴板或展示给用户。

### 5.3 `/restore`

**当前状态**：action 在以下情况返回非 `message` 类型：

- 无参数时：返回 `MessageActionReturn`（列出可用 checkpoint），✅ 已兼容
- 有参数时：调用 `ui.loadHistory()`（no-op）、设置 gemini client history、恢复 git 快照，最终返回 `{ type: 'tool', ... }`（在 `handleCommandResult` 中变成 `unsupported`）

**变更**：

1. 将 `supportedModes` 改为 `['interactive', 'non_interactive', 'acp']`（父命令 `restoreCommand` 工厂函数中）。
2. 在 action 的有参数路径（成功恢复后）新增模式分支：

```typescript
// 原有 git 恢复和 client history 设置逻辑保持不变
if (toolCallData.commitHash) {
  await gitService?.restoreProjectFromSnapshot(toolCallData.commitHash);
}
if (toolCallData.clientHistory) {
  await config?.getGeminiClient()?.setHistory(toolCallData.clientHistory);
}

if (context.executionMode !== 'interactive') {
  // 非交互/ACP：返回确认消息，不返回 type: 'tool'
  const toolName = toolCallData.toolCall?.name ?? 'unknown';
  return {
    type: 'message',
    messageType: 'info',
    content: `Restored checkpoint: ${selectedFile}\nProject state reset to before tool call: ${toolName}\nNote: Tool re-execution is not supported in non-interactive mode.`,
  };
}

// interactive 路径：原有 addItem + 返回 type: 'tool' 不变
addItem(
  { type: 'info', text: 'Restored project to the state before the tool call.' },
  Date.now(),
);
return {
  type: 'tool',
  toolName: toolCallData.toolCall.name,
  toolArgs: toolCallData.toolCall.args,
};
```

**ACP 语义**：checkpoint 的 git 状态恢复和 gemini client history 设置均作为副作用执行；IDE 收到确认消息后可提示用户"状态已恢复"，工具重执行由 IDE 自行决定是否触发。

---

## 6. A' 类：无参数 dialog 路径的 non-interactive 处理

### 6.1 `/model`

**当前状态**：

| 输入                             | 当前行为                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `/model`（无参数）               | → `{ type: 'dialog', dialog: 'model' }`（non-interactive 下变 unsupported）      |
| `/model <model-id>`              | 未实现（只有 `--fast` 分支）                                                     |
| `/model --fast`（无 model name） | → `{ type: 'dialog', dialog: 'fast-model' }`（non-interactive 下变 unsupported） |
| `/model --fast <model-id>`       | → `MessageActionReturn` ✅                                                       |

**变更**：

1. 将 `supportedModes` 改为 `['interactive', 'non_interactive', 'acp']`。
2. 在 action 内各 dialog 路径前插入 non-interactive 分支：

```typescript
// 无参数路径（原返回 dialog: 'model'）
if (!args.trim()) {
  if (context.executionMode !== 'interactive') {
    const currentModel = config.getModel() ?? 'unknown';
    return {
      type: 'message',
      messageType: 'info',
      content: `Current model: ${currentModel}\nUse "/model <model-id>" to switch models.`,
    };
  }
  return { type: 'dialog', dialog: 'model' };
}

// --fast 无参数路径（原返回 dialog: 'fast-model'）
if (args.startsWith('--fast') && !modelName) {
  if (context.executionMode !== 'interactive') {
    const fastModel = context.services.settings?.merged?.fastModel ?? 'not set';
    return {
      type: 'message',
      messageType: 'info',
      content: `Current fast model: ${fastModel}\nUse "/model --fast <model-id>" to set fast model.`,
    };
  }
  return { type: 'dialog', dialog: 'fast-model' };
}
```

**ACP 语义**：IDE 展示当前模型名称，供用户参考；切换模型通过带参数调用实现（`/model <model-id>`）。

> **注意**：`/model <model-id>`（不带 `--fast`）目前没有实现设置当前 session 模型的逻辑，只有 `--fast <model-id>` 有。如果 Phase 2 要支持 ACP 下切换主模型，需要同步实现 `/model <model-id>` 的 set 逻辑。本设计预留此路径但标记为 Phase 2 可选项，优先保证"查看当前模型"的 read-only 路径。

### 6.2 `/approval-mode`

**当前状态**：

| 输入                       | 当前行为                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `/approval-mode`（无参数） | → `{ type: 'dialog', dialog: 'approval-mode' }`（non-interactive 下变 unsupported） |
| `/approval-mode <mode>`    | → `MessageActionReturn` ✅                                                          |
| `/approval-mode <invalid>` | → `MessageActionReturn`（error）✅                                                  |

**变更**：

1. 将 `supportedModes` 改为 `['interactive', 'non_interactive', 'acp']`。
2. 在无参数路径（`!args.trim()`）插入 non-interactive 分支：

```typescript
if (!args.trim()) {
  if (context.executionMode !== 'interactive') {
    const currentMode = config?.getApprovalMode() ?? 'unknown';
    return {
      type: 'message',
      messageType: 'info',
      content: `Current approval mode: ${currentMode}\nAvailable modes: ${APPROVAL_MODES.join(', ')}\nUse "/approval-mode <mode>" to change.`,
    };
  }
  return { type: 'dialog', dialog: 'approval-mode' };
}
```

---

## 7. B 类：需要完整 non-interactive 分支

这五个命令的 action 在 interactive 模式下通过 `context.ui.addItem()` 渲染 React 组件或调用 `context.ui.clear()`，返回值为 `void`。在 non-interactive 中，这些调用均为 no-op，导致 `handleSlashCommand` 将无返回值处理为 `"Command executed successfully."`，无实际内容输出。

**实现原则**：在 action **顶部**检查 `executionMode`，非 interactive 时 **提前 return** 包含实际内容的 `message`，interactive 路径代码完全不触碰。

### 7.1 `/about`（altName: `status`）

**数据来源**：`getExtendedSystemInfo(context)` 返回 `ExtendedSystemInfo`，包含：`cliVersion`、`osPlatform`、`osArch`、`osRelease`、`nodeVersion`、`modelVersion`、`selectedAuthType`、`ideClient`、`sessionId`、`memoryUsage`、`baseUrl`、`apiKeyEnvKey`、`gitCommit`、`fastModel`。所有字段在 non-interactive 中均可获取（context.services.config 和 settings 均已注入）。

**变更**：

1. 将 `supportedModes` 改为 `['interactive', 'non_interactive', 'acp']`。
2. 在 `getExtendedSystemInfo` 调用后，interactive 路径之前插入模式分支：

```typescript
action: async (context) => {
  const systemInfo = await getExtendedSystemInfo(context);

  if (context.executionMode !== 'interactive') {
    const lines = [
      `Qwen Code v${systemInfo.cliVersion}`,
      `Model: ${systemInfo.modelVersion}`,
      `Fast Model: ${systemInfo.fastModel ?? 'not set'}`,
      `Auth: ${systemInfo.selectedAuthType}`,
      `Platform: ${systemInfo.osPlatform} ${systemInfo.osArch} (${systemInfo.osRelease})`,
      `Node.js: ${systemInfo.nodeVersion}`,
      `Session: ${systemInfo.sessionId}`,
      ...(systemInfo.gitCommit ? [`Git commit: ${systemInfo.gitCommit}`] : []),
      ...(systemInfo.ideClient ? [`IDE: ${systemInfo.ideClient}`] : []),
    ];
    return {
      type: 'message',
      messageType: 'info',
      content: lines.join('\n'),
    };
  }

  // interactive 路径：原有 addItem 逻辑不变
  const aboutItem: Omit<HistoryItemAbout, 'id'> = { type: MessageType.ABOUT, systemInfo };
  context.ui.addItem(aboutItem, Date.now());
},
```

### 7.2 `/stats`（及子命令 `model`、`tools`）

**数据来源**：`context.session.stats`（`SessionStatsState`）包含 `sessionStartTime`、`metrics`（`SessionMetrics`：`models`、`tools`、`files`）、`promptCount`。在 non-interactive 中，`sessionStartTime` 为当前调用时刻，`metrics` 来自 `uiTelemetryService.getMetrics()`（本次调用的累积值，通常为零），`promptCount` 为 1。

**变更**：

1. 将父命令 `stats` 及子命令 `model`、`tools` 的 `supportedModes` 改为 `['interactive', 'non_interactive', 'acp']`。
2. 父命令和每个子命令的 action 均插入模式分支，提前返回文本格式统计：

```typescript
// /stats 主命令
action: (context) => {
  if (context.executionMode !== 'interactive') {
    const now = new Date();
    const { sessionStartTime, promptCount, metrics } = context.session.stats;
    if (!sessionStartTime) {
      return { type: 'message', messageType: 'error', content: 'Session start time unavailable.' };
    }
    const wallDuration = now.getTime() - sessionStartTime.getTime();

    // 汇总所有 model 的 token 数
    let totalPromptTokens = 0, totalCandidateTokens = 0, totalRequests = 0;
    for (const modelMetrics of Object.values(metrics.models)) {
      totalPromptTokens += modelMetrics.tokens.prompt;
      totalCandidateTokens += modelMetrics.tokens.candidates;
      totalRequests += modelMetrics.api.totalRequests;
    }

    const lines = [
      `Session duration: ${formatDuration(wallDuration)}`,
      `Prompts: ${promptCount}`,
      `API requests: ${totalRequests}`,
      `Tokens — prompt: ${totalPromptTokens}, output: ${totalCandidateTokens}`,
      `Tool calls: ${metrics.tools.totalCalls} (${metrics.tools.totalSuccess} ok, ${metrics.tools.totalFail} fail)`,
      `Files: +${metrics.files.totalLinesAdded} / -${metrics.files.totalLinesRemoved} lines`,
    ];
    return { type: 'message', messageType: 'info', content: lines.join('\n') };
  }

  // interactive 路径：原有 addItem 逻辑不变
  const statsItem: HistoryItemStats = { type: MessageType.STATS, duration: formatDuration(wallDuration) };
  context.ui.addItem(statsItem, Date.now());
},
```

子命令 `model` 和 `tools` 也各自插入模式分支，返回对应维度的文本统计（model 维度按 model name 列出 token 用量；tools 维度列出各 tool 调用次数）。

**说明**：在 non-interactive 单次调用中，metrics 通常为零（新 session），但结构完整，不影响格式。ACP Session 中可能有累积值，有实际意义。

### 7.3 `/insight`

**当前状态**：action 返回 `void`，通过 `addItem` 展示进度和结果，最后调用 `open(outputPath)` 打开浏览器。核心逻辑是 `insightGenerator.generateStaticInsight()` 生成 HTML 文件。

**变更**：

1. 将 `supportedModes` 改为 `['interactive', 'non_interactive', 'acp']`。
2. 按 `executionMode` 三路分叉：
   - `non_interactive`：同步生成，忽略进度回调，不开浏览器，直接返回 `message`（文件路径）
   - `acp`：异步启动生成，通过 `stream_messages` 将进度（`encodeInsightProgressMessage`）和完成（`encodeInsightReadyMessage`）推送给 IDE
   - `interactive`：原有 `addItem` + `setPendingItem` + `open()` 逻辑不变

```typescript
// non_interactive 路径
if (context.executionMode === 'non_interactive') {
  const outputPath = await insightGenerator.generateStaticInsight(
    projectsDir,
    () => {}, // no-op progress
  );
  return {
    type: 'message',
    messageType: 'info',
    content: t('Insight report generated at: {{path}}', { path: outputPath }),
  };
}

// acp 路径：stream_messages
if (context.executionMode === 'acp') {
  // ... 构造 streamMessages async generator，yield encodeInsightProgressMessage / encodeInsightReadyMessage ...
  return { type: 'stream_messages', messages: streamMessages() };
}

// interactive 路径：原有实现不变
```

**设计理由**：`non_interactive` 模式（CLI 管道）不支持 `stream_messages`，只能返回单条 `message`；ACP 模式（IDE 插件）能消费 `stream_messages` 并实时展示进度，因此为其保留 streaming 路径。

**ACP 消息格式**：`encodeInsightProgressMessage(stage, progress, detail?)` 产生 IDE 可解析的进度条消息；`encodeInsightReadyMessage(outputPath)` 通知 IDE 文件已就绪，由 IDE 决定如何展示链接。

### 7.4 `/docs`

**当前状态**：action 返回 `void`，通过 `addItem` 显示消息并调用 `open(docsUrl)` 打开浏览器。有一个 `SANDBOX` 环境变量分支（沙盒下只 addItem，不开浏览器）。

**变更**：

1. 将 `supportedModes` 改为 `['interactive', 'non_interactive', 'acp']`。
2. 修改 action 返回类型为 `Promise<void | MessageActionReturn>`。
3. 在 action 开头插入 non-interactive 分支：

```typescript
action: async (context) => {
  const langPath = getCurrentLanguage()?.startsWith('zh') ? 'zh' : 'en';
  const docsUrl = `https://qwenlm.github.io/qwen-code-docs/${langPath}`;

  if (context.executionMode !== 'interactive') {
    // 非交互/ACP：直接返回 URL，不打开浏览器，不调用 addItem
    return {
      type: 'message',
      messageType: 'info',
      content: `Qwen Code documentation: ${docsUrl}`,
    };
  }

  // interactive 路径：原有 SANDBOX 判断 + addItem + open() 不变
  if (process.env['SANDBOX'] && ...) {
    context.ui.addItem(...);
  } else {
    context.ui.addItem(...);
    await open(docsUrl);
  }
},
```

### 7.5 `/clear`（altNames: `reset`、`new`）

**当前状态**：action 执行以下操作并返回 `void`：

1. `config.getHookSystem()?.fireSessionEndEvent()` — 触发 hook（有副作用）
2. `config.startNewSession()` — 开始新 session ID（有副作用）
3. `uiTelemetryService.reset()` — 重置 telemetry 计数器（有副作用）
4. `skillTool.clearLoadedSkills()` — 清除 skill 缓存（有副作用）
5. `context.ui.clear()` — 清空终端 UI（**UI 副作用，non-interactive 下为 no-op**）
6. `geminiClient.resetChat()` — 重置 chat 历史（有副作用）
7. `config.getHookSystem()?.fireSessionStartEvent()` — 触发 hook（有副作用）

**non-interactive/ACP 语义分析**：

- `ui.clear()` 在 non-interactive 中已是 no-op，不需要处理
- `geminiClient.resetChat()`：在 ACP Session 中是有意义的副作用（清空 chat 历史），应保留；在 non-interactive 单次调用中，每次调用都是全新 session，`resetChat` 语义重复但无害
- `config.startNewSession()`：在 ACP 中有意义（开始新的 session ID）；在 non-interactive 单次调用中同样语义重复但无害
- `fireSessionEndEvent` / `fireSessionStartEvent`：在 ACP 中有意义（触发 hook）

**决策**：non-interactive/ACP 路径保留所有有意义的副作用（resetChat、startNewSession、hook events），仅跳过 `ui.clear()`（已是 no-op）并返回上下文边界标记 message。

**变更**：

1. 将 `supportedModes` 改为 `['interactive', 'non_interactive', 'acp']`。
2. 修改 action 返回类型为 `Promise<void | MessageActionReturn>`。
3. 在 action 内，`context.ui.clear()` 调用后（或替代它）根据模式分支：

```typescript
action: async (context, _args) => {
  const { config } = context.services;

  if (config) {
    config.getHookSystem()?.fireSessionEndEvent(SessionEndReason.Clear).catch(...);

    const newSessionId = config.startNewSession();
    uiTelemetryService.reset();

    const skillTool = config.getToolRegistry()?.getAllTools().find(...);
    if (skillTool instanceof SkillTool) skillTool.clearLoadedSkills();

    if (newSessionId && context.session.startNewSession) {
      context.session.startNewSession(newSessionId);
    }

    // ui.clear() 在非交互下已是 no-op，但依然调用（不需要条件分支）
    context.ui.clear();

    const geminiClient = config.getGeminiClient();
    if (geminiClient) {
      await geminiClient.resetChat();
    }

    config.getHookSystem()?.fireSessionStartEvent(...).catch(...);
  } else {
    context.ui.clear();
  }

  // 根据模式决定返回值
  if (context.executionMode !== 'interactive') {
    return {
      type: 'message',
      messageType: 'info',
      content: 'Context cleared. Previous messages are no longer in context.',
    };
  }
  // interactive 路径：void（不返回，React UI 由 ui.clear() 驱动更新）
},
```

**ACP 语义**：IDE 收到上下文边界标记后，可将其作为 session 分隔符展示（如"新会话开始"提示），并清空本地 chat 历史缓存。

---

## 8. `handleCommandResult` 变更

**结论：无需修改。**

Phase 2 所有命令变更后，non-interactive/ACP 路径的返回类型均为 `message` 或 `submit_prompt`，均已在 `handleCommandResult` 的 switch 中正确处理。

---

## 9. `createNonInteractiveUI()` 变更

**结论：无需修改。**

当前 no-op 实现已足够。`addItem`、`clear`、`setPendingItem` 等 no-op 在 B 类命令的 non-interactive 路径中不会被调用（因为提前 return）；interactive 路径中不受影响。

---

## 10. Phase 2.2：prompt command 模型调用打通

Phase 1 中 `CommandService.getModelInvocableCommands()` 已实现，`BundledSkillLoader`、`FileCommandLoader`（用户/项目命令）、`McpPromptLoader` 已设置 `modelInvocable: true`。

Phase 2.2 的工作是将 `SkillTool` 从只消费 `SkillManager.listSkills()` 改为同时消费 `CommandService.getModelInvocableCommands()`，统一模型可调用命令的入口。

**变更文件**：`packages/core/src/tools/SkillTool.ts`（或对应路径）

**具体变更**：

1. `SkillTool` 在初始化时接收 `CommandService`（或其 `getModelInvocableCommands()` 的结果）作为依赖注入
2. 在构建 tool description 时，合并 `listSkills()` 和 `getModelInvocableCommands()` 的结果
3. 确保 built-in commands（`modelInvocable: false`）不出现在 tool description 中

> **注**：`SkillTool` 的具体实现依赖 `packages/core` 内部架构，详细设计在本文档中仅描述接口变更，实现细节需结合 core 包的现有结构确定。

---

## 11. Phase 2.3：mid-input slash command 检测（基础版）

在 `InputPrompt` 组件中检测光标附近的 slash token（不限于行首），触发补全菜单。

**检测规则**：

- 当光标前存在以 `/` 开头、不含空格的 token 时，触发命令补全
- 补全候选来自 `getCommandsForMode('interactive')` 的可见命令列表
- 补全菜单展示命令名 + description（不含 argumentHint 等，Phase 3 补充）

> 本功能为 UI 层变更，属于 Phase 2.3 独立子任务，不影响其他 Phase 2.1/2.2 的实施。

---

## 12. 文件变更总览

### 12.1 命令文件变更（Phase 2.1）

| 文件                     | 变更类型 | 具体内容                                                                                                                             |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `exportCommand.ts`       | A 类     | 父命令 + 4 个子命令：`supportedModes` → all modes                                                                                    |
| `planCommand.ts`         | A 类     | `supportedModes` → all modes                                                                                                         |
| `statuslineCommand.ts`   | A 类     | `supportedModes` → all modes                                                                                                         |
| `languageCommand.ts`     | A+ 类    | 父命令 + `ui`/`output` 子命令 + 动态 language 子命令：`supportedModes` → all modes                                                   |
| `copyCommand.ts`         | A+ 类    | `supportedModes` → all modes + 非交互分支返回内容本身                                                                                |
| `restoreCommand.ts`      | A+ 类    | `supportedModes` → all modes + 有参数路径新增非交互分支（返回 message 代替 type: 'tool'）                                            |
| `modelCommand.ts`        | A' 类    | `supportedModes` → all modes + 无参数/无 fast model 路径新增非交互分支                                                               |
| `approvalModeCommand.ts` | A' 类    | `supportedModes` → all modes + 无参数路径新增非交互分支                                                                              |
| `aboutCommand.ts`        | B 类     | `supportedModes` → all modes + 非交互路径返回 `message`（版本/模型/环境摘要）                                                        |
| `statsCommand.ts`        | B 类     | `supportedModes` → all modes + 非交互路径返回 `message`（stats 文本）；子命令同步处理                                                |
| `insightCommand.ts`      | B 类     | `supportedModes` → all modes + `non_interactive` 路径同步生成返回 `message`（文件路径）；`acp` 路径返回 `stream_messages` 带进度推送 |
| `docsCommand.ts`         | B 类     | `supportedModes` → all modes + 非交互路径返回 `message`（文档 URL），不打开浏览器                                                    |
| `clearCommand.ts`        | B 类     | `supportedModes` → all modes + action 末尾根据模式返回 `message` 或 `void`                                                           |

### 12.2 其他文件变更

| 文件                                                | 变更内容                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/core/src/tools/SkillTool.ts`              | Phase 2.2：接入 `getModelInvocableCommands()`（详细设计另行确定） |
| `packages/cli/src/ui/InputPrompt.tsx`（或同等组件） | Phase 2.3：mid-input slash 检测逻辑                               |

### 12.3 不变的文件

- `packages/cli/src/nonInteractiveCliCommands.ts`（`handleCommandResult`、`handleSlashCommand` 无需修改）
- `packages/cli/src/ui/noninteractive/nonInteractiveUi.ts`（stub UI 无需修改）
- `packages/cli/src/services/commandUtils.ts`（`filterCommandsForMode`、`getEffectiveSupportedModes` 无需修改）
- `packages/cli/src/services/CommandService.ts`（`getCommandsForMode`、`getModelInvocableCommands` 已在 Phase 1 实现）

---

## 13. 测试策略

### 13.1 命令单元测试

为每个变更的命令在同目录下新增或更新测试文件（`*.test.ts`），覆盖以下 case：

**A/A+ 类命令**（`export`、`plan`、`statusline`、`language`、`copy`、`restore`）：

- `supportedModes` 正确包含 `non_interactive` 和 `acp`
- 在 `executionMode: 'non_interactive'` 下，action 返回 `MessageActionReturn` 或 `SubmitPromptActionReturn`，不调用 `ui.addItem` 或 `ui.clear`
- Interactive 路径行为与重构前完全一致（快照测试）

**A' 类命令**（`model`、`approval-mode`）：

- 无参数 + `executionMode: 'non_interactive'` → 返回当前状态 `message`，不返回 `dialog`
- 有参数 + `executionMode: 'non_interactive'` → 原有 `message` 逻辑正常执行
- Interactive 路径：无参数 → `dialog`，有参数 → `message`（不变）

**B 类命令**（`about`、`stats`、`insight`、`docs`、`clear`）：

- `executionMode: 'non_interactive'` 下，action 返回 `MessageActionReturn`，不调用任何 `ui.*` 方法
- 返回的 `content` 字符串包含预期的关键字段（版本号、模型名、URL 等）
- Interactive 路径：`ui.addItem` 被调用，`action` 返回 `void`（不变）

**`copy` 的特殊 case**：

- ACP 下，当 gemini client 有历史时，返回最后 AI 消息的内容本身
- ACP 下，当无历史时，返回 `info` 消息

**`restore` 的特殊 case**：

- 有参数 + `executionMode: 'non_interactive'` → 返回确认 `message`，不返回 `type: 'tool'`
- 无参数 + `executionMode: 'non_interactive'` → 返回 checkpoint 列表 `message`（原逻辑，验证仍工作）

**`clear` 的特殊 case**：

- `executionMode: 'non_interactive'` 下，`geminiClient.resetChat()` 仍被调用（副作用保留）
- 返回上下文边界 `message`，内容为 `'Context cleared. Previous messages are no longer in context.'`

### 13.2 集成测试（`handleSlashCommand`）

在 `nonInteractiveCli.test.ts` 或新建的集成测试文件中：

- `handleSlashCommand('/about', ...)` 在 non-interactive 模式下返回 `{ type: 'message', content: 包含版本号 }`
- `handleSlashCommand('/stats', ...)` 在 non-interactive 模式下返回 `{ type: 'message', content: 包含 'Session duration' }`
- `handleSlashCommand('/docs', ...)` 在 non-interactive 模式下返回 `{ type: 'message', content: 包含 'qwenlm.github.io' }`
- `handleSlashCommand('/clear', ...)` 在 non-interactive 模式下返回 `{ type: 'message', content: 'Context cleared.' }`
- `handleSlashCommand('/plan', ...)` 在 non-interactive 模式下返回 `{ type: 'message' }` 或 `{ type: 'submit_prompt' }`
- 现有 non-interactive 命令（`btw`、`bug` 等）行为无退化

### 13.3 `commandUtils` 测试

`commandUtils.test.ts` 中新增（或已有的测试继续覆盖）：

- 扩展后的 13 个命令均能通过 `filterCommandsForMode(commands, 'non_interactive')` 和 `filterCommandsForMode(commands, 'acp')` 的过滤

---

## 14. 行为影响分析

| 场景                                         | Phase 2 前行为                                            | Phase 2 后行为                                 | 性质                   |
| -------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------- | ---------------------- |
| non-interactive 下执行 `/export md`          | ❌ unsupported（被过滤）                                  | ✅ 返回文件路径 message                        | 能力扩展               |
| non-interactive 下执行 `/plan <task>`        | ❌ unsupported                                            | ✅ 提交 prompt 或返回 plan mode 确认           | 能力扩展               |
| non-interactive 下执行 `/statusline`         | ❌ unsupported                                            | ✅ 提交 statusline 设置 prompt                 | 能力扩展               |
| non-interactive 下执行 `/language ui zh-CN`  | ❌ unsupported                                            | ✅ 设置语言，返回确认 message                  | 能力扩展               |
| non-interactive 下执行 `/copy`               | ❌ unsupported                                            | ✅ 返回最后 AI 输出文本                        | 能力扩展               |
| non-interactive 下执行 `/restore`（无参数）  | ❌ unsupported                                            | ✅ 返回可用 checkpoint 列表                    | 能力扩展               |
| non-interactive 下执行 `/restore <id>`       | ❌ unsupported                                            | ✅ 恢复状态，返回确认 message（不重执行 tool） | 能力扩展（有语义差异） |
| non-interactive 下执行 `/model`              | ❌ unsupported（dialog）                                  | ✅ 返回当前模型名称                            | 能力扩展               |
| non-interactive 下执行 `/model <id>`         | ❌ unsupported                                            | 🔄 Phase 2 可选：实现切换逻辑                  | 能力扩展（可选）       |
| non-interactive 下执行 `/approval-mode`      | ❌ unsupported（dialog）                                  | ✅ 返回当前审批模式                            | 能力扩展               |
| non-interactive 下执行 `/approval-mode yolo` | ❌ unsupported                                            | ✅ 设置模式，返回确认                          | 能力扩展               |
| non-interactive 下执行 `/about`              | ❌ 返回 "Command executed successfully."（addItem no-op） | ✅ 返回版本/模型/环境摘要                      | Bug fix + 能力扩展     |
| non-interactive 下执行 `/stats`              | ❌ 返回 "Command executed successfully."                  | ✅ 返回 session 统计文本                       | Bug fix + 能力扩展     |
| non-interactive 下执行 `/insight`            | ❌ 返回 "Command executed successfully."（生成但无输出）  | ✅ 生成并返回文件路径                          | Bug fix + 能力扩展     |
| non-interactive 下执行 `/docs`               | ❌ 返回 "Command executed successfully."                  | ✅ 返回文档 URL                                | Bug fix + 能力扩展     |
| non-interactive 下执行 `/clear`              | ❌ 返回 "Command executed successfully."                  | ✅ 返回上下文边界 message                      | Bug fix + 能力扩展     |
| interactive 下执行任意以上命令               | ✅ 原有行为                                               | ✅ 原有行为（零退化）                          | 不变                   |

---

## 15. 实施顺序

建议按以下顺序实施，每组可独立 commit 和 review：

**Batch 1**（~30min）：A 类 — 只改 `supportedModes`

修改 `exportCommand.ts`、`planCommand.ts`、`statuslineCommand.ts`（及其子命令），验证测试通过。

**Batch 2**（~45min）：A+ 类 — 少量分支

修改 `languageCommand.ts`、`copyCommand.ts`、`restoreCommand.ts`，为有副作用的路径添加非交互分支，更新对应测试。

**Batch 3**（~45min）：A' 类 — dialog 路径

修改 `modelCommand.ts`、`approvalModeCommand.ts`，为无参数路径添加非交互分支，更新对应测试。

**Batch 4**（~1.5h）：B 类 — 完整分支

修改 `aboutCommand.ts`、`statsCommand.ts`（含子命令）、`docsCommand.ts`。

**Batch 5**（~1h）：B 类特殊 — `insightCommand.ts`、`clearCommand.ts`

这两个命令副作用较多，单独一个 commit，更新对应测试和集成测试。

**Batch 6**（~2h）：Phase 2.2 — prompt command 模型调用打通

修改 `SkillTool`，接入 `getModelInvocableCommands()`，更新 SkillTool 测试。

**Batch 7**（~2h）：Phase 2.3 — mid-input slash 检测

修改 `InputPrompt` 组件，新增补全触发逻辑和 UI 测试。

**Batch 8**（~30min）：全量测试 + 类型检查

运行 `npm run typecheck`、`cd packages/cli && npx vitest run`，修复剩余问题。

---

## 16. 验收 Checklist

**Phase 2.1 命令扩展**

- [ ] A 类：`/export`（及子命令）、`/plan`、`/statusline` 在 non-interactive 和 acp 模式下可正常执行并返回有意义输出
- [ ] A+ 类：`/language`（及子命令）在 non-interactive 下正常执行，设置持久化
- [ ] A+ 类：`/copy` 在 non-interactive/acp 下返回最后 AI 输出文本（不操作剪贴板）
- [ ] A+ 类：`/restore` 无参数时在 non-interactive 下返回 checkpoint 列表；有参数时恢复状态并返回确认 message（不返回 `type: 'tool'`）
- [ ] A' 类：`/model` 无参数时在 non-interactive/acp 下返回当前模型名（不触发 dialog）；`/model --fast <id>` 正常设置
- [ ] A' 类：`/approval-mode` 无参数时在 non-interactive/acp 下返回当前模式（不触发 dialog）；有参数时正常设置
- [ ] B 类：`/about` 在 non-interactive/acp 下返回包含版本号、模型名的纯文本摘要
- [ ] B 类：`/stats`（含子命令）在 non-interactive/acp 下返回纯文本统计数据
- [ ] B 类：`/insight` 在 non-interactive/acp 下生成 insight 文件并返回文件路径（不打开浏览器）
- [ ] B 类：`/docs` 在 non-interactive/acp 下返回文档 URL（不打开浏览器）
- [ ] B 类：`/clear` 在 non-interactive/acp 下返回上下文边界标记 message，`geminiClient.resetChat()` 正常执行
- [ ] 所有 13 个命令在 interactive 模式下行为与重构前完全一致（无退化）
- [ ] TypeScript 编译无错误（`npm run typecheck`）
- [ ] `npm run lint` 无新增错误
- [ ] 所有现有测试通过（`cd packages/cli && npx vitest run`）

**Phase 2.2 模型调用**

- [ ] 模型在对话中可以通过 `SkillTool` 调用 bundled skill、file command（用户/项目）、MCP prompt
- [ ] 模型不可以调用 built-in commands
- [ ] `SkillTool` 的 tool description 包含所有 `modelInvocable: true` 命令的名称和 description

**Phase 2.3 mid-input slash**

- [ ] 在输入框正文中输入 `/` 后触发命令补全菜单（不限行首）
- [ ] 补全菜单展示命令名 + description
- [ ] 补全选中后正确填充到输入框
