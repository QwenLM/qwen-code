/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Factory for constructing {@link Session} aggregates.
 *
 * This is the single place in the package that is allowed to instantiate
 * the {@link SessionImpl} concrete class. All other callers receive the
 * {@link Session} interface so the aggregate implementation remains an
 * internal detail.
 */

import { randomUUID } from 'node:crypto';
import type { Session } from '../domain/interface/session/session.js';
import type { SessionStamp } from '../domain/interface/stamp/session-stamp.js';
import { SessionImpl } from '../domain/impl/session/session-impl.js';
import { buildMessage } from './message-factory.js';
import { buildTurn, groupMessagesIntoTurns } from './turn-factory.js';

/**
 * Builds a fully populated {@link Session} from a stamp.
 *
 * Default-value logic and field assignment live here, not in the
 * {@link SessionImpl} constructor, keeping the implementation class empty
 * after `new` and letting this factory own the aggregate construction policy.
 */
export function buildSession(stamp: SessionStamp): Session {
  const now = new Date().toISOString();

  const session = new SessionImpl();
  session.sessionId = stamp.sessionId ?? randomUUID();
  session.startedAt = stamp.startedAt ?? now;
  session.updatedAt = stamp.updatedAt ?? stamp.startedAt ?? now;
  session.projectDir = stamp.projectDir ?? '';
  session.sessionPath = stamp.sessionPath ?? '';
  session.cwd = stamp.cwd ?? stamp.projectDir ?? '';
  session.index = stamp.index ?? 0;
  session.currentSession = stamp.isCurrentSession ?? false;

  session.remoteId = stamp.remoteId;
  session.entrypoint = stamp.entrypoint;
  session.version = stamp.version;
  session.userType = stamp.userType;
  session.gitBranch = stamp.gitBranch;
  session.worktree = stamp.worktree;
  session.directories = stamp.directories;
  session.transcriptProjectDir = stamp.transcriptProjectDir;
  session.transcriptBucketDir = stamp.transcriptBucketDir;
  session.sourceWorktreePath = stamp.sourceWorktreePath;
  session.displayProjectPath = stamp.displayProjectPath;
  session.tag = stamp.tag;
  session.summary = stamp.summary;
  session.lastPrompt = stamp.lastPrompt;
  session.customTitle = stamp.customTitle;
  session.aiTitle = stamp.aiTitle;
  session.fullContent = stamp.fullContent;
  session.searchableContent = stamp.searchableContent;
  session.fileSize = stamp.fileSize;

  if (stamp.turns) {
    session.turns = stamp.turns.map((turnStamp) => buildTurn(turnStamp));
    session.messages = session.turns.flatMap((turn) => turn.getMessages());
  } else if (stamp.messages) {
    session.messages = stamp.messages.map((messageStamp) =>
      buildMessage(messageStamp),
    );
    session.turns = groupMessagesIntoTurns(session.messages, session.sessionId);
  }
  if (stamp.searchableMessages) {
    session.searchableMessages = stamp.searchableMessages as unknown as ReadonlyArray<
      import('../domain/interface/message/message.js').Message
    >;
  }

  // Synchronize the promptId -> turn index used by incremental addMessage.
  session.rebuildTurns();

  return session;
}
