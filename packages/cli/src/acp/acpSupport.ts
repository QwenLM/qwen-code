/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ACP 协议侧的纯投影与产品映射：wire 形状的权限选项/内容、模式与模型视图、
 * 登录方式与认证隔离。会话生命周期不在这里——那归 ThreadManager。
 */

import type * as acp from '@agentclientprotocol/sdk';
import {
  BRAND_PROTOCOL_NAMESPACE,
  ASK_USER_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  PermissionModes,
  ToolConfirmationOutcome,
  runLogger,
  type Config,
  type SerializableConfirmationDetails,
} from '@qwen-code/core';
import { z } from 'zod';
import { safeHostname } from '../ui/utils/urlSecurityUtils.js';
import type { AcpSupportedCommand } from './commandAvailability.js';

export const RequestPermissionResponseSchema = z.object({
  outcome: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('cancelled') }),
    z.object({
      outcome: z.literal('selected'),
      optionId: z.string(),
    }),
  ]),
});

export type AskUserConfirmationDetails = Extract<
  SerializableConfirmationDetails,
  { type: typeof ASK_USER_TOOL_NAME }
>;

export interface AcpModelAdapter {
  buildAvailableModels(config: Config): Promise<{
    availableModels: Array<{
      modelId: string;
      name: string;
      description?: string;
    }>;
    currentModelId: string;
  }>;
  buildReasoningEffortOption?(
    config: Config,
  ): Promise<acp.SessionConfigOption | null>;
}

/** 默认视图：只暴露当前配置模型。 */
export function createDefaultAcpModelAdapter(): AcpModelAdapter {
  return {
    async buildAvailableModels(config) {
      const currentModelId = config.getModel() || 'auto';
      return {
        availableModels: [{ modelId: currentModelId, name: currentModelId }],
        currentModelId,
      };
    },
  };
}

export function supportsFormElicitation(
  clientCapabilities: acp.ClientCapabilities | undefined,
): boolean {
  const elicitation = clientCapabilities?.elicitation;
  if (!elicitation) return false;
  if (elicitation.form) return true;
  if (elicitation.form === null) return false;
  return !elicitation.url;
}

export function disableAskUserQuestionWithoutElicitation(
  config: Config,
  clientCapabilities: acp.ClientCapabilities | undefined,
): void {
  if (supportsFormElicitation(clientCapabilities)) {
    return;
  }
  const permission = config.permission;
  if (!permission) {
    runLogger.warn(
      '[acp] Unable to disable AskUserQuestion: no permission object is available.',
    );
    return;
  }
  permission.setRules(
    {
      allow: {},
      deny: { session: [ASK_USER_TOOL_NAME] },
      ask: {},
    },
    { merge: true },
  );
}

export function buildAskUserElicitationRequest(
  sessionId: string,
  toolCallId: string,
  details: AskUserConfirmationDetails,
): acp.CreateElicitationRequest {
  const properties: NonNullable<acp.ElicitationSchema['properties']> = {};
  const required: string[] = [];

  details.questions.forEach((question, index) => {
    const key = `q${index}`;
    required.push(key);
    const description = [
      question.question,
      ...question.options.map(
        (option) => `${option.label}: ${option.description}`,
      ),
    ].join('\n');

    properties[key] = question.multiSelect
      ? {
          type: 'array',
          title: question.header || question.question,
          description,
          minItems: 1,
          maxItems: question.options.length,
          items: {
            anyOf: question.options.map((option) => ({
              const: option.label,
              title: option.label,
            })),
          },
        }
      : {
          type: 'string',
          title: question.header || question.question,
          description,
          oneOf: question.options.map((option) => ({
            const: option.label,
            title: option.label,
          })),
        };
  });

  return {
    mode: 'form',
    sessionId,
    toolCallId,
    message: details.title || 'Answer questions',
    requestedSchema: {
      type: 'object',
      title: details.title,
      properties,
      required,
    },
    _meta: {
      [BRAND_PROTOCOL_NAMESPACE]: {
        toolName: ASK_USER_TOOL_NAME,
      },
    },
  };
}

export function buildAskUserPayloadFromElicitation(
  details: AskUserConfirmationDetails,
  response: acp.CreateElicitationResponse,
): { answers: Record<string, string> } | undefined {
  if (response.action !== 'accept') return undefined;

  const answers: Record<string, string> = {};
  const content = response.content ?? {};
  details.questions.forEach((question, index) => {
    const value = content[`q${index}`];
    if (Array.isArray(value)) {
      answers[question.question] = value.join(', ');
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      answers[question.question] = String(value);
    }
  });

  return { answers };
}

