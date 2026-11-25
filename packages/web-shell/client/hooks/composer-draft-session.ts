import type { DaemonInputAnnotation } from '@qwen-code/sdk/daemon';
import type { WebShellComposerTag } from '../customization';
import type { InlineTagPlacement } from './useComposerCore';
import {
  mergeDraftAttachments,
  subtractDraftAttachments,
  type ComposerDraftAttachments,
  type ComposerDraftAttachmentStore,
} from './composer-draft-attachments';

export interface ComposerDraftContent {
  text: string;
  inlineTags: InlineTagPlacement[];
  tags: WebShellComposerTag[];
  inputAnnotations: DaemonInputAnnotation[];
}

type DraftChange = 'content' | 'attachments' | 'clear';
type Listener = (change: DraftChange) => void;

const sessions = new Map<string, ComposerDraftSession>();

export function findComposerDraftSession(key: string | undefined) {
  return key ? sessions.get(key) : undefined;
}

export function getComposerDraftSession(
  key: string,
  content: ComposerDraftContent,
  store: ComposerDraftAttachmentStore | null,
): ComposerDraftSession {
  let session = sessions.get(key);
  if (!session) {
    session = new ComposerDraftSession(key, content, store);
    sessions.set(key, session);
  }
  return session;
}

export class ComposerDraftSession {
  attachments: ComposerDraftAttachments = { images: [], files: [] };
  loading = false;
  loaded: Promise<void> = Promise.resolve();
  private restored = false;
  private pending: ComposerDraftAttachments | undefined;
  private removed: ComposerDraftAttachments = { images: [], files: [] };
  private discardStored = false;
  private recoveredMessageIds = new Set<string>();
  private attachmentWrite = Promise.resolve(true);
  private ingestionCounts = new Map<Listener, number>();

  get pendingBatches() {
    return [...this.ingestionCounts.values()].reduce(
      (sum, count) => sum + count,
      0,
    );
  }

  get restoring() {
    return this.loading && !this.discardStored;
  }

  constructor(
    readonly key: string,
    public content: ComposerDraftContent,
    private readonly store: ComposerDraftAttachmentStore | null,
  ) {}

  subscribe(listener: Listener): () => void {
    this.ingestionCounts.set(listener, 0);
    return () => {
      const busy = this.ingestionCounts.get(listener);
      this.ingestionCounts.delete(listener);
      if (busy) this.emit('attachments');
      this.release();
    };
  }

  setIngestionCount(listener: Listener, count: number) {
    if (this.ingestionCounts.get(listener) === count) return;
    this.ingestionCounts.set(listener, count);
    this.emit('attachments');
  }

  private release() {
    if (
      !this.ingestionCounts.size &&
      !this.loading &&
      sessions.get(this.key) === this
    )
      sessions.delete(this.key);
  }

  private emit(change: DraftChange, source?: Listener) {
    for (const listener of this.ingestionCounts.keys()) {
      if (listener !== source) listener(change);
    }
  }

  setContent(content: ComposerDraftContent, source?: Listener) {
    this.content = content;
    this.emit('content', source);
  }

  private persist(attachments: ComposerDraftAttachments): Promise<boolean> {
    const recoveredMessageIds = [...this.recoveredMessageIds];
    const store = this.store;
    if (!store) return Promise.resolve(false);
    const write = () =>
      attachments.images.length ||
      attachments.files.length ||
      recoveredMessageIds.length
        ? store.save(this.key, {
            ...attachments,
            ...(recoveredMessageIds.length ? { recoveredMessageIds } : {}),
          })
        : store.delete(this.key);
    this.attachmentWrite = this.attachmentWrite.then(write, write);
    return this.attachmentWrite;
  }

  hasRecoveredAttachments(messageId: string): boolean {
    return this.recoveredMessageIds.has(messageId);
  }

  async recoverAttachments(
    attachments: ComposerDraftAttachments,
    messageIds: readonly string[],
  ): Promise<boolean> {
    for (const id of messageIds) this.recoveredMessageIds.add(id);
    this.attachments = attachments;
    this.emit('attachments');
    return await this.persist(attachments);
  }

  setAttachments(attachments: ComposerDraftAttachments, clear = false) {
    if (this.loading) {
      const removed = subtractDraftAttachments(this.attachments, attachments);
      this.removed.images.push(...removed.images);
      this.removed.files.push(...removed.files);
      this.pending = attachments;
      this.discardStored ||= clear;
    } else {
      void this.persist(attachments);
    }
    this.attachments = attachments;
    this.emit(clear ? 'clear' : 'attachments');
  }

  restoreAttachments() {
    if (this.restored || this.loading) return;
    if (!this.store) {
      this.restored = true;
      return;
    }
    this.loading = true;
    this.loaded = this.store.load(this.key).then((stored) => {
      for (const id of stored?.recoveredMessageIds ?? []) {
        this.recoveredMessageIds.add(id);
      }
      this.attachments = mergeDraftAttachments(
        this.pending ?? { images: [], files: [] },
        this.discardStored
          ? { images: [], files: [] }
          : subtractDraftAttachments(
              stored ?? { images: [], files: [] },
              this.removed,
            ),
      );
      if (this.pending) void this.persist(this.attachments);
      this.pending = undefined;
      this.removed = { images: [], files: [] };
      this.loading = false;
      this.restored = true;
      this.emit('attachments');
      this.release();
    });
    this.emit('attachments');
  }
}
