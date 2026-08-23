/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { promises as fs, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { getSpecificMimeType } from '@qwen-code/qwen-code-core';

export const SESSION_ATTACHMENT_MAX_ITEM_BYTES = 8 * 1024 * 1024;
const SESSION_ATTACHMENT_MAX_NAME_BYTES = 255;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

// Text the degrade paths substitute for an attachment the model will not receive. The
// SDK's DaemonSessionClient.hydrateBlock and the web shell's degradation
// detection carry their own copies; keep the wording in sync.
export const SESSION_ATTACHMENT_UNAVAILABLE_TEXT =
  '[Attachment is no longer available]';

export class SessionAttachmentReferenceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_session_attachment_reference'
      | 'session_attachment_gone',
  ) {
    super(message);
    this.name = 'SessionAttachmentReferenceError';
  }
}

export interface SessionAttachmentReference {
  type: 'image' | 'resource';
  attachmentId: string;
  mimeType: string;
  size: number;
}

export function isSessionAttachmentReference(
  value: unknown,
): value is SessionAttachmentReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record['type'] === 'image' || record['type'] === 'resource') &&
    typeof record['attachmentId'] === 'string' &&
    record['attachmentId'].length > 0 &&
    typeof record['mimeType'] === 'string' &&
    record['mimeType'].length > 0 &&
    (record['type'] !== 'image' || record['mimeType'].startsWith('image/')) &&
    typeof record['size'] === 'number' &&
    Number.isSafeInteger(record['size']) &&
    record['size'] >= 0 &&
    (record['type'] !== 'image' || record['size'] > 0)
  );
}

function safeAttachmentName(name: string): string | undefined {
  const safeName = path.basename(name.replaceAll('\\', '/')).trim();
  const isWindowsReserved =
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safeName);
  const hasInvalidCharacter = Array.from(safeName).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 0x1f ||
        codePoint === 0x7f ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff))
    );
  });
  return !safeName ||
    safeName === '.' ||
    safeName === '..' ||
    safeName.endsWith('.') ||
    isWindowsReserved ||
    /[<>:"|?*]/.test(safeName) ||
    hasInvalidCharacter ||
    Buffer.byteLength(safeName) > SESSION_ATTACHMENT_MAX_NAME_BYTES
    ? undefined
    : safeName;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function deduplicatedName(name: string, suffix: number): string {
  if (suffix === 0) return name;
  const extension = path.extname(name);
  const suffixText = ` (${suffix})`;
  const stem = name.slice(0, -extension.length || undefined);
  const extensionBudget =
    SESSION_ATTACHMENT_MAX_NAME_BYTES - Buffer.byteLength(suffixText) - 1;
  const safeExtension = truncateUtf8(extension, extensionBudget).replace(
    /[. ]+$/u,
    '',
  );
  const stemBudget =
    SESSION_ATTACHMENT_MAX_NAME_BYTES -
    Buffer.byteLength(suffixText) -
    Buffer.byteLength(safeExtension);
  return `${truncateUtf8(stem, stemBudget)}${suffixText}${safeExtension}`;
}

function imageName(mimeType: string): string {
  const extension = mimeType.slice('image/'.length).split(/[;+]/, 1)[0];
  return `image.${extension === 'jpg' ? 'jpeg' : extension || 'img'}`;
}

function mimeTypeForName(name: string): string {
  if (
    ['.ts', '.mts', '.cts', '.tsx'].includes(path.extname(name).toLowerCase())
  ) {
    return 'text/plain';
  }
  return getSpecificMimeType(name) ?? 'application/octet-stream';
}

function isSupportedImageMimeType(mimeType: string): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType);
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType.endsWith('+json') ||
    mimeType === 'application/xml' ||
    mimeType.endsWith('+xml') ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/typescript' ||
    mimeType === 'application/yaml' ||
    mimeType === 'application/x-yaml' ||
    mimeType === 'application/toml'
  );
}

