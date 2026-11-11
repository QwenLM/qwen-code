/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话链自己的 slash command 处理：`/plan` 等命令交给 `handleSlashCommand`，未解析的
 * 命令按纯文本交给模型并附模型可见说明。准入策略与命令目录共享
 * `utils/bridgeCommandUtils.ts` 与 `CommandService`——那是 SDK 可见的 wire 契约，不复刻。
 */

import {
  runLogger,
  type Config,
  type QueryEngineSlashCommandHandler,
  createChildAbortController,
  createUserMessage,
  partListUnionToString,
  pickQueryOverrides,
} from '@qwen-code/core';
import type { CommandService } from '../../../services/CommandService.js';
import {
  BRIDGE_SAFE_BUILTIN_COMMANDS,
  buildBridgeBlockedDecision,
  getBridgeCommandType,
} from '../../../utils/bridgeCommandUtils.js';
import { parseSlashCommand } from '../../../utils/commands.js';
import { CommandKind } from '../../../ui/commands/types.js';
import {
  createNonInteractiveCommandService,
  handleSlashCommand,
} from '../../../nonInteractiveCliCommands.js';
import { buildSlashCommandMetadataFromRawInvocation } from '../../../utils/slashCommandMetadata.js';
import type { LoadedSettings as CliLoadedSettings } from '../../../config/settings.js';

const FALLBACK_COMMAND_NAME_CAP = 40;

/**
 * 未解析 slash 命令时附带的模型可见说明：原始输入照常作为一轮交给模型，这段说明
 * 阻止它假装命令已执行，并给出本会话真正可用的命令列表。
 */
