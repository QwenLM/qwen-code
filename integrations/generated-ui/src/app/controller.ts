/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { parseToolResult } from '../contracts.js';
import type { GeneratedDocument } from '../contracts.js';
import type { ViewSurface } from './surface.js';
import type {
  InputValues,
  UiEvent,
  UiWorkerRequest,
  UiWorkerResponse,
} from './runtime-contract.js';

type Phase =
  | 'waiting'
  | 'starting'
  | 'ready'
  | 'running'
  | 'dirty'
  | 'stopped'
  | 'error';
export interface ViewState {
  phase: Phase;
  viewAvailable: boolean;
  lastUpdate?: 'applied' | 'superseded' | 'outdated';
  rejectedEvents: number;
  error?: string;
}
export type EventAdmission =
  | 'accepted'
  | 'coalesced'
  | 'rejected-full'
  | 'ignored-not-ready'
  | 'ignored-terminal';
export type AppliedParametersV1 = Readonly<{
  schemaVersion: 1;
  documentId: string;
  activationId: string;
  appliedSequence: number;
  baseInputRevision: number;
  inputRevision: number;
  inputs: Readonly<
    Record<string, Readonly<{ value: string; checked: boolean }>>
  >;
}>;
export type CaptureResult =
  | Readonly<{
      ok: true;
      snapshot: AppliedParametersV1;
      rejectedEvents: number;
    }>
  | Readonly<{
      ok: false;
      reason: 'not-ready' | 'busy' | 'dirty' | 'stopped' | 'error';
    }>;
type ViewWorker = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror'
>;

function copyInputs(inputs: InputValues): InputValues {
  return Object.fromEntries(
    Object.entries(inputs).map(([id, input]) => [
      id,
      { value: input.value, checked: input.checked },
    ]),
  );
}

function sameInputs(left: InputValues, right: InputValues): boolean {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(
      ([id, input]) =>
        Object.hasOwn(right, id) &&
        input.value === right[id].value &&
        input.checked === right[id].checked,
    )
  );
}

export class ViewController {
  private documentId?: string;
  private worker?: ViewWorker;
  private terminal?: 'stopped' | 'error';
  private error?: string;
  private initialized = false;
  private sequence = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly queue: UiEvent[] = [];
  private inflight?: {
    request: UiWorkerRequest;
    baseInputRevision: number;
  };
  private inputs?: InputValues;
  private inputRevision = 0;
  private applied?: AppliedParametersV1;
  private lastUpdate?: ViewState['lastUpdate'];
  private rejectedEvents = 0;
  private readonly activationId = Array.from(
    crypto.getRandomValues(new Uint32Array(4)),
    (value) => value.toString(16),
  ).join('-');

  constructor(
    private readonly surface: Pick<
      ViewSurface,
      'mount' | 'inputs' | 'apply' | 'stop'
    >,
    private readonly createWorker: () => Promise<ViewWorker>,
    private readonly onDocument: (document: GeneratedDocument) => void,
    private readonly onStatus: (state: ViewState) => void,
  ) {}

