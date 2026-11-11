/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BusinessInfo } from '../qoder/business-info.js';
import { createQueryBusinessInfo } from '../core/agent-lifecycle-state.js';

import type { Config } from '../config/config.js';
import type { TranscriptWriterHandle } from './transcript/writer-handle.js';
import { runLogger } from '../utils/runLogger.js';
import { sessionIdContext } from '../utils/sessionIdContext.js';
import type { Message } from '../protocol/transcript/message.js';
import {
  getAssistantTextBlocks,
  getRealUserPromptText,
} from '../protocol/transcript/message-utils.js';
import { beginResumeRead } from './transcript/resume-read-budget.js';
import { SessionTitleService } from './sessionTitleService.js';

const REMOTE_AI_TITLE_MAX_WORDS = 8;
const REMOTE_CONTROL_CONNECTED_ASSISTANT_TEXT = 'Remote Control Connected';

export type AiTitleOrigin = 'fresh-ai' | 'existing-ai' | 'existing-custom';

function isKnownSyntheticAssistantMessage(
  message: Extract<Message, { type: 'assistant' }>,
): boolean {
  const textBlocks = getAssistantTextBlocks(message);
  return (
    message.message.content.length === 1 &&
    textBlocks.length === 1 &&
    textBlocks[0] === REMOTE_CONTROL_CONNECTED_ASSISTANT_TEXT
  );
}

export function isTitleEligibleAssistantMessage(
  message: Message,
): message is Extract<Message, { type: 'assistant' }> {
  return (
    message.type === 'assistant' &&
    message.isMeta !== true &&
    message.isVirtual !== true &&
    message.isVisibleInTranscriptOnly !== true &&
    !isKnownSyntheticAssistantMessage(message)
  );
}

export function hasTitleEligibleAssistantMessage(
  messages: readonly Message[],
): boolean {
  return messages.some(isTitleEligibleAssistantMessage);
}

export interface GenerateSessionTitleArgs {
  businessInfo?: Readonly<BusinessInfo>;
  config: Config;
  writer: TranscriptWriterHandle;
  /**
   * Generate from the submitted prompt immediately, before the first model
   * response is available. When omitted, the persisted conversation is used.
   */
  description?: string;
  /** Required when generating from the persisted conversation. */
  leafUuidAtSubmit?: string;
  signal: AbortSignal;
  allowOverwriteAiTitle?: boolean;
  onTitleWritten?: (title: string, origin: AiTitleOrigin) => void;
}