function buildUnknownCommandFallbackPrompt(fallback: {
  commandName: string;
  suggestion?: string;
  availableCommandNames: readonly string[];
  availableCommandCount: number;
}): string {
  const names = fallback.availableCommandNames.slice(
    0,
    FALLBACK_COMMAND_NAME_CAP,
  );
  const unnamed = Math.max(0, fallback.availableCommandCount - names.length);
  const availability =
    names.length === 0
      ? unnamed > 0
        ? `This session has ${unnamed} slash ${unnamed === 1 ? 'command' : 'commands'}, but none can be named here.`
        : 'No slash commands are available in this session.'
      : `Slash commands available in this session: ${names
          .map((name) => `/${name}`)
          .join(', ')}${unnamed > 0 ? `, and ${unnamed} more` : ''}.`;
  return [
    `The user's message starts with the slash command /${fallback.commandName}, but no command with that name is available in this session, so it did not run.`,
    fallback.suggestion
      ? `The closest available command is /${fallback.suggestion}. Ask the user before running it.`
      : undefined,
    availability,
    'Treat the message as a plain request and do the task with the tools you have. If the task needs that command, tell the user it is not installed in this session. The user can add it as an organization plugin or a project skill. Do not give installation steps you are not sure of. Do not say the command ran.',
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');
}

/**
 * 解析 `/compact`、`/compress`、`/summarize`，命中返回解析结果，否则 `null`。
 * 真正的拦截点在 `ThreadSession.runTurn`，正常情况下这个 handler 见不到 `/compact`。
 */
export function parseCompactInvocation(
  input: string,
): { customInstructions?: string } | null {
  const match = input
    .trim()
    .match(/^\/(?:compact|compress|summarize)(?:\s+(.*))?$/s);
  if (!match) {
    return null;
  }
  const customInstructions = match[1]?.trim();
  return {
    ...(customInstructions ? { customInstructions } : {}),
  };
}

/**
 * 会话的 slash command handler。`settings` 收 thread-manager 自持镜像的
 * `LoadedSettings`，与 cli 名义类型结构相同、名义不同。
 */
export function createSessionSlashHandler(
  config: Config,
  settings: unknown,
): QueryEngineSlashCommandHandler {
  return async (
    input,
    _precedingInputBlocks,
    _imageContentBlocks,
    _attachments,
    context,
  ) => {
    if (parseCompactInvocation(input)) {
      return false;
    }

    const { controller, cleanup } = createChildAbortController(context.signal);
    try {
      const slashCommandResult = await handleSlashCommand(
        input,
        controller,
        config,
        settings as CliLoadedSettings,
      );
      if (!slashCommandResult) {
        return false;
      }
      // 输入正文与展开后的 prompt 刻意不打：只记命令处理结果的类型。
      runLogger.log('[thread-session] slash command handled', {
        sessionId: config.getSessionId?.(),
        resultType: slashCommandResult.type,
      });
      if (slashCommandResult.type === 'direct_output') {
        return {
          messages: [],
          shouldQuery: false,
          resultText: slashCommandResult.resultText,
          resultIsError: slashCommandResult.isError,
        };
      }
      // 命令形状但没解析到命令：原始输入照常交给模型，另附一条 isMeta 模型可见说明，
      // 告诉它命令没跑、本会话可用的命令有哪些；此后字段才收窄为 'query' 形状。
      if (slashCommandResult.type === 'unknown_command_fallback') {
        const permissionMode = config.getPermissionMode();
        return {
          messages: [
            createUserMessage(input, {
              uuid: context.userMessageUuid,
              origin: { kind: 'human' },
              permissionMode,
            }),
            createUserMessage(
              buildUnknownCommandFallbackPrompt(slashCommandResult),
              { isMeta: true, permissionMode },
            ),
          ],
          shouldQuery: true,
          attachmentInput: input,
        };
      }
      const permissionMode = config.getPermissionMode();
      const commandMetadata = buildSlashCommandMetadataFromRawInvocation(input);
      if (commandMetadata === null) {
        throw new Error('Expected a slash-command invocation.');
      }
      const expandedPrompt = partListUnionToString(slashCommandResult.content);
      return {
        messages: [
          createUserMessage(commandMetadata, {
            uuid: context.userMessageUuid,
            origin: { kind: 'human' },
            permissionMode,
          }),
          createUserMessage(expandedPrompt, {
            isMeta: slashCommandResult.isMeta,
            origin: { kind: 'human' },
            permissionMode,
          }),
        ],
        shouldQuery: true,
        commandInvocationId: slashCommandResult.commandInvocationId,
        attachmentInput: expandedPrompt,
        ...pickQueryOverrides(slashCommandResult),
      };
    } finally {
      cleanup();
    }
  };
}

export type SessionBridgeSlashDecision =
  | { allow: true }
  | { allow: false; message: string };

/**
 * 会话级的 bridge 准入判定。**CommandService 按会话缓存**并用会话的 `AbortSignal`：
 * 常驻会话里每条消息新建 service 会重复付命令发现开销；准入策略复用共享的 wire 文案。
 * 缓存不跨 `invalidate()`：命令面随插件/skill 重载变化，必须重建。
 */
export class SessionBridgeSlashDecider {
  private servicePromise: Promise<CommandService> | null = null;

  constructor(
    private readonly config: Config,
    private readonly signal: AbortSignal,
  ) {}

  private service(): Promise<CommandService> {
    if (!this.servicePromise) {
      this.servicePromise = createNonInteractiveCommandService(
        this.config,
        this.signal,
      );
    }
    return this.servicePromise;
  }

  /** 命令面变了（插件/skill 重载）之后调用，下一次判定会重建 service。 */
  invalidate(): void {
    this.servicePromise = null;
  }

  async decide(rawQuery: string): Promise<SessionBridgeSlashDecision | null> {
    const service = await this.service();
    const { commandToExecute, args } = parseSlashCommand(
      rawQuery,
      service.getCommands(),
    );
    if (!commandToExecute) {
      return null;
    }
    const bridgeCommandType = getBridgeCommandType(
      commandToExecute,
      args,
      rawQuery,
    );
    // rawQuery / args 正文刻意不打：只记命令名与准入结果。
    const logDecision = (
      decision: SessionBridgeSlashDecision,
    ): SessionBridgeSlashDecision => {
      runLogger.log('[thread-session] bridge slash decision', {
        sessionId: this.config.getSessionId?.(),
        command: commandToExecute.name,
        commandType: bridgeCommandType,
        allowed: decision.allow,
      });
      return decision;
    };
    if (bridgeCommandType === 'prompt') {
      return logDecision({ allow: true });
    }
    if (bridgeCommandType === 'local-jsx') {
      return logDecision(buildBridgeBlockedDecision(commandToExecute.name));
    }
    if (bridgeCommandType === 'local') {
      return logDecision(
        BRIDGE_SAFE_BUILTIN_COMMANDS.has(commandToExecute.name)
          ? { allow: true }
          : buildBridgeBlockedDecision(commandToExecute.name),
      );
    }

    if (commandToExecute.kind !== CommandKind.BUILT_IN) {
      return logDecision({ allow: true });
    }
    if (BRIDGE_SAFE_BUILTIN_COMMANDS.has(commandToExecute.name)) {
      return logDecision({ allow: true });
    }
    return logDecision(buildBridgeBlockedDecision(commandToExecute.name));
  }
}
