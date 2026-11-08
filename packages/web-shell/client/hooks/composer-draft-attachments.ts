import type { PromptFile, PromptImage } from '../adapters/promptTypes';
import { dedupeAttachmentName } from '../utils/imageIngestion';
import { runIndexedDbRequest, type IndexedDbSchema } from '../utils/indexeddb';

/**
 * Persistence for unsent composer attachments.
 *
 * The draft's text lives in `localStorage`, but an image cannot: the composer
 * accepts files up to 8 MB, and its base64 data URL would exhaust the few
 * megabytes an origin gets there — taking the text draft down with it. This
 * store keeps the same payloads the composer holds (images as base64 data
 * URLs, pasted files as their `File`/text) under the same draft key in
 * IndexedDB, which shares the far larger origin quota.
 *
 * IndexedDB can be unavailable (private mode, partitioned storage) and the
 * browser may evict best-effort data at any time, so every operation fails
 * soft: a miss means "no stored attachments", never an error the composer has
 * to surface.
 */

const SCHEMA: IndexedDbSchema = {
  name: 'qwen-web-shell-composer-drafts',
  version: 1,
  store: 'attachments',
};

export interface ComposerDraftAttachments {
  images: PromptImage[];
  files: PromptFile[];
}

export interface ComposerDraftAttachmentStore {
  save(key: string, attachments: ComposerDraftAttachments): Promise<boolean>;
  load(key: string): Promise<ComposerDraftAttachments | undefined>;
  delete(key: string): Promise<boolean>;
}

function sameImage(left: PromptImage, right: PromptImage): boolean {
  return left.media_type === right.media_type && left.data === right.data;
}

function sameFile(left: PromptFile, right: PromptFile): boolean {
  return (
    left.name === right.name &&
    left.media_type === right.media_type &&
    left.text === right.text &&
    left.data === right.data &&
    (left.text !== undefined || left.data !== undefined)
  );
}

function subtract<T>(items: T[], overlap: T[], same: (a: T, b: T) => boolean) {
  const remaining = [...overlap];
  return items.filter((item) => {
    const index = remaining.findIndex((other) => same(item, other));
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}

export function subtractDraftAttachments(
  attachments: ComposerDraftAttachments,
  overlap: ComposerDraftAttachments,
): ComposerDraftAttachments {
  return {
    images: subtract(attachments.images, overlap.images, sameImage),
    files: subtract(attachments.files, overlap.files, sameFile),
  };
}

/**
 * Combines what the composer already holds with what the store returned.
 *
 * A restore resolves after other code may have staged attachments for the same
 * draft (a cancelled queued prompt, a host-driven restore). Keep both sides;
 * a filename collision does not mean the payloads are the same.
 * Returns `current` unchanged when the store adds nothing.
 */
export function mergeDraftAttachments(
  current: ComposerDraftAttachments,
  stored: ComposerDraftAttachments,
): ComposerDraftAttachments {
  const additions = subtractDraftAttachments(stored, current);
  const fileNames = new Set(current.files.map((file) => file.name));
  const images = [...current.images, ...additions.images];
  const files = [...current.files];
  for (const file of additions.files) {
    const name = dedupeAttachmentName(file.name, fileNames);
    fileNames.add(name);
    files.push(name === file.name ? file : { ...file, name });
  }
  return images.length === current.images.length &&
    files.length === current.files.length
    ? current
    : { images, files };
}

function isPromptImage(value: unknown): value is PromptImage {
  if (!value || typeof value !== 'object') return false;
  const image = value as Partial<PromptImage>;
  return typeof image.data === 'string' && typeof image.media_type === 'string';
}

function isPromptFile(value: unknown): value is PromptFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as Partial<PromptFile>;
  return typeof file.name === 'string' && typeof file.media_type === 'string';
}

function readStoredAttachments(
  stored: unknown,
): ComposerDraftAttachments | undefined {
  if (!stored || typeof stored !== 'object') return undefined;
  const { images, files } = stored as Partial<ComposerDraftAttachments>;
  return {
    images: Array.isArray(images) ? images.filter(isPromptImage) : [],
    files: Array.isArray(files) ? files.filter(isPromptFile) : [],
  };
}

export function createComposerDraftAttachmentStore(
  idb: IDBFactory | undefined = typeof indexedDB === 'undefined'
    ? undefined
    : indexedDB,
): ComposerDraftAttachmentStore | null {
  if (!idb) return null;
  return {
    async save(key, attachments) {
      try {
        await runIndexedDbRequest(idb, SCHEMA, 'readwrite', (store) =>
          store.put(attachments, key),
        );
        return true;
      } catch {
        // Quota, eviction mid-write, or a partitioned storage context: the
        // draft keeps its text, the attachments simply do not survive.
        return false;
      }
    },
    async load(key) {
      try {
        const stored = await runIndexedDbRequest<unknown>(
          idb,
          SCHEMA,
          'readonly',
          (store) => store.get(key),
        );
        return readStoredAttachments(stored);
      } catch {
        return undefined;
      }
    },
    async delete(key) {
      try {
        await runIndexedDbRequest(idb, SCHEMA, 'readwrite', (store) =>
          store.delete(key),
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}