  async receive(result: unknown): Promise<void> {
    if (this.terminal) return;
    try {
      const document = parseToolResult(result);
      if (this.documentId === document.documentId) return;
      if (this.documentId)
        throw new Error('This card changed unexpectedly. Open a new view.');
      this.documentId = document.documentId;
      this.onDocument(document);
      this.publish();
      this.watch(5_000);
      const [inputs, worker] = await Promise.all([
        this.surface.mount(document.html, document.css),
        this.createWorker().then((worker) => {
          if (this.terminal) worker.terminate();
          else this.worker = worker;
          return worker;
        }),
      ]);
      if (this.terminal) return;
      worker.onmessage = (message: MessageEvent<UiWorkerResponse>) => {
        if (this.terminal || !this.inflight || this.worker !== worker) return;
        const response = message.data;
        if (response?.sequence !== this.sequence) return;
        try {
          if ('error' in response) {
            this.fail(response.error);
            return;
          }
          const { request, baseInputRevision } = this.inflight;
          if (
            request.type === 'init'
              ? response.execution !== 'initialized'
              : !['handled', 'unhandled'].includes(response.execution)
          ) {
            throw new Error('Invalid execution result.');
          }
          this.observeInputs(this.surface.inputs());
          const preApplyInputRevision = this.inputRevision;
          const outcome = this.surface.apply(response.patches, request.inputs);
          if (outcome.kind === 'stopped') {
            this.stop();
            return;
          }
          this.observeInputs(outcome.inputs);
          if (outcome.kind === 'superseded') {
            this.lastUpdate = 'superseded';
          } else if (response.execution !== 'unhandled') {
            if (baseInputRevision === preApplyInputRevision) {
              const inputs = copyInputs(outcome.inputs);
              for (const input of Object.values(inputs)) Object.freeze(input);
              this.applied = Object.freeze({
                schemaVersion: 1,
                documentId: this.documentId!,
                activationId: this.activationId,
                appliedSequence: response.sequence,
                baseInputRevision,
                inputRevision: this.inputRevision,
                inputs: Object.freeze(inputs),
              });
              this.lastUpdate = 'applied';
            } else {
              this.lastUpdate = 'outdated';
            }
          }
          if (request.type === 'init') this.initialized = true;
          clearTimeout(this.timer);
          this.inflight = undefined;
          this.next();
        } catch {
          this.fail('The generated view returned an invalid update.');
        }
      };
      worker.onerror = () => {
        if (!this.terminal && this.worker === worker)
          this.fail('The view runtime failed. The summary is still available.');
      };
      this.observeInputs(inputs);
      this.observeInputs(this.surface.inputs());
      this.send({
        type: 'init',
        sequence: ++this.sequence,
        javascript: document.javascript,
        inputs: this.inputs!,
      });
      this.publish();
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error.message
          : 'The saved view is invalid or unsupported.',
      );
    }
  }

  event(event: UiEvent): EventAdmission {
    if (this.terminal) return 'ignored-terminal';
    if (!this.worker || !this.inputs) return 'ignored-not-ready';
    try {
      this.observeInputs(this.surface.inputs());
    } catch {
      this.fail('The view could not read its current inputs.');
      return 'ignored-terminal';
    }
    const last = this.queue.at(-1);
    let admission: EventAdmission;
    if (
      event.type === 'input' &&
      last?.type === 'input' &&
      last.id === event.id
    ) {
      this.queue[this.queue.length - 1] = event;
      admission = 'coalesced';
    } else if (this.queue.length < 16) {
      this.queue.push(event);
      admission = 'accepted';
    } else {
      this.rejectedEvents++;
      admission = 'rejected-full';
    }
    this.next();
    return admission;
  }

  private next(): void {
    if (this.terminal) return;
    if (!this.inflight) {
      const event = this.queue.shift();
      if (event) {
        try {
          const inputs = this.surface.inputs();
          this.observeInputs(inputs);
          const input = inputs[event.id];
          this.send({
            type: 'event',
            sequence: ++this.sequence,
            event: {
              ...event,
              value: input?.value ?? '',
              checked: input?.checked ?? false,
            },
            inputs,
          });
        } catch {
          this.fail('The view could not read its current inputs.');
          return;
        }
      }
    }
    this.publish();
  }

  private send(request: UiWorkerRequest): void {
    this.inflight = {
      request: { ...request, inputs: copyInputs(request.inputs) },
      baseInputRevision: this.inputRevision,
    };
    if (request.type === 'event') this.watch(1_000);
    try {
      this.worker!.postMessage(this.inflight.request);
    } catch {
      this.fail('The view runtime could not receive an interaction.');
    }
  }

  captureSnapshot(): CaptureResult {
    if (this.terminal)
      return Object.freeze({ ok: false, reason: this.terminal });
    if (!this.initialized)
      return Object.freeze({ ok: false, reason: 'not-ready' });
    try {
      this.observeInputs(this.surface.inputs());
    } catch {
      this.fail('The view could not read its current inputs.');
      return Object.freeze({ ok: false, reason: 'error' });
    }
    this.publish();
    if (this.inflight || this.queue.length)
      return Object.freeze({ ok: false, reason: 'busy' });
    if (!this.applied || this.applied.inputRevision !== this.inputRevision)
      return Object.freeze({ ok: false, reason: 'dirty' });
    return Object.freeze({
      ok: true,
      snapshot: this.applied,
      rejectedEvents: this.rejectedEvents,
    });
  }

  private observeInputs(inputs: InputValues): void {
    if (this.inputs && !sameInputs(this.inputs, inputs)) this.inputRevision++;
    this.inputs = copyInputs(inputs);
  }

  private publish(): void {
    const phase = this.terminal
      ? this.terminal
      : !this.documentId
        ? 'waiting'
        : !this.initialized
          ? 'starting'
          : this.inflight || this.queue.length
            ? 'running'
            : this.applied?.inputRevision === this.inputRevision
              ? 'ready'
              : 'dirty';
    this.onStatus({
      phase,
      viewAvailable: this.initialized,
      lastUpdate: this.lastUpdate,
      rejectedEvents: this.rejectedEvents,
      error: this.error,
    });
  }

  private watch(milliseconds: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.fail('The view exceeded its execution time limit.'),
      milliseconds,
    );
  }

  fail(message: string): void {
    if (this.terminal) return;
    this.terminal = 'error';
    this.error = message.slice(0, 240);
    this.dispose();
    this.publish();
  }

  stop(): void {
    if (this.terminal) return;
    this.terminal = 'stopped';
    this.dispose();
    this.publish();
  }

  private dispose(): void {
    clearTimeout(this.timer);
    this.queue.length = 0;
    this.inflight = undefined;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = undefined;
    }
    this.surface.stop();
  }
}
