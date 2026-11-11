/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 标题、身份与旁路问答能力：`generate_session_title` / `side_question` /
 * `daemon_worker.set_session_title` / `daemon_worker.get_session_identity`。
 *
 * 入参是宿主解析好的产品语义值，结果用返回值交回，失败抛 `ThreadCapabilityError`。
 * 两个 `daemon_worker.*` 能力的 request_id 前缀门禁由宿主在派发前完成（handler 不碰 request_id）。
 */

import { randomUUID } from 'node:crypto';
import type { SideQuestionHistoryEntry } from '@qwen-code/core';
import {
  SessionTitleService,
  resolveTitleBusiness,
  isAbortError,
  isRecord,
  runSideQuestion,
  sessionIdContext,
} from '@qwen-code/core';
import { isStringProp } from '../../support/protocolError.js';
import type { ThreadCallContext } from '../contract/hostContext.js';
import type {
  ThreadSessionTitleResult,
  ThreadSideQuestionResult,
} from '../contract/threadSessionTypes.js';
import {
  ThreadCapabilityError,
  type ThreadSessionInternals,
} from '../contract/handlerContract.js';

/**
 * `generate_session_title`：让会话自己生成标题并写入 topicState。
 *
 * 与 `daemon_worker.set_session_title` 分工：那个只写运行时标题视图，这个在会话内跑一次
 * utility LLM。带 sourceUserMessageId 时区分 TITLE_BUSINESS_NOT_FOUND 与
 * TITLE_GENERATION_FAILED 供宿主重试；`title: null` 不得折叠成空串。
 * runner 懒建到首个 prompt，缺 runner 时经 ensureQueryRunner() 装配一次（memoized）。
 */
export async function generateSessionTitle(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  request: {
    sourceUserMessageId?: string;
    description?: string;
    persist?: boolean;
    customContext?: Readonly<Record<string, string>>;
  },
): Promise<ThreadSessionTitleResult> {
  const config = session.requireConfig();
  const { description, persist, customContext, sourceUserMessageId } = request;
  if (typeof description !== 'string') {
    throw new ThreadCapabilityError('missing description');
  }
  if (persist !== undefined && typeof persist !== 'boolean') {
    throw new ThreadCapabilityError('invalid persist');
  }

  try {
    const runner =
      session.peekQueryRunner() ?? (await session.ensureQueryRunner());
    const messages =
      sourceUserMessageId !== undefined
        ? await runner.getTitleSourceMessages(sourceUserMessageId)
        : runner.getMessages();
    const businessInfo = await resolveTitleBusiness(
      config.getSessionId(),
      messages,
      description,
      sourceUserMessageId,
    );
    if (!businessInfo) {
      if (sourceUserMessageId !== undefined) {
        throw new ThreadCapabilityError(
          'Title source business was not found',
          'TITLE_BUSINESS_NOT_FOUND',
        );
      }
      return { title: null };
    }
    const titleService = new SessionTitleService(config);
    const title = await sessionIdContext.run(config.getSessionId(), () =>
      titleService.generateTitle({
        sessionId: config.getSessionId(),
        businessInfo,
        throwOnError: sourceUserMessageId !== undefined,
        description,
        signal: session.signal,
        currentModel: config.getModel(),
        getModelPolicy: config.getModelPolicy,
        customContext,
      }),
    );
    if (!title && sourceUserMessageId !== undefined) {
      throw new ThreadCapabilityError(
        'Title generation returned no title',
        'TITLE_GENERATION_FAILED',
      );
    }
    if (title) {
      config.topicState?.setTopic?.(title, undefined);
    }

    return { title: title ?? null };
  } catch (err) {
    if (err instanceof ThreadCapabilityError) throw err;
    throw new ThreadCapabilityError(
      err instanceof Error ? err.message : 'generate_session_title failed',
      sourceUserMessageId !== undefined ? 'TITLE_GENERATION_FAILED' : undefined,
    );
  }
}

/**
 * `daemon_worker.set_session_title`：只改本会话运行时标题视图（config.topicState），不写落盘记录。
 *
 * 宿主必须在派发前完成 request_id 前缀门禁并原样复现错误：文本
 * `daemon_worker.set_session_title is reserved for daemon control`、code `SESSION_TITLE_RESERVED`。
 * 该能力 initialize 之后即时可用，不必等 turn 结束；title 为空抛 `missing title`
 * （code `SESSION_TITLE_INVALID_REQUEST`）。
 */