function isTextAttachment(data: Buffer, mimeType: string): boolean {
  if (isTextMimeType(mimeType)) return true;
  if (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('audio/') ||
    mimeType.startsWith('video/') ||
    mimeType.startsWith('font/') ||
    mimeType === 'application/pdf' ||
    data.includes(0)
  ) {
    return false;
  }
  return Buffer.from(data.toString('utf8'), 'utf8').equals(data);
}

// Append the unavailable marker to the last text block (or as a new text
// block) so a partially degraded prompt keeps its surviving blocks instead of
// collapsing into one wholesale placeholder.
export function withAttachmentDegradationMarker<
  T extends ContentBlock | SessionAttachmentReference,
>(blocks: readonly T[]): T[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type === 'text') {
      if (block.text.endsWith(SESSION_ATTACHMENT_UNAVAILABLE_TEXT)) {
        return [...blocks];
      }
      const next = [...blocks];
      next[i] = {
        type: 'text',
        text: `${block.text}\n${SESSION_ATTACHMENT_UNAVAILABLE_TEXT}`,
      } as T;
      return next;
    }
  }
  return [
    ...blocks,
    { type: 'text', text: SESSION_ATTACHMENT_UNAVAILABLE_TEXT } as T,
  ];
}

export class SessionAttachmentStore {
  private directoryPromise?: Promise<string>;
  private readonly persistentDirectory?: string;
  private activeDirectory?: string;
  private pendingItems = 0;
  private readonly pendingNames = new Map<string, number>();
  private readonly pendingDrainWaiters: Array<() => void> = [];
  private readonly copyDrainWaiters: Array<() => void> = [];
  private copying = false;
  private closing = false;
  private closed = false;

  constructor(
    private readonly directoryRoot?: string,
    sessionId?: string,
  ) {
    if (!directoryRoot || !sessionId) return;
    this.persistentDirectory = path.join(
      directoryRoot,
      `session-${encodeURIComponent(sessionId)}`,
    );
  }

  async putAttachment(
    data: Uint8Array,
    mimeType: string,
    name?: string,
  ): Promise<SessionAttachmentReference> {
    const isImage = isSupportedImageMimeType(mimeType);
    const safeName = safeAttachmentName(
      name ?? (isImage ? imageName(mimeType) : ''),
    );
    if (!safeName) {
      throw new TypeError('Session attachment name is invalid');
    }
    const storedMimeType = mimeTypeForName(safeName);
    if (
      (isImage && storedMimeType !== mimeType) ||
      (isSupportedImageMimeType(storedMimeType) && !isImage)
    ) {
      throw new TypeError('Attachment name and Content-Type do not match');
    }
    if (this.closed || this.closing) {
      throw new Error('Session attachment store is closed');
    }
    if (this.copying) throw new Error('Session attachments are being copied');
    if (
      (isImage && data.byteLength === 0) ||
      data.byteLength > SESSION_ATTACHMENT_MAX_ITEM_BYTES
    ) {
      throw new RangeError(
        `Session attachment must be at most ${SESSION_ATTACHMENT_MAX_ITEM_BYTES} bytes and images cannot be empty`,
      );
    }
    let filePath: string | undefined;
    let pendingName: string | undefined = safeName;
    let removeFileOnFailure = false;
    this.pendingItems += 1;
    this.reservePendingName(safeName);
    try {
      const directory = await this.directory();
      let suffix = 0;
      for (;;) {
        const candidateName = deduplicatedName(safeName, suffix);
        if (safeAttachmentName(candidateName) !== candidateName) {
          throw new TypeError('Session attachment name is invalid');
        }
        if (pendingName !== candidateName) {
          if (pendingName) this.releasePendingName(pendingName);
          this.reservePendingName(candidateName);
          pendingName = candidateName;
        }
        filePath = path.join(directory, candidateName);
        removeFileOnFailure = true;
        try {
          await fs.writeFile(filePath, data, { flag: 'wx' });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          removeFileOnFailure = false;
          this.releasePendingName(candidateName);
          pendingName = undefined;
          filePath = undefined;
          suffix += 1;
        }
      }
      if (this.closed || this.closing) {
        throw new Error('Session attachment store is closed');
      }
      const name = path.basename(filePath);
      const storedMimeType = mimeTypeForName(name);
      const reference = {
        type: isSupportedImageMimeType(storedMimeType)
          ? ('image' as const)
          : ('resource' as const),
        attachmentId: name,
        mimeType: storedMimeType,
        size: data.byteLength,
      } satisfies SessionAttachmentReference;
      return reference;
    } catch (error) {
      if (removeFileOnFailure && filePath) {
        await fs.rm(filePath, { force: true }).catch(() => {});
      }
      throw error;
    } finally {
      if (pendingName) this.releasePendingName(pendingName);
      if (!this.closed) {
        this.pendingItems -= 1;
        if (this.pendingItems === 0) {
          this.resolvePendingDrainWaiters();
        }
      }
    }
  }

