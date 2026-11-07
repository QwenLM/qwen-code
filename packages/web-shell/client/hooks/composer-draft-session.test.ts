import { describe, expect, it, vi } from 'vitest';
import {
  findComposerDraftSession,
  getComposerDraftSession,
  type ComposerDraftContent,
} from './composer-draft-session';
import type { ComposerDraftAttachments } from './composer-draft-attachments';

const content: ComposerDraftContent = {
  text: '',
  inlineTags: [],
  tags: [],
  inputAnnotations: [],
};
const image = { data: 'stored-X', media_type: 'image/png' };
const file = { name: 'Y.txt', media_type: 'text/plain', text: 'new-Y' };

function heldStore() {
  let resolve!: (value: ComposerDraftAttachments | undefined) => void;
  const loaded = new Promise<ComposerDraftAttachments | undefined>((done) => {
    resolve = done;
  });
  return {
    resolve,
    load: vi.fn(() => loaded),
    save: vi.fn(async () => true),
    delete: vi.fn(async () => true),
  };
}

describe('same-session composer draft', () => {
  it('shares pending ingestion and releases it when its view leaves', () => {
    const a = getComposerDraftSession('busy', content, null);
    const main = vi.fn();
    const pane = vi.fn();
    const leaveMain = a.subscribe(main);
    const leavePane = a.subscribe(pane);
    a.setIngestionCount(main, 1);
    a.setIngestionCount(pane, 2);
    expect(a.pendingBatches).toBe(3);
    pane.mockClear();
    leaveMain();
    expect(a.pendingBatches).toBe(2);
    expect(pane).toHaveBeenCalledWith('attachments');
    a.setIngestionCount(pane, 0);
    expect(a.pendingBatches).toBe(0);
    leavePane();
  });

  it('shares live content only with subscribers of the same key', () => {
    const a = getComposerDraftSession('shared-a', content, null);
    const main = vi.fn();
    const pane = vi.fn();
    const leaveMain = a.subscribe(main);
    const leavePane = a.subscribe(pane);
    const b = getComposerDraftSession('shared-b', content, null);
    const other = vi.fn();
    const leaveOther = b.subscribe(other);
    expect(getComposerDraftSession('shared-a', content, null)).toBe(a);
    const edited = { ...content, text: 'new text' };
    a.setContent(edited, main);
    expect(a.content).toBe(edited);
    expect(pane).toHaveBeenCalledWith('content');
    expect(main).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    expect(b.content.text).toBe('');
    leaveMain();
    leavePane();
    leaveOther();
    expect(findComposerDraftSession('shared-a')).toBeUndefined();
    expect(findComposerDraftSession('shared-b')).toBeUndefined();
  });

  it('shares one read and merges additions made by both views', async () => {
    const store = heldStore();
    const a = getComposerDraftSession('loading', content, store);
    const leave = a.subscribe(vi.fn());
    a.restoreAttachments();
    getComposerDraftSession('loading', content, store).restoreAttachments();
    expect(store.load).toHaveBeenCalledTimes(1);
    a.setAttachments({ images: [], files: [file] });
    store.resolve({ images: [image], files: [] });
    await a.loaded;
    expect(a.attachments).toEqual({ images: [image], files: [file] });
    expect(store.save).toHaveBeenCalledWith('loading', a.attachments);
    leave();
  });

  it('propagates explicit clear without restoring the discarded archive', async () => {
    const store = heldStore();
    const a = getComposerDraftSession('clear-loading', content, store);
    const listener = vi.fn();
    const leave = a.subscribe(listener);
    a.restoreAttachments();
    a.setAttachments({ images: [], files: [] }, true);
    expect(listener).toHaveBeenCalledWith('clear');
    expect(a.restoring).toBe(false);
    a.setAttachments({ images: [], files: [file] });
    store.resolve({ images: [image], files: [] });
    await a.loaded;
    expect(a.attachments).toEqual({ images: [], files: [file] });
    leave();
  });

  it('keeps removals of overlapping host payloads while restoration is pending', async () => {
    const store = heldStore();
    const a = getComposerDraftSession('remove-overlap', content, store);
    const leave = a.subscribe(vi.fn());
    a.restoreAttachments();
    const other = { ...file, name: 'Z.txt', text: 'Z bytes' };
    a.setAttachments({ images: [image], files: [file, other] });
    a.setAttachments({ images: [], files: [other] });
    store.resolve({
      images: [{ ...image }],
      files: [{ ...file }, { ...other }],
    });
    await a.loaded;
    expect(a.attachments).toEqual({ images: [], files: [other] });
    expect(store.save).toHaveBeenCalledWith(a.key, a.attachments);
    leave();
  });

  it('keeps the unread archive when only a different new chip was removed', async () => {
    const store = heldStore();
    const a = getComposerDraftSession('remove-new-chip', content, store);
    const leave = a.subscribe(vi.fn());
    a.restoreAttachments();
    a.setAttachments({ images: [], files: [file] });
    a.setAttachments({ images: [], files: [] });
    store.resolve({ images: [image], files: [] });
    await a.loaded;
    expect(a.attachments).toEqual({ images: [image], files: [] });
    leave();
  });

  it('keeps a pending read through an unmount and releases its payload after completion', async () => {
    const store = heldStore();
    const a = getComposerDraftSession('unmounted-loading', content, store);
    const leave = a.subscribe(vi.fn());
    a.restoreAttachments();
    leave();
    expect(findComposerDraftSession(a.key)).toBe(a);
    store.resolve({ images: [image], files: [] });
    await a.loaded;
    expect(findComposerDraftSession(a.key)).toBeUndefined();
  });

  it('keeps in-memory attachments usable without IndexedDB', () => {
    const a = getComposerDraftSession('no-store', content, null);
    const leave = a.subscribe(vi.fn());
    a.setAttachments({ images: [image], files: [file] });
    a.restoreAttachments();
    expect(a.restoring).toBe(false);
    expect(a.attachments).toEqual({ images: [image], files: [file] });
    leave();
  });
});
