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

type Status =
  | 'waiting'
  | 'starting'
  | 'ready'
  | 'running'
  | 'stopped'
  | 'error';
type ViewWorker = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror'
>;

export class ViewController {
  private documentId?: string;
  private worker?: ViewWorker;
  private terminal = false;
  private pending = false;
  private sequence = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly queue: UiEvent[] = [];
  private inflightInputs?: InputValues;

  constructor(
    private readonly surface: Pick<
      ViewSurface,
      'mount' | 'inputs' | 'apply' | 'stop'
    >,
    private readonly createWorker: () => Promise<ViewWorker>,
    private readonly onDocument: (document: GeneratedDocument) => void,
    private readonly onStatus: (status: Status, message: string) => void,
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
      this.pending = true;
      this.onStatus('starting', 'Starting the interactive view…');
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
        if (this.terminal || !this.pending || this.worker !== worker) return;
        const response = message.data;
        if (response?.sequence !== this.sequence) return;
        try {
          if ('error' in response) {
            this.fail(response.error);
            return;
          }
          this.surface.apply(response.patches, this.inflightInputs);
          clearTimeout(this.timer);
          this.pending = false;
          this.onStatus('ready', 'Interactive view ready');
          this.next();
        } catch {
          this.fail('The generated view returned an invalid update.');
        }
      };
      worker.onerror = () => {
        if (!this.terminal && this.worker === worker)
          this.fail('The view runtime failed. The summary is still available.');
      };
      this.send({
        type: 'init',
        sequence: ++this.sequence,
        javascript: document.javascript,
        inputs,
      });
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error.message
          : 'The saved view is invalid or unsupported.',
      );
    }
  }

  event(event: UiEvent): void {
    if (this.terminal || !this.worker) return;
    const last = this.queue.at(-1);
    if (
      event.type === 'input' &&
      last?.type === 'input' &&
      last.id === event.id
    ) {
      this.queue[this.queue.length - 1] = event;
    } else if (this.queue.length < 16) {
      this.queue.push(event);
    }
    this.next();
  }

  private next(): void {
    if (this.pending || this.terminal) return;
    const event = this.queue.shift();
    if (!event) return;
    try {
      const inputs = this.surface.inputs();
      const input = inputs[event.id];
      this.onStatus('running', 'Updating the view…');
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
    }
  }

  private send(request: UiWorkerRequest): void {
    this.pending = true;
    this.inflightInputs = request.inputs;
    if (request.type === 'event') this.watch(1_000);
    try {
      this.worker!.postMessage(request);
    } catch {
      this.fail('The view runtime could not receive an interaction.');
    }
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
    this.dispose();
    this.onStatus('error', message.slice(0, 240));
  }

  stop(): void {
    if (this.terminal) return;
    this.dispose();
    this.onStatus('stopped', 'Stopped. Reopen the card to start a new view.');
  }

  private dispose(): void {
    this.terminal = true;
    clearTimeout(this.timer);
    this.queue.length = 0;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = undefined;
    }
    this.surface.stop();
  }
}