export function toLoadedSessionState(
  state: acp.NewSessionResponse,
): acp.LoadSessionResponse {
  const { sessionId: _sessionId, ...loadedState } = state;
  return loadedState;
}

export function formatCommandArgumentHint(
  hint: AcpSupportedCommand['argumentHint'],
): string | null {
  if (hint == null) {
    return null;
  }
  if (typeof hint === 'string') {
    return hint;
  }
  return hint.map((name) => `<${name}>`).join(' ');
}

export function toAcpAvailableCommand(
  command: AcpSupportedCommand,
): acp.AvailableCommand {
  const hint = formatCommandArgumentHint(command.argumentHint);
  return {
    name: command.name,
    description: command.description,
    ...(hint ? { input: { hint } } : {}),
  };
}

export function buildAvailableModes(): acp.SessionMode[] {
  return [
    {
      id: PermissionModes.Default,
      name: 'Default',
      description: 'Prompts for approval',
    },
    {
      id: PermissionModes.AcceptEdits,
      name: 'Accept Edits',
      description: 'Auto-approves edit tools',
    },
    {
      id: PermissionModes.Auto,
      name: 'Auto',
      description: 'Auto-approves via the safety classifier',
    },
    {
      id: PermissionModes.DontAsk,
      name: "Don't Ask",
      description: 'Refuses instead of prompting',
    },
    {
      id: PermissionModes.Yolo,
      name: 'Bypass Permissions',
      description: 'Auto-approves all tools',
    },
  ];
}

export function formatReasoningEffortName(effort: string): string {
  switch (effort) {
    case 'none':
      return 'None';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'xhigh':
      return 'Extra High';
    case 'max':
      return 'Max';
    default:
      return effort;
  }
}

export function flattenConfigOptionValues(
  option: acp.SessionConfigOption,
): acp.SessionConfigSelectOption[] {
  if (option.type !== 'select') {
    return [];
  }
  return option.options.flatMap((entry) =>
    'options' in entry ? entry.options : [entry],
  );
}

const basicPermissionOptions = [
  {
    optionId: ToolConfirmationOutcome.ProceedOnce,
    name: 'Allow',
    kind: 'allow_once',
  },
  {
    optionId: ToolConfirmationOutcome.Cancel,
    name: 'Reject',
    kind: 'reject_once',
  },
] as const;

export function toPermissionOptions(
  confirmation: SerializableConfirmationDetails,
): acp.PermissionOption[] {
  const options: acp.PermissionOption[] = [];

  switch (confirmation.type) {
    case 'edit':
      if (!confirmation.isModifying) {
        options.push({
          optionId: ToolConfirmationOutcome.ProceedSession,
          name: 'Allow for this session',
          kind: 'allow_always',
        });
      }
      break;
    case 'exec':
      if (confirmation.persistable !== false) {
        options.push({
          optionId: ToolConfirmationOutcome.ProceedPersist,
          name: `Always allow "${confirmation.rootCommand}"`,
          kind: 'allow_always',
        });
      }
      break;
    case 'mcp':
      options.push({
        optionId: ToolConfirmationOutcome.ProceedPersist,
        name: `Always allow "${confirmation.toolDisplayName}"`,
        kind: 'allow_always',
      });
      break;
    case 'info': {
      const isWebFetch = confirmation.urls && confirmation.urls.length > 0;
      if (isWebFetch) {
        const hostname = safeHostname(confirmation.urls![0]);
        options.push({
          optionId: ToolConfirmationOutcome.ProceedPersist,
          name: `Always allow "${hostname}"`,
          kind: 'allow_always',
        });
      } else {
        options.push({
          optionId: ToolConfirmationOutcome.ProceedSession,
          name: 'Allow for this session',
          kind: 'allow_always',
        });
      }
      break;
    }
    case ASK_USER_TOOL_NAME:
      break;
    case EXIT_PLAN_MODE_TOOL_NAME:
      return [
        {
          optionId: 'default',
          name: 'Yes, and manually approve edits',
          kind: 'allow_once',
        },
        {
          optionId: 'acceptEdits',
          name: 'Yes, and auto-accept edits',
          kind: 'allow_always',
        },
        {
          optionId: 'yolo',
          name: 'Yes, and bypass permissions',
          kind: 'allow_always',
        },
        {
          optionId: 'plan',
          name: 'No, keep planning',
          kind: 'reject_once',
        },
      ];
    case 'file_read':
      options.push({
        optionId: ToolConfirmationOutcome.ProceedSession,
        name: 'Allow for this session',
        kind: 'allow_always',
      });
      break;
    case 'workflow':
    case 'video':
      break;
    case 'repeated_tool_call':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedOnce,
          name: 'Allow',
          kind: 'allow_once',
        },
        {
          optionId: ToolConfirmationOutcome.ProceedSession,
          name: 'Always continue this exact call',
          kind: 'allow_always',
        },
        {
          optionId: ToolConfirmationOutcome.Cancel,
          name: 'Reject',
          kind: 'reject_once',
        },
      ];
    default: {
      const unreachable: never = confirmation;
      throw new Error(`Unexpected: ${unreachable}`);
    }
  }

  options.push(...basicPermissionOptions);
  return options;
}