export async function generateSessionTitleForCurrentSession(
  args: GenerateSessionTitleArgs,
): Promise<void> {
  const {
    config,
    writer,
    description,
    leafUuidAtSubmit,
    signal,
    allowOverwriteAiTitle = false,
    onTitleWritten,
  } = args;
  const sessionId = writer.getSessionId();
  const sessionPath = writer.getSessionFilePath();
  const promptDescription = description?.trim();

  try {
    if (sessionId !== config.getSessionId()) {
      runLogger.debug(
        `[SessionTitle] Writer/config sessionId mismatch (writer=${sessionId}, config=${config.getSessionId()}); skipping`,
      );
      return;
    }

    const repository = config.getTranscriptStore().repository();
    // Each read owns a short lease; never hold process admission over an LLM call.
    const readTitleState = async () => {
      const attempt = await beginResumeRead({ signal });
      try {
        return await repository.readForResume(sessionPath, {
          sessionId,
          attempt,
          consistency: 'flush-pending',
        });
      } finally {
        attempt.finish();
      }
    };
    const initialLoad = await readTitleState();
    if (!initialLoad && !promptDescription) {
      return;
    }

    const existingCustomTitle =
      initialLoad?.metadata.customTitles.get(sessionId);
    if (existingCustomTitle) {
      runLogger.debug(
        `[SessionTitle] Session ${sessionId} has custom title: "${existingCustomTitle}"; publishing without regenerating`,
      );
      onTitleWritten?.(existingCustomTitle, 'existing-custom');
      return;
    }

    const existingAiTitle = initialLoad?.metadata.aiTitles.get(sessionId);
    if (existingAiTitle && !allowOverwriteAiTitle) {
      runLogger.debug(
        `[SessionTitle] Session ${sessionId} already ai-titled: "${existingAiTitle}"; publishing without regenerating`,
      );
      onTitleWritten?.(existingAiTitle, 'existing-ai');
      return;
    }

    let messages: readonly Message[] | undefined;
    if (!promptDescription) {
      const currentLeafUuid = initialLoad?.writerState.mainParentUuid;
      if (
        !leafUuidAtSubmit ||
        !currentLeafUuid ||
        currentLeafUuid !== leafUuidAtSubmit
      ) {
        runLogger.debug(
          `[SessionTitle] Leaf advanced for ${sessionId} (saw=${currentLeafUuid}, expected=${leafUuidAtSubmit}); skipping`,
        );
        return;
      }

      messages = initialLoad.messages;
      if (messages.length === 0) {
        runLogger.debug(
          `[SessionTitle] No messages available for ${sessionId}; skipping`,
        );
        return;
      }
      if (!hasTitleEligibleAssistantMessage(messages)) {
        runLogger.debug(
          `[SessionTitle] No model assistant response for ${sessionId}; skipping`,
        );
        return;
      }
    }

    const businessInfo =
      args.businessInfo ??
      (await resolveTitleBusiness(
        sessionId,
        messages ?? initialLoad?.messages ?? [],
      ));
    if (!businessInfo) return;

    const titleService = new SessionTitleService(config);
    const title = await sessionIdContext.run(sessionId, () =>
      titleService.generateTitle({
        sessionId,
        businessInfo,
        ...(promptDescription
          ? { description: promptDescription }
          : { messages: messages! }),
        signal,
        currentModel: config.getModel(),
        getModelPolicy: config.getModelPolicy,
      }),
    );
    if (!title) {
      runLogger.debug(
        `[SessionTitle] Title service returned empty for ${sessionId}`,
      );
      return;
    }

    const freshLoad = await readTitleState();
    if (
      freshLoad?.metadata.customTitles.has(sessionId) ||
      (!allowOverwriteAiTitle && freshLoad?.metadata.aiTitles.has(sessionId))
    ) {
      runLogger.debug(
        `[SessionTitle] Concurrent title landed for ${sessionId}; skipping`,
      );
      return;
    }

    if (signal.aborted || sessionId !== config.getSessionId()) {
      runLogger.debug(
        `[SessionTitle] Aborted or session changed before write for ${sessionId}; skipping`,
      );
      return;
    }

    await writer.recordAiTitle(title);
    runLogger.debug(
      `[SessionTitle] Saved ai-title for ${sessionId}: "${title}"`,
    );
    onTitleWritten?.(title, 'fresh-ai');
  } catch (error) {
    runLogger.warn(
      `[SessionTitle] Error generating title: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface GenerateRemoteSessionTitleArgs {
  businessInfo?: Readonly<BusinessInfo>;
  config: Config;
  messages: readonly Message[];
}

export async function generateRemoteSessionTitleForMessages({
  config,
  messages,
  businessInfo,
}: GenerateRemoteSessionTitleArgs): Promise<string | null> {
  try {
    const sessionId = config.getSessionId();
    if (!hasTitleEligibleAssistantMessage(messages)) {
      runLogger.debug(
        '[RemoteSessionTitle] skipped: no model assistant response',
      );
      return null;
    }

    const titleMessages = messages.filter(
      (message) =>
        message.type === 'user' || isTitleEligibleAssistantMessage(message),
    );
    if (titleMessages.length === 0) {
      runLogger.debug(
        '[RemoteSessionTitle] skipped: no user/assistant messages',
      );
      return null;
    }

    const parentBusinessInfo =
      businessInfo ?? (await resolveTitleBusiness(sessionId, titleMessages));
    if (!parentBusinessInfo) return null;

    const titleService = new SessionTitleService(config);
    const title = await sessionIdContext.run(sessionId, () =>
      titleService.generateTitle({
        sessionId,
        messages: titleMessages,
        businessInfo: parentBusinessInfo,
        promptId: 'remote-title-generation',
        maxWords: REMOTE_AI_TITLE_MAX_WORDS,
        maxAttempts: 1,
        currentModel: config.getModel(),
        getModelPolicy: config.getModelPolicy,
      }),
    );

    if (!title) {
      runLogger.debug(
        `[RemoteSessionTitle] rejected session=${sessionId} reason=empty-title`,
      );
      return null;
    }

    runLogger.debug(
      `[RemoteSessionTitle] accepted session=${sessionId} title=${JSON.stringify(title)}`,
    );
    return title;
  } catch (error) {
    runLogger.warn(
      `[RemoteSessionTitle] Error generating title: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** Transcript task IDs are the main business IDs allocated by the CLI hosts. */
export async function resolveTitleBusiness(
  sessionId: string,
  messages: readonly Message[],
  description?: string,
  sourceUserMessageId?: string,
): Promise<Readonly<BusinessInfo> | undefined> {
  let owner: Message | undefined;
  if (sourceUserMessageId !== undefined) {
    owner = messages.find((message) => message.uuid === sourceUserMessageId);
    if (
      owner?.type !== 'user' ||
      owner.isMeta ||
      !owner.requestSetId ||
      !owner.businessIdentity
    ) {
      return undefined;
    }
  } else {
  const candidates = messages.filter(
    (message) =>
      message.type === 'user' &&
      !message.isMeta &&
      message.requestSetId &&
      getRealUserPromptText(message),
  );
  const matches =
    description === undefined
      ? []
      : candidates.filter(
          (message) =>
            getRealUserPromptText(message)?.trim() === description.trim(),
        );
  // 附件和上下文会改写执行正文；匹配失败时约定归属首条已执行的真实用户消息。
  owner =
    description === undefined
      ? candidates.at(-1)
      : matches.length === 1
        ? matches[0]
        : candidates[0];
  }
  if (!owner || owner.type !== 'user' || !owner.requestSetId) return undefined;
  // 旧调用也优先继承消息快照；旧记录缺失时保留原有归属规则，不借用当前模型。
  const business = await createQueryBusinessInfo(
    sessionId,
    description ?? getRealUserPromptText(owner) ?? '',
    owner.requestSetId,
    undefined,
    owner.businessIdentity ? owner.businessIdentity.model_key : owner.businessModelKey,
    owner.businessIdentity?.type,
  );
  return { ...business, ...owner.businessIdentity };
}