export async function setSessionTitle(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  title: string,
): Promise<void> {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new ThreadCapabilityError(
      'missing title',
      'SESSION_TITLE_INVALID_REQUEST',
    );
  }
  session.requireConfig().topicState.setTopic(title, undefined);
}

/**
 * `daemon_worker.get_session_identity`：只向 daemon 命名空间回传 sessionId。
 *
 * 前缀门禁同样由宿主在派发前完成，拒绝文本
 * `daemon_worker.get_session_identity is reserved for daemon control`、code
 * `SESSION_IDENTITY_RESERVED`。Config 由会话以自己的 sessionId 装配，故直接读 `session.sessionId`。
 */
export async function getSessionIdentity(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
): Promise<Record<string, unknown>> {
  // session_id 是 wire 键名，保留原拼写，避免宿主透传时协议分叉。
  return { session_id: session.sessionId };
}

function isSideQuestionHistoryEntry(
  value: unknown,
): value is SideQuestionHistoryEntry {
  return (
    isRecord(value) &&
    isStringProp(value, 'question') &&
    isStringProp(value, 'response') &&
    (value['fallback_notice'] === undefined ||
      isStringProp(value, 'fallback_notice'))
  );
}

function parseSideQuestionHistory(
  value: unknown,
): SideQuestionHistoryEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;

  const history: SideQuestionHistoryEntry[] = [];
  for (const entry of value) {
    if (!isSideQuestionHistoryEntry(entry)) {
      return undefined;
    }
    history.push({ ...entry });
  }
  return history;
}

/**
 * `side_question`：旁路提问——在当前上下文快照上单独问一次，不进会话历史、不占用主队列与 turn。
 *
 * 同 id 并发去重由宿主在派发前完成（拒绝文本 `side question request is already running`）；
 * 本函数按本地调用 id 登记 `session.sideQuestionControllers`，会话关闭时统一 abort。
 * 进度帧经 `ctx.progress` 交回宿主：注册后发 `started`，API 重试时发 `api_retry`。
 * 取消抛 `'Side question cancelled'`；返回 `response`（可为 null）与 `synthetic` 兜底标记。
 */
export async function sideQuestion(
  session: ThreadSessionInternals,
  ctx: ThreadCallContext,
  request: {
    question: string;
    history?: readonly unknown[];
    customContext?: Readonly<Record<string, string>>;
  },
): Promise<ThreadSideQuestionResult> {
  const config = session.requireConfig();
  const { question, customContext } = request;
  if (typeof question !== 'string' || !question.trim()) {
    throw new ThreadCapabilityError('missing question');
  }

  const history = parseSideQuestionHistory(request.history);
  if (request.history !== undefined && history === undefined) {
    throw new ThreadCapabilityError('invalid history');
  }

  const controller = new AbortController();
  const callId = randomUUID();
  session.sideQuestionControllers.set(callId, controller);
  const signal = AbortSignal.any([controller.signal, session.signal]);
  // 控制器注册之后、执行开始之前发 started；信封字段由宿主补齐。
  ctx.progress?.('started');

  try {
    const cacheSafeQuerySnapshot =
      config.getCacheSafeQuerySnapshot?.() ?? undefined;
    const result = await sessionIdContext.run(config.getSessionId(), () =>
      runSideQuestion({
        config,
        question,
        customContext,
        cacheSafeQuerySnapshot,
        ...(!cacheSafeQuerySnapshot
          ? {
              parentToolSchemas: config.getParentToolSchemas?.(),
              messages: config.getConversationMessages(),
            }
          : {}),
        sessionId: config.getSessionId(),
        history,
        signal,
        onEvent: (event) => {
          // 只把 system/api_retry 投影成进度，重试四字段原样带出。
          if (event.type !== 'system' || event.subtype !== 'api_retry') {
            return;
          }
          const retryEvent = event as typeof event & {
            attempt: number;
            max_retries: number;
            retry_delay_ms: number;
            error_status: number | null;
          };
          ctx.progress?.('api_retry', {
            attempt: retryEvent.attempt,
            max_retries: retryEvent.max_retries,
            retry_delay_ms: retryEvent.retry_delay_ms,
            error_status: retryEvent.error_status,
          });
        },
      }),
    );

    return {
      response: result.textContent || null,
      synthetic: result.synthetic,
    };
  } catch (error) {
    throw new ThreadCapabilityError(
      signal.aborted || isAbortError(error)
        ? 'Side question cancelled'
        : error instanceof Error
          ? error.message
          : 'side_question failed',
    );
  } finally {
    if (session.sideQuestionControllers.get(callId) === controller) {
      session.sideQuestionControllers.delete(callId);
    }
  }
}
