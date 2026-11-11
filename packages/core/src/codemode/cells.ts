/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { ScriptCallSummary, ScriptImage, ScriptResult } from './types.js';
import type { CodeModeSummary } from './host.js';
import type {
  QueryLifecycle,
  ToolAdmissionGuard,
  ToolUseContext,
} from '../tools/tool-types.js';
import {
  isCodeModeDisplay,
  type CodeModeChildDisplay,
  type ToolLiveOutput,
} from '../tools/tools.js';
import {
  CODE_MODE_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
} from '../tools/tool-names.js';

export interface CellCompletion {
  result: ScriptResult;
  summary: CodeModeSummary;
}

export type CellProgress = Pick<
  CodeModeSummary,
  'calls' | 'children' | 'storeError'
>;

export interface CellSlice {
  output: string[];
  images: ScriptImage[];
  completion?: CellCompletion;
}

/**
 * One cell per session/agent, retaining the same VM, scope and permission
 * context across polls. While it lives, it owns its agent's tool execution
 * and retires when its query ends.
 */
export class CodeModeCell {
  rootToolUseId?: string;
  readonly id = randomUUID();
  /** Child calls carry this scheduler ID; the admission guard lets them through. */
  readonly toolCallScopeId = `codemode:${this.id}`;
  readonly started = performance.now();
  readonly controller = new AbortController();
  readonly output: string[] = [];
  readonly images: ScriptImage[] = [];
  readonly hookOutputs: NonNullable<ToolUseContext['pendingHookOutputs']> = [];
  readonly hookAttachments: NonNullable<
    ToolUseContext['pendingHookAttachments']
  > = [];
  /** Set by the running script; cleared once the final summary exists. */
  getProgress?: () => CellProgress;
  private onUpdate?: ToolUseContext['updateOutput'];
  private cursor = 0;
  private imageCursor = 0;
  private readonly shownChildren = new Map<string, CodeModeChildDisplay>();
  private readonly shownCalls = new Map<string, string>();
  private hookOutputCursor = 0;
  private hookAttachmentCursor = 0;
  private polling = false;
  private completion?: CellCompletion;
  private finished!: Promise<CellCompletion>;
  private readonly retireWithQuery = () => this.retire();
  private readonly guard: ToolAdmissionGuard = (request) =>
    request.name === CODE_MODE_TOOL_NAME ||
    request.name === CODE_MODE_WAIT_TOOL_NAME ||
    request.toolCallScopeId === this.toolCallScopeId
      ? undefined
      : `CodeMode cell ${this.id} owns this agent's tool execution. Call ${CODE_MODE_WAIT_TOOL_NAME} with this cell_id to wait, or with cancel: true to stop it, before calling another tool.`;

  constructor(
    private readonly lifecycle: QueryLifecycle,
    private readonly releaseOwner: () => void,
  ) {
    lifecycle.cleanups.add(this.retireWithQuery);
    lifecycle.admissionGuards.add(this.guard);
  }

  start(run: (cell: CodeModeCell) => Promise<CellCompletion>): void {
    const signal = this.lifecycle.signal;
    const abort = () => this.controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    this.finished = Promise.resolve()
      .then(() => run(this))
      .catch(
        (error: unknown): CellCompletion => ({
          result: {
            status: 'error',
            output: this.output,
            errorKind: 'runtime_start',
            error:
              error instanceof Error ? error.message : 'Unable to start cell',
          },
          summary: { calls: [], endsTurn: false, newMessages: [] },
        }),
      )
      .then((completion) => {
        this.output.splice(0, this.output.length, ...completion.result.output);
        if (completion.result.images)
          this.images.splice(
            0,
            this.images.length,
            ...completion.result.images,
          );
        this.completion = completion;
        // The summary is final; release the scope and its original tool results.
        this.getProgress = undefined;
        signal.removeEventListener('abort', abort);
        return completion;
      });
  }

  /** Forwards live progress to the current poller, omitting children it has already shown. */
  publish(output: ToolLiveOutput): void {
    this.onUpdate?.(
      isCodeModeDisplay(output)
        ? {
            ...output,
            children: output.children.filter(
              (child) => this.shownChildren.get(child.callId) !== child,
            ),
            totalCalls: output.children.length,
          }
        : output,
    );
  }

  /** One receipt feeds both transcript children and the returned display. */
  callReceipt(calls: ScriptCallSummary[], children: CodeModeChildDisplay[]) {
    const displays = new Map(children.map((child) => [child.callId, child]));
    const changed = calls.flatMap((call) => {
      const child = displays.get(call.callId);
      const displayStatus = child?.status;
      const snapshot = {
        ...call,
        ...(displayStatus ? { displayStatus } : {}),
        ...(child?.hostResult ? { hostResult: child.hostResult } : {}),
      };
      // Child displays are replaced on update, so their identity tracks native result changes.
      const fingerprint = JSON.stringify(call);
      return (child && this.shownChildren.get(call.callId) !== child) ||
        this.shownCalls.get(call.callId) !== fingerprint
        ? [{ snapshot, fingerprint }]
        : [];
    });
    const ids = new Set(changed.map(({ snapshot }) => snapshot.callId));
    return {
      calls: changed.map(({ snapshot }) => snapshot),
      children: children.filter((child) => ids.has(child.callId)),
      commit: () => {
        for (const { snapshot, fingerprint } of changed)
          this.shownCalls.set(snapshot.callId, fingerprint);
        for (const child of children) this.shownChildren.set(child.callId, child);
      },
    };
  }

  deliverHooks(ctx: ToolUseContext): void {
    // Keep the original queues intact: the scope still inspects stop attachments
    // when a child completes after an earlier poll delivered its hook output.
    ctx.pendingHookOutputs?.push(
      ...this.hookOutputs.slice(this.hookOutputCursor),
    );
    ctx.pendingHookAttachments?.push(
      ...this.hookAttachments.slice(this.hookAttachmentCursor),
    );
    this.hookOutputCursor = this.hookOutputs.length;
    this.hookAttachmentCursor = this.hookAttachments.length;
  }

  get done(): boolean {
    return this.completion !== undefined;
  }

  async retire(): Promise<void> {
    await this.cancel();
    this.releaseOwner();
    this.lifecycle.cleanups.delete(this.retireWithQuery);
    this.lifecycle.admissionGuards.delete(this.guard);
  }

  async cancel(): Promise<void> {
    this.controller.abort('CodeMode cell cancelled');
    await this.finished;
  }

  async poll(options: {
    yieldMs: number;
    signal: AbortSignal;
    onUpdate?: ToolUseContext['updateOutput'];
    /** Stop the script first and wait for its scope to settle. */
    cancel?: boolean;
  }): Promise<CellSlice> {
    const { yieldMs, signal } = options;
    if (this.polling)
      throw new Error('This CodeMode cell already has a pending wait');
    this.polling = true;
    this.onUpdate = options.onUpdate;
    const abort = () => this.controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (options.cancel) await this.cancel();
      if (!this.done && yieldMs > 0)
        await Promise.race([
          this.finished,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, yieldMs);
          }),
        ]);
      // Cancellation must settle the scope before its owner continues.
      if (signal.aborted) await this.finished;
      const output = this.output.slice(this.cursor);
      this.cursor = this.output.length;
      const images = this.images.slice(this.imageCursor);
      this.imageCursor = this.images.length;
      return {
        output,
        images,
        ...(this.completion ? { completion: this.completion } : {}),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      this.onUpdate = undefined;
      this.polling = false;
    }
  }
}
