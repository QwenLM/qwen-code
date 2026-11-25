/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @qwen-code/core/sessions 公开面。
 *
 * 重新导出 `./domain/interface/**` 中的类型与进程单例 `sessionManager`；
 * `./domain/impl/**` 与 `./infra/**` 对包外不可见。
 */

import { createSessionManager } from './factory/session-manager-factory.js';
import { createSessionTranscriptStore } from './factory/session-transcript-store-factory.js';
import {
  getConfigHomeDir,
  setConfigHomeDir,
} from './config/sessions-config.js';

export const sessionTranscriptStore = createSessionTranscriptStore();
export const sessionManager = createSessionManager({store: sessionTranscriptStore});

export { getConfigHomeDir, setConfigHomeDir };

export { SessionError } from './domain/interface/exception/session-error.js';
export type { SessionErrorCode } from './domain/interface/exception/session-error.js';
export type { SessionManager } from './domain/interface/manager/session-manager.js';
export type { SessionDeleteOptions } from './domain/interface/manager/session-delete-options.js';
export type {
  SessionLoadOptions,
  SessionFilter,
} from './domain/interface/manager/session-load-options.js';
export type { SessionRenameOptions } from './domain/interface/manager/session-rename-options.js';
export type { SessionForkOptions } from './domain/interface/manager/session-fork-options.js';

export type { Session } from './domain/interface/session/session.js';
export type { SessionStamp } from './domain/interface/stamp/session-stamp.js';

export type { Turn } from './domain/interface/turn/turn.js';
export type { Message } from './domain/interface/message/message.js';
export type { MessageForkInfo } from './domain/interface/message/message-fork-info.js';
export type { MessageStamp } from './domain/interface/stamp/message-stamp.js';
export type { TurnStamp } from './domain/interface/stamp/turn-stamp.js';

export type { SessionTranscriptStore } from './domain/interface/writer/session-transcript-store.js';
export type { SessionTranscriptWriter } from './domain/interface/writer/session-transcript-writer.js';
export type { SessionWriterOptions } from './domain/interface/writer/session-writer-options.js';

export {
  getUserConfigDisplayPath,
  resetConfigHomeDirCache,
} from './config/sessions-config.js';
