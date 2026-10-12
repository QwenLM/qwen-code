/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import type { ChatRecordingService } from './chatRecordingService.js';
import { DEFAULT_TOKEN_LIMIT } from '../core/tokenLimits.js';
import { estimateContextTextTokens } from './tokenEstimation.js';
import { ToolNames } from '../tools/tool-names.js';
import type {
  SessionNotesRevision,
  SessionNotesState,
} from './session-notes-state.js';

export interface NotesModelResponse {
  settled?: boolean;
  observed?: SessionNotesState;
  ready: Promise<void>;
  finish: () => void;
  toolName?: string;
}

export async function writeNotesProjection(
  transcriptPath: string,
  notes: SessionNotesRevision | undefined,
): Promise<void> {
  const notesPath = transcriptPath.replace(/\.jsonl$/, '.notes.md');
  if (!notes) {
    await fs.rm(notesPath, { force: true });
    return;
  }
  const temporary = `${notesPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(
      temporary,
      `<!-- Generated from the session log. Direct edits are not imported. Revision: ${notes.revision} -->\n${notes.text}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await fs.rename(temporary, notesPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export class SessionNotesService {
  readonly sessionId: string;
  private response?: NotesModelResponse;
  private pendingReset?: {
    revision: string;
    signal: AbortSignal;
    observed: SessionNotesState;
  };
  private projectedRevision?: string;
  private projectionInitialized = false;

  constructor(
    private readonly config: Config,
    private readonly recorder: ChatRecordingService,
  ) {
    this.sessionId = recorder.getSessionId();
  }

  assertAvailable(): void {
    if (
      this.sessionId !== this.recorder.getSessionId() ||
      this.sessionId !== this.config.getSessionId()
    ) {
      throw new Error('The session changed. Retry in the current session.');
    }
    this.recorder.assertNotesWriterReady();
  }

  beginResponse(observed: SessionNotesState | undefined): void {
    this.finishResponse([]);
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.response = { observed, ready, finish };
  }

  finishResponse(parts: readonly Part[]): void {
    if (!this.response || this.response.settled) return;
    this.response.settled = true;
    const visible = parts.filter((part) => !part.thought);
    this.response.toolName =
      visible.length === 1 ? visible[0].functionCall?.name : undefined;
    this.response.finish();
  }

  captureResponse(): NotesModelResponse | undefined {
    return this.response;
  }

  private async observedResponse(
    response: NotesModelResponse | undefined,
    name: string,
    signal: AbortSignal,
  ): Promise<SessionNotesState> {
    this.assertAvailable();
    if (!response)
      throw new Error(
        'No model request is available for this notes operation.',
      );
    await response.ready;
    signal.throwIfAborted();
    await this.recorder.refreshSessionNotesState();
    if (
      response !== this.response ||
      response.toolName !== name ||
      !response.observed
    ) {
      throw new Error(
        'Write notes and request a new context in separate tool-only responses, with no other tools or assistant text. Read pending input first.',
      );
    }
    this.recorder.assertNotesObservationCurrent(response.observed);
    return response.observed;
  }

  private validateText(text: string, fitCurrentWindow = true): void {
    const contextWindow =
      this.config.getContentGeneratorConfig()?.contextWindowSize ??
      DEFAULT_TOKEN_LIMIT;
    const maxTokens = fitCurrentWindow
      ? Math.min(2048, Math.floor(contextWindow * 0.1))
      : 2048;
    if (
      !text.trim() ||
      Buffer.byteLength(text, 'utf8') > 16 * 1024 ||
      estimateContextTextTokens(text) > maxTokens
    ) {
      throw new Error(
        `Notes must be nonempty and fit within 16 KiB and ${maxTokens} estimated tokens. Shorten them without dropping active user constraints.`,
      );
    }
  }

  async read(): Promise<SessionNotesRevision | undefined> {
    this.assertAvailable();
    await this.recorder.flush();
    await this.recorder.refreshSessionNotesState();
    return this.recorder.runWithWriteBarrier(async () => {
      this.assertAvailable();
      const notes = this.recorder.getSessionNotesState().notes;
      if (notes) this.validateText(notes.text, false);
      if (
        !this.projectionInitialized ||
        notes?.revision !== this.projectedRevision
      ) {
        await writeNotesProjection(
          path.join(
            this.config.storage.getProjectDir(),
            'chats',
            `${this.sessionId}.jsonl`,
          ),
          notes,
        );
        this.projectedRevision = notes?.revision;
        this.projectionInitialized = true;
      }
      return notes;
    });
  }

  async write(
    text: string,
    response: NotesModelResponse | undefined,
    signal: AbortSignal,
  ): Promise<SessionNotesRevision> {
    this.validateText(text);
    const observed = await this.observedResponse(
      response,
      ToolNames.SESSION_NOTES,
      signal,
    );
    const notes = await this.recorder.recordSessionNotes(
      {
        version: 1,
        windowId: observed.windowId!,
        sourceLeafUuid: observed.sourceLeafUuid!,
        text,
      },
      signal,
    );
    await this.read();
    return notes;
  }

  async getNotesForHandoff(pendingInput?: Content): Promise<
    | {
        notes: SessionNotesRevision;
        latestUser?: SessionNotesState['latestUser'];
      }
    | undefined
  > {
    this.assertAvailable();
    const notes = await this.read();
    if (!notes) return undefined;
    this.validateText(notes.text);
    try {
      const state = this.recorder.getNotesHandoffState(pendingInput);
      if (state.notes?.revision !== notes.revision) return undefined;
      return { notes, latestUser: state.latestUser };
    } catch {
      this.assertAvailable();
      return undefined;
    }
  }

  async requestReset(
    revision: string,
    response: NotesModelResponse | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const observed = await this.observedResponse(
      response,
      ToolNames.NEW_CONTEXT,
      signal,
    );
    const current = await this.getNotesForHandoff();
    if (!current || current.notes.revision !== revision) {
      throw new Error(
        'The notes revision is missing or changed. Read the current notes, or write them if missing, then pass the returned revision.',
      );
    }
    signal.throwIfAborted();
    this.recorder.assertNotesObservationCurrent(observed);
    this.pendingReset = { revision, signal, observed };
  }

  takePendingReset(): string | undefined {
    const reset = this.pendingReset;
    this.pendingReset = undefined;
    if (!reset || reset.signal.aborted) return undefined;
    const state = this.recorder.getSessionNotesState();
    try {
      if (!state.notes || state.notes.revision !== reset.revision)
        return undefined;
      this.recorder.assertNotesObservationCurrent(reset.observed);
      return reset.revision;
    } catch {
      this.assertAvailable();
      return undefined;
    }
  }
}