  // Validate one block against the store. Ordinary ACP content passes through
  // untouched, matching `assertReferences`.
  assertReference(block: unknown): void {
    if (
      !block ||
      typeof block !== 'object' ||
      Array.isArray(block) ||
      !('attachmentId' in block)
    ) {
      return;
    }
    if (!isSessionAttachmentReference(block)) {
      throw new SessionAttachmentReferenceError(
        'Invalid session attachment reference',
        'invalid_session_attachment_reference',
      );
    }
    this.assertStored(block);
  }

  assertReferences(content: readonly unknown[]): void {
    // One occurrence per attachment: the serializer expands every reference at
    // dispatch, so repeated occurrences of one stored blob amplify the
    // outbound payload without bound even though only one read is needed.
    const seenIds = new Set<string>();
    for (const block of content) {
      if (
        !block ||
        typeof block !== 'object' ||
        Array.isArray(block) ||
        !('attachmentId' in block)
      ) {
        continue;
      }
      if (!isSessionAttachmentReference(block)) {
        throw new SessionAttachmentReferenceError(
          'Invalid session attachment reference',
          'invalid_session_attachment_reference',
        );
      }
      const id = block.attachmentId;
      if (seenIds.has(id)) {
        throw new SessionAttachmentReferenceError(
          `Session attachment referenced more than once: ${id}`,
          'invalid_session_attachment_reference',
        );
      }
      seenIds.add(id);
      this.assertStored(block);
    }
  }

  async resolveContent(
    content: ReadonlyArray<ContentBlock | SessionAttachmentReference>,
    memo?: Map<string, Promise<ContentBlock>>,
  ): Promise<ContentBlock[]> {
    // Resolve each distinct attachment once: duplicate references share the read
    // and base64 encode instead of amplifying heap per occurrence. Callers
    // resolving several messages in one batch can pass a shared `memo` so a
    // attachment referenced from different messages is also read only once.
    const pendingById = memo ?? new Map<string, Promise<ContentBlock>>();
    return await Promise.all(
      content.map(async (block) => {
        if (!isSessionAttachmentReference(block)) return block;
        const id = block.attachmentId;
        let pending = pendingById.get(id);
        if (!pending) {
          const created = this.resolve(block);
          pendingById.set(id, created);
          // A transient read failure must not poison later resolutions of the
          // same attachment: a cached rejection would hand every sibling message
          // (and every later lookup) the failure although the store still
          // holds the bytes. Evict it so the next lookup reads again.
          void created.catch(() => {
            if (pendingById.get(id) === created) {
              pendingById.delete(id);
            }
          });
          pending = created;
        }
        return await pending;
      }),
    );
  }