export function buildAcpPermissionContent(
  confirmationDetails: SerializableConfirmationDetails | undefined,
): acp.ToolCallContent[] {
  const content: acp.ToolCallContent[] = [];
  if (!confirmationDetails) return content;

  switch (confirmationDetails.type) {
    case 'edit':
      content.push({
        type: 'diff',
        path: confirmationDetails.filePath,
        oldText: confirmationDetails.originalContent,
        newText: confirmationDetails.newContent,
        _meta: {
          kind: !confirmationDetails.originalContent
            ? 'add'
            : confirmationDetails.newContent === ''
              ? 'delete'
              : 'modify',
        },
      });
      break;
    case 'exec':
      content.push({
        type: 'content',
        content: { type: 'text', text: confirmationDetails.command },
      });
      break;
    case 'mcp': {
      const argsText = confirmationDetails.toolArgs
        ? JSON.stringify(confirmationDetails.toolArgs, null, 2)
        : '';
      content.push({
        type: 'content',
        content: {
          type: 'text',
          text: `Server: ${confirmationDetails.serverName}\nTool: ${confirmationDetails.toolDisplayName || confirmationDetails.toolName}${argsText ? `\nArgs: ${argsText}` : ''}`,
        },
      });
      break;
    }
    case 'info': {
      const text =
        confirmationDetails.prompt +
        (confirmationDetails.urls?.length
          ? `\n\nURLs:\n${confirmationDetails.urls.join('\n')}`
          : '');
      content.push({ type: 'content', content: { type: 'text', text } });
      break;
    }
    case ASK_USER_TOOL_NAME: {
      const questionsText = confirmationDetails.questions
        .map(
          (q, i) =>
            `${i + 1}. ${q.question}\n   Options: ${q.options.map((o) => o.label).join(', ')}`,
        )
        .join('\n');
      content.push({
        type: 'content',
        content: { type: 'text', text: questionsText },
      });
      break;
    }
    case EXIT_PLAN_MODE_TOOL_NAME: {
      const text =
        confirmationDetails.planContent ??
        `Plan file: ${confirmationDetails.planPath}`;
      content.push({ type: 'content', content: { type: 'text', text } });
      break;
    }
    case 'file_read':
      content.push({
        type: 'content',
        content: {
          type: 'text',
          text: `Read file: ${confirmationDetails.displayPath}`,
        },
      });
      break;
    case 'workflow': {
      const argsText =
        confirmationDetails.args === undefined
          ? ''
          : `\nArgs: ${JSON.stringify(confirmationDetails.args, null, 2)}`;
      const phasesText = confirmationDetails.meta?.phases?.length
        ? `\nPhases:\n${confirmationDetails.meta.phases
            .map(
              (phase, index) =>
                `${index + 1}. ${phase.title}${phase.detail ? ` - ${phase.detail}` : ''}`,
            )
            .join('\n')}`
        : '';
      const scriptText = confirmationDetails.script
        ? `\n\nScript:\n${confirmationDetails.script}`
        : '';
      content.push({
        type: 'content',
        content: {
          type: 'text',
          text:
            `Workflow: ${confirmationDetails.workflowName ?? '(unnamed)'}` +
            (confirmationDetails.description
              ? `\nDescription: ${confirmationDetails.description}`
              : '') +
            `\nSource: ${confirmationDetails.scriptPath ?? confirmationDetails.source}` +
            argsText +
            phasesText +
            scriptText,
        },
      });
      break;
    }
    case 'repeated_tool_call':
      content.push({
        type: 'content',
        content: {
          type: 'text',
          text:
            `Tool: ${confirmationDetails.toolName}\n` +
            `Repeated calls: ${confirmationDetails.repeatCount} (threshold: ${confirmationDetails.threshold})\n` +
            `Input: ${confirmationDetails.inputPreview}`,
        },
      });
      break;
    default:
      break;
  }
  return content;
}