  // Per-block variant of `resolveContent` for degrade paths: one unresolvable
  // reference drops only itself, keeping the sibling blocks a wholesale
  // fallback would discard. Other errors still propagate.
  async resolveContentDegrading(
    content: ReadonlyArray<ContentBlock | SessionAttachmentReference>,
    memo?: Map<string, Promise<ContentBlock>>,
  ): Promise<{
    retainedBlocks: Array<ContentBlock | SessionAttachmentReference>;
    resolvedBlocks: ContentBlock[];
    degraded: number;
  }> {
    const retainedBlocks: Array<ContentBlock | SessionAttachmentReference> = [];
    const resolvedBlocks: ContentBlock[] = [];
    let degraded = 0;
    for (const block of content) {
      if (!isSessionAttachmentReference(block)) {
        retainedBlocks.push(block);
        resolvedBlocks.push(block);
        continue;
      }
      try {
        const [resolved] = await this.resolveContent([block], memo);
        if (resolved) resolvedBlocks.push(resolved);
        retainedBlocks.push(block);
      } catch (error) {
        if (!(error instanceof SessionAttachmentReferenceError)) throw error;
        degraded += 1;
      }
    }
    return { retainedBlocks, resolvedBlocks, degraded };
  }

  async read(
    attachmentId: string,
  ): Promise<{ data: Buffer; mimeType: string } | undefined> {
    const name = safeAttachmentName(attachmentId);
    if (!name || name !== attachmentId) return undefined;
    const filePath = path.join(await this.directory(), name);
    try {
      return {
        data: await fs.readFile(filePath),
        mimeType: mimeTypeForName(name),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async copyFrom(source: SessionAttachmentStore): Promise<void> {
    if (source === this) return;
    if (this.closed || this.closing) {
      throw new Error('Session attachment store is closed');
    }
    if (this.copying) throw new Error('Session attachments are being copied');
    if (source.closed || source.closing) {
      throw new Error('Session attachment store is closed');
    }
    if (source.copying) {
      throw new Error('Session attachments are being copied');
    }
    this.copying = true;
    source.copying = true;
    try {
      if (this.pendingItems > 0) {
        await new Promise<void>((resolve) =>
          this.pendingDrainWaiters.push(resolve),
        );
      }
      if (source.pendingItems > 0) {
        await new Promise<void>((resolve) =>
          source.pendingDrainWaiters.push(resolve),
        );
      }
      if (this.closed) throw new Error('Session attachment store is closed');
      const sourceDirectory =
        source.persistentDirectory ?? source.activeDirectory;
      if (!sourceDirectory) return;
      let entries;
      try {
        entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const targetDirectory = await this.directory();
      await Promise.all(
        entries
          .filter(
            (entry) => entry.isFile() && !source.pendingNames.has(entry.name),
          )
          .map(async (entry) => {
            const sourcePath = path.join(sourceDirectory, entry.name);
            try {
              await fs.copyFile(
                sourcePath,
                path.join(targetDirectory, entry.name),
              );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                try {
                  await fs.stat(sourcePath);
                } catch (sourceError) {
                  if (
                    (sourceError as NodeJS.ErrnoException).code === 'ENOENT'
                  ) {
                    return;
                  }
                }
              }
              throw error;
            }
          }),
      );
    } finally {
      source.copying = false;
      this.copying = false;
      source.resolveCopyDrainWaiters();
      this.resolveCopyDrainWaiters();
    }
  }

  async remove(attachmentId: string): Promise<boolean> {
    const name = safeAttachmentName(attachmentId);
    if (
      !name ||
      name !== attachmentId ||
      this.copying ||
      this.pendingNames.has(name)
    ) {
      return false;
    }
    const directory = await this.directory();
    const filePath = path.join(directory, name);
    try {
      await fs.unlink(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.waitForCopy();
    if (this.closed) return;
    this.closed = true;
    this.pendingItems = 0;
    this.pendingNames.clear();
    this.resolvePendingDrainWaiters();
    if (this.persistentDirectory || !this.directoryPromise) return;
    const directory = await this.directoryPromise.catch(() => undefined);
    if (!directory) return;
    await fs.rm(directory, { recursive: true, force: true });
  }

  async delete(options: { assertCanCommit?: () => void } = {}): Promise<void> {
    options.assertCanCommit?.();
    this.closing = true;
    await this.waitForCopy();
    options.assertCanCommit?.();
    if (!this.closed) {
      this.closed = true;
      this.pendingItems = 0;
      this.pendingNames.clear();
      this.resolvePendingDrainWaiters();
    }
    const directory =
      this.persistentDirectory ??
      (await this.directoryPromise?.catch(() => undefined));
    if (directory) {
      options.assertCanCommit?.();
      const tombstone = path.join(
        path.dirname(directory),
        `.${path.basename(directory)}.deleting-${randomUUID()}`,
      );
      try {
        await fs.rename(directory, tombstone);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      await fs.rm(tombstone, { recursive: true, force: true });
    }
  }

  private assertStored(reference: SessionAttachmentReference): void {
    const id = reference.attachmentId;
    const name = safeAttachmentName(id);
    let size: number | undefined;
    const directory = this.persistentDirectory ?? this.activeDirectory;
    if (name && name === id && directory) {
      try {
        size = statSync(path.join(directory, name)).size;
      } catch {
        size = undefined;
      }
    }
    const storedMimeType = name ? mimeTypeForName(name) : undefined;
    const storedType = storedMimeType
      ? isSupportedImageMimeType(storedMimeType)
        ? 'image'
        : 'resource'
      : undefined;
    if (
      size !== reference.size ||
      storedMimeType !== reference.mimeType ||
      storedType !== reference.type
    ) {
      throw new SessionAttachmentReferenceError(
        `Unknown or unavailable session attachment: ${id}`,
        'session_attachment_gone',
      );
    }
  }

  private releasePendingName(name: string): void {
    const count = this.pendingNames.get(name) ?? 0;
    if (count <= 1) this.pendingNames.delete(name);
    else this.pendingNames.set(name, count - 1);
  }

  private reservePendingName(name: string): void {
    this.pendingNames.set(name, (this.pendingNames.get(name) ?? 0) + 1);
  }

  private async waitForCopy(): Promise<void> {
    while (this.copying) {
      await new Promise<void>((resolve) => this.copyDrainWaiters.push(resolve));
    }
  }

  private resolveCopyDrainWaiters(): void {
    for (const resolve of this.copyDrainWaiters.splice(0)) resolve();
  }

  private resolvePendingDrainWaiters(): void {
    for (const resolve of this.pendingDrainWaiters.splice(0)) resolve();
  }

  private async resolve(
    reference: SessionAttachmentReference,
  ): Promise<ContentBlock> {
    const id = reference.attachmentId;
    const attachment = await this.read(id);
    if (!attachment) {
      throw new SessionAttachmentReferenceError(
        `Unknown or unavailable session attachment: ${id}`,
        'session_attachment_gone',
      );
    }
    if (reference.type === 'resource') {
      const resource = {
        uri: `attachment:///${encodeURIComponent(reference.attachmentId)}`,
        mimeType: attachment.mimeType,
        ...(isTextAttachment(attachment.data, attachment.mimeType)
          ? { text: attachment.data.toString('utf8') }
          : { blob: attachment.data.toString('base64') }),
      };
      return {
        type: 'resource',
        resource,
      } as ContentBlock;
    }
    return {
      type: 'image',
      data: attachment.data.toString('base64'),
      mimeType: attachment.mimeType,
    } as ContentBlock;
  }

  private async directory(): Promise<string> {
    if (!this.directoryPromise) {
      const pending = this.persistentDirectory
        ? fs
            .mkdir(this.persistentDirectory, {
              recursive: true,
              mode: 0o700,
            })
            .then(() => this.persistentDirectory!)
        : this.directoryRoot
          ? fs
              .mkdir(this.directoryRoot, { recursive: true, mode: 0o700 })
              .then(() =>
                fs.mkdtemp(
                  path.join(this.directoryRoot!, 'session-attachment-'),
                ),
              )
          : fs.mkdtemp(path.join(tmpdir(), 'qwen-session-attachment-'));
      const directoryPromise = pending.then((directory) => {
        this.activeDirectory = directory;
        return directory;
      });
      this.directoryPromise = directoryPromise;
      void directoryPromise.catch(() => {
        if (this.directoryPromise === directoryPromise)
          this.directoryPromise = undefined;
      });
    }
    return await this.directoryPromise;
  }
}
