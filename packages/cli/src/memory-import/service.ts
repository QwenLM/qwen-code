/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { getImportedProjectMemoryRoot } from '@qwen-code/qwen-code-core/memory/import-paths.js';
import {
  getUserAutoMemoryRoot,
  getMemoryRootTrustedAnchor,
} from '@qwen-code/qwen-code-core/memory/paths.js';
import {
  scanAutoMemorySnapshot,
  parseAutoMemoryTopicDocument,
} from '@qwen-code/qwen-code-core/memory/structured-scan.js';
import {
  tokenizeMemoryRecallTerms,
  tokenizeMemoryRecallText,
} from '@qwen-code/qwen-code-core/memory/recall.js';
import { rebuildAutoMemoryIndexAtRoot } from '@qwen-code/qwen-code-core/memory/indexer.js';
import {
  validateMemoryImportBatchProposal,
  memoryImportReservation,
  type MemoryImportBatchProposal,
  type MemoryImportModelInput,
  type MemoryImportProposal,
} from '@qwen-code/qwen-code-core/memory/import-model.js';
import {
  MEMORY_IMPORT_BUDGET,
  packMemoryImportSections,
} from '@qwen-code/qwen-code-core/memory/import-budget.js';
import { resolveTrustedMemoryFile } from '@qwen-code/qwen-code-core/memory/trusted-memory-filesystem.js';
import {
  digest,
  previewSource,
  MemoryImportRequestError,
  type ImportSection,
} from './source.js';

export class MemoryImportNotFoundError extends Error {
  readonly code = 'ENOENT';
}

type Scope = 'project' | 'user';
export interface ImportSelection {
  id: string;
  scope: Scope;
}
export interface ImportItemResult {
  id: string;
  scope: Scope;
  status: 'pending' | 'added' | 'duplicate' | 'conflict' | 'skipped' | 'failed';
  reason?: string;
  refs?: string[];
}
export interface ImportTask {
  version: 1;
  kind: 'task';
  id: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  items: ImportItemResult[];
  usage: { modelCalls: number; reservedTokens: number };
  budget: { maxCalls: number; maxReservedTokens: number };
  result?: {
    sourceSections: number;
    newDocuments: number;
    duplicateSections: number;
    conflictSections: number;
    failedSections: number;
  };
}
interface StoredTask extends ImportTask {
  requestDigest: string;
}
interface PreparedBatch {
  baseline: Array<{ ref: string; digest: string }>;
  scope: Scope;
  sections: Array<{ id: string; key: string }>;
  proposal: MemoryImportBatchProposal;
}
class ImportBudgetError extends Error {}
class ImportContextError extends Error {}
interface RetainedSource {
  sections: Array<ImportSection & { scope: Scope }>;
}
interface LedgerRecord {
  batchId: string;
  phase: 'intent' | 'committed';
  outputs: Array<{ relativePath: string; digest: string; bodyDigest: string }>;
  stage: string;
  memoryVersion?: string;
  outcome: ImportItemResult;
}
type Ledger = Record<string, LedgerRecord>;
const heldLocks = new AsyncLocalStorage<AbortSignal>();
export interface ImportServiceOptions {
  projectRoot: string;
  assertActive: () => void;
  propose: (
    input: MemoryImportModelInput,
    signal: AbortSignal,
  ) => Promise<MemoryImportBatchProposal>;
}
const exists = async (file: string) =>
  fs.lstat(file).then(
    () => true,
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    },
  );

// Reject symlinked runtime state before reading or publishing private sources.
async function privateDirectory(
  directory: string,
  anchor: string,
): Promise<void> {
  const relative = path.relative(anchor, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Import path escapes runtime.');
  let current = anchor;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    await fs.mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Import runtime directory must not be a symlink.');
  }
}
async function readJson<T>(file: string): Promise<T> {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw new Error('Invalid import state file.');
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > stat.size)
      throw new Error('Import state exceeds the supported limit.');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as T;
  } finally {
    await handle.close();
  }
}
async function writeJson(file: string, value: unknown): Promise<void> {
  heldLocks.getStore()?.throwIfAborted();
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  try {
    heldLocks.getStore()?.throwIfAborted();
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
async function abortable<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Import cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work(), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
function publicTask(task: StoredTask): ImportTask {
  const { requestDigest: _requestDigest, ...result } = task;
  return structuredClone({
    ...result,
    usage: task.usage ?? { modelCalls: 0, reservedTokens: 0 },
    budget: task.budget ?? { maxCalls: 0, maxReservedTokens: 0 },
    result: {
      sourceSections: task.items.length,
      newDocuments: task.items
        .filter((item) => item.status === 'added')
        .reduce((n, item) => n + (item.refs?.length ?? 0), 0),
      duplicateSections: task.items.filter(
        (item) => item.status === 'duplicate',
      ).length,
      conflictSections: task.items.filter((item) => item.status === 'conflict')
        .length,
      failedSections: task.items.filter((item) => item.status === 'failed')
        .length,
    },
  });
}
function selectImportContext(
  existing: MemoryImportModelInput['existing'],
  sources: readonly string[],
): MemoryImportModelInput['existing'] {
  const queries = sources.map((source) => ({
    text: source.normalize('NFKC').toLowerCase(),
    terms: tokenizeMemoryRecallTerms(source),
  }));
  const index = existing.map((item) => {
    const parsed = parseAutoMemoryTopicDocument('existing.md', item.content);
    if (!parsed)
      throw new ImportContextError(
        'Existing memory has no bounded metadata index. Repair its native metadata before importing.',
      );
    const metadata = JSON.stringify({
      name: parsed.title,
      description: parsed.description,
      type: parsed.type,
      category: parsed.category,
      keywords: parsed.keywords,
      usage_scenarios: parsed.usageScenarios,
    });
    const words = tokenizeMemoryRecallText(
      [parsed.title, ...parsed.keywords].join(' '),
    );
    const anchors = [parsed.title, parsed.description]
      .map((text) => text.normalize('NFKC').toLowerCase().trim())
      .filter((text) => tokenizeMemoryRecallText(text).length >= 2);
    const body = parsed.body.normalize('NFKC').toLowerCase().trim();
    const relevant = queries.some(({ text, terms }) => {
      if (
        anchors.some((anchor) => text.includes(anchor)) ||
        (body.length > 0 && text.includes(body))
      )
        return true;
      const shared = words.filter((word) => terms.has(word));
      return shared.length >= 2 && shared.length >= words.length / 2;
    });
    return {
      ref: item.ref,
      content: relevant ? item.content : metadata,
      indexOnly: !relevant,
    };
  });
  // Relevant full documents are evidence; index-only metadata is an index.
  // Keep the evidence first, then admit index entries while the serialized
  // context fits. Relevant evidence that cannot fit still fails closed.
  const context: MemoryImportModelInput['existing'] = [];
  let bytes = 2;
  for (const entry of [
    ...index.filter((item) => !item.indexOnly),
    ...index.filter((item) => item.indexOnly),
  ]) {
    const size =
      Buffer.byteLength(JSON.stringify(entry)) + (context.length ? 1 : 0);
    if (bytes + size > MEMORY_IMPORT_BUDGET.contextBytes) {
      if (!entry.indexOnly)
        throw new ImportContextError(
          'Relevant existing evidence exceeds the 32 KiB import context budget. Select a narrower source group or consolidate existing memory before retrying. No model call was made.',
        );
      continue;
    }
    bytes += size;
    context.push(entry);
  }
  return context;
}

function respectsImportScope(
  proposal: MemoryImportProposal,
  scope: Scope,
): boolean {
  return (
    scope !== 'user' ||
    proposal.documents.every((content) => {
      const type = parseAutoMemoryTopicDocument('import.md', content)?.type;
      return type === 'user' || type === 'feedback';
    })
  );
}

export class MemoryImportService {
  private readonly base = Storage.getRuntimeBaseDir();
  private readonly state = path.join(this.base, 'memory-import');
  private readonly owner: string;
  private readonly workers = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly options: ImportServiceOptions) {
    this.owner = digest(path.resolve(options.projectRoot));
  }
  private async readState<T>(file: string): Promise<T> {
    const relative = path.relative(this.base, path.dirname(file));
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Import state escapes runtime.');
    let current = this.base;
    for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Invalid import state directory.');
    }
    return readJson<T>(file);
  }
  private taskDir(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new MemoryImportRequestError('Invalid import batch ID.');
    return path.join(this.state, 'batches', this.owner, id);
  }
  // Private sources must never be written into a Git checkout, even when a
  // runtime environment variable points into one. Admission (submit/retry via
  // prepare) and recovery both enforce this before any batch is kicked.
  private async assertRuntimeOutsideGit(): Promise<void> {
    let current = path.resolve(this.base);
    while (true) {
      if (await exists(path.join(current, '.git')))
        throw new Error(
          'Memory import requires a runtime directory outside Git checkouts.',
        );
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    await fs.mkdir(this.base, { recursive: true, mode: 0o700 });
    current = await fs.realpath(this.base);
    while (true) {
      if (await exists(path.join(current, '.git')))
        throw new Error(
          'Memory import requires a private runtime outside Git checkouts.',
        );
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  private async prepare(): Promise<void> {
    this.options.assertActive();
    await this.assertRuntimeOutsideGit();
    await privateDirectory(
      path.join(this.state, 'batches', this.owner),
      this.base,
    );
  }
  private async locked<T>(
    directory: string,
    run: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await privateDirectory(directory, this.base);
    const ownership = new AbortController();
    const parent = heldLocks.getStore();
    const held = parent
      ? AbortSignal.any([parent, ownership.signal])
      : ownership.signal;
    // Cancellation may persist a terminal status; losing ownership may not.
    const work = signal ? AbortSignal.any([signal, held]) : held;
    let release: (() => Promise<void>) | undefined;
    while (!release) {
      work.throwIfAborted();
      this.options.assertActive();
      try {
        release = await lockfile.lock(directory, {
          realpath: false,
          stale: 120_000,
          update: 10_000,
          retries: 0,
          onCompromised: () => {
            ownership.abort(new Error('Import lock lost.'));
          },
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    try {
      work.throwIfAborted();
      const result = await heldLocks.run(held, () => run(work));
      held.throwIfAborted();
      return result;
    } finally {
      try {
        if (!ownership.signal.aborted) await release();
      } finally {
        ownership.abort(new Error('Import lock released.'));
      }
    }
  }
  async submit(
    input: unknown,
    selections: unknown,
    key: unknown,
  ): Promise<ImportTask> {
    this.options.assertActive();
    const preview = previewSource(input);
    if (
      typeof key !== 'string' ||
      !/^[\w-]{1,128}$/.test(key) ||
      !Array.isArray(selections) ||
      !selections.length ||
      selections.length > 2048
    )
      throw new MemoryImportRequestError(
        'Provide an idempotency key and explicit non-empty selection.',
      );
    const seen = new Set<string>();
    const selected = selections
      .map((value: unknown) => {
        if (!value || typeof value !== 'object')
          throw new MemoryImportRequestError('Invalid selection.');
        const selection = value as ImportSelection;
        const section = preview.sections.find(
          (item) => item.id === selection.id && item.selectable,
        );
        if (
          !section ||
          seen.has(selection.id) ||
          !['project', 'user'].includes(selection.scope)
        )
          throw new MemoryImportRequestError(
            'Invalid, duplicate or unavailable section selection.',
          );
        seen.add(selection.id);
        return { ...section, scope: selection.scope };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const retained = JSON.stringify({ sections: selected });
    if (Buffer.byteLength(retained) > 16 * 1024 * 1024)
      throw new MemoryImportRequestError(
        'Selected contextual source exceeds the retained snapshot limit.',
      );
    const requestDigest = digest(JSON.stringify(selected));
    const id = digest(`${this.owner}\0${key}`);
    await this.prepare();
    const dir = this.taskDir(id);
    return this.locked(
      path.join(this.state, 'admission', this.owner),
      async () => {
        this.options.assertActive();
        if (await exists(path.join(dir, 'task.json'))) {
          const task = await this.readState<StoredTask>(
            path.join(dir, 'task.json'),
          );
          if (task.requestDigest !== requestDigest)
            throw new MemoryImportRequestError(
              'Idempotency key was already used with a different selection.',
            );
          this.kick(id);
          return publicTask(task);
        }
        await privateDirectory(dir, this.base);
        await writeJson(path.join(dir, 'source.json'), { sections: selected });
        const now = new Date().toISOString();
        const task: StoredTask = {
          version: 1,
          kind: 'task',
          id,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
          requestDigest,
          usage: { modelCalls: 0, reservedTokens: 0 },
          budget: {
            maxCalls: MEMORY_IMPORT_BUDGET.maxCalls,
            maxReservedTokens: MEMORY_IMPORT_BUDGET.maxReservedTokens,
          },
          items: selected.map((section) => ({
            id: section.id,
            scope: section.scope,
            status: 'pending',
          })),
        };
        await writeJson(path.join(dir, 'task.json'), task);
        this.kick(id);
        return publicTask(task);
      },
    );
  }
  private kick(id: string): void {
    if (this.workers.has(id)) return;
    // A worker owns its task lock independently of submit's admission lock.
    const worker = heldLocks
      .exit(() => this.run(id))
      .catch(() => {
        /* Durable state is retained for retry/recovery. */
      })
      .finally(() => {
        this.workers.delete(id);
        this.controllers.delete(id);
      });
    this.workers.set(id, worker);
  }
  async recover(): Promise<void> {
    this.options.assertActive();
    const root = path.join(this.state, 'batches', this.owner);
    if (!(await exists(root))) return;
    await this.assertRuntimeOutsideGit();
    await privateDirectory(root, this.base);
    for (const id of (await fs.readdir(root)).filter((id) =>
      /^[a-f0-9]{64}$/.test(id),
    )) {
      // Isolate a damaged batch: one unreadable task must not stop the
      // recovery of its siblings. The damaged batch stays on disk for an
      // explicit retry/status call to report.
      const task = await this.readState<StoredTask>(
        path.join(this.taskDir(id), 'task.json'),
      ).catch(() => undefined);
      if (task && (task.status === 'running' || task.status === 'queued'))
        this.kick(id);
    }
  }
  async list(): Promise<ImportTask[]> {
    this.options.assertActive();
    const root = path.join(this.state, 'batches', this.owner);
    if (!(await exists(root))) return [];
    await privateDirectory(root, this.base);
    const result: ImportTask[] = [];
    for (const id of (await fs.readdir(root)).filter((id) =>
      /^[a-f0-9]{64}$/.test(id),
    )) {
      // Skip a damaged batch rather than failing the whole listing; its
      // explicit status call still reports the storage failure.
      const task = await this.get(id).catch(() => undefined);
      if (task) result.push(task);
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async get(id: string): Promise<ImportTask> {
    this.options.assertActive();
    const task = await this.readState<StoredTask>(
      path.join(this.taskDir(id), 'task.json'),
    ).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
        throw new MemoryImportNotFoundError('Import batch not found.', {
          cause,
        });
      throw cause;
    });
    if (
      task.status !== 'completed' &&
      (await exists(path.join(this.taskDir(id), 'cancel.json')))
    )
      task.status = 'cancelled';
    return publicTask(task);
  }

  async source(id: string, sectionId: string): Promise<ImportSection> {
    await this.get(id);
    const source = await this.readState<RetainedSource>(
      path.join(this.taskDir(id), 'source.json'),
    );
    const section = source.sections.find((item) => item.id === sectionId);
    if (!section)
      throw new MemoryImportRequestError(
        'Source section not found in this batch.',
      );
    return section;
  }
  async cancel(id: string): Promise<ImportTask> {
    this.options.assertActive();
    this.controllers.get(id)?.abort();
    const task = await this.get(id);
    if (task.status === 'completed') return task;
    await writeJson(path.join(this.taskDir(id), 'cancel.json'), {
      cancelled: true,
    });
    this.controllers.get(id)?.abort();
    await this.workers.get(id);
    return this.get(id);
  }

  async retry(id: string): Promise<ImportTask> {
    await this.get(id);
    await this.prepare();
    // A worker registered by submit() or a previous retry is still running:
    // wait for it instead of returning early, otherwise explicit retry loses
    // the race and failed items stay unpromoted.
    await this.workers.get(id);
    const dir = this.taskDir(id);
    const result = await this.locked(dir, async () => {
      const task = await this.readState<StoredTask>(
        path.join(dir, 'task.json'),
      );
      if (task.status === 'completed') return publicTask(task);
      await fs.rm(path.join(dir, 'cancel.json'), { force: true });
      for (const item of task.items)
        if (item.status === 'failed') {
          item.status = 'pending';
          delete item.reason;
        }
      task.status = 'queued';
      task.updatedAt = new Date().toISOString();
      await writeJson(path.join(dir, 'task.json'), task);
      return publicTask(task);
    });
    this.kick(id);
    return result;
  }
  async idle(id: string): Promise<ImportTask> {
    await this.workers.get(id);
    return this.get(id);
  }
  private async run(id: string): Promise<void> {
    const dir = this.taskDir(id);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    await this.locked(
      dir,
      async (signal) => {
        const task = await this.readState<StoredTask>(
          path.join(dir, 'task.json'),
        );
        if (!['queued', 'running'].includes(task.status)) return;
        const source = await this.readState<RetainedSource>(
          path.join(dir, 'source.json'),
        );
        if (!task.usage) {
          task.usage = { modelCalls: 0, reservedTokens: 0 };
          task.budget = { maxCalls: 0, maxReservedTokens: 0 };
        }
        task.budget ??= { maxCalls: 0, maxReservedTokens: 0 };
        task.status = 'running';
        await writeJson(path.join(dir, 'task.json'), task);
        for (const section of packMemoryImportSections(
          source.sections,
        ).flat()) {
          const item = task.items.find((item) => item.id === section.id)!;
          if (item.status !== 'pending') continue;
          if (await exists(path.join(dir, 'cancel.json'))) controller.abort();
          if (controller.signal.aborted) break;
          try {
            this.options.assertActive();
            Object.assign(
              item,
              await this.importSection(
                section,
                id,
                signal,
                (before, ledger, proposalSignal) =>
                  this.prepareProposal(
                    section,
                    source,
                    task,
                    before,
                    ledger,
                    proposalSignal,
                  ),
                async () => {
                  if (await exists(path.join(dir, 'cancel.json')))
                    controller.abort();
                  controller.signal.throwIfAborted();
                  this.options.assertActive();
                },
              ),
            );
          } catch (error) {
            if (controller.signal.aborted) break;
            item.status = 'failed';
            item.reason =
              error instanceof ImportBudgetError ||
              error instanceof ImportContextError
                ? error.message
                : 'Import could not finish. Existing memories were preserved; retry after resolving runtime, model or storage availability.';
          }
          task.updatedAt = new Date().toISOString();
          await writeJson(path.join(dir, 'task.json'), task);
        }
        task.status = controller.signal.aborted
          ? 'cancelled'
          : task.items.some((item) => item.status === 'failed')
            ? 'partial'
            : 'completed';
        task.updatedAt = new Date().toISOString();
        await writeJson(path.join(dir, 'task.json'), task);
      },
      controller.signal,
    );
  }
  private async prepareProposal(
    section: ImportSection & { scope: Scope },
    source: RetainedSource,
    task: StoredTask,
    before: { existing: MemoryImportModelInput['existing'] },
    ledger: Ledger,
    signal: AbortSignal,
  ): Promise<MemoryImportProposal> {
    const dir = this.taskDir(task.id);
    const journalFile = path.join(dir, 'proposals.json');
    const journals = (await exists(journalFile))
      ? await this.readState<PreparedBatch[]>(journalFile)
      : [];
    let journal = journals.find(
      (entry) =>
        entry.scope === section.scope &&
        entry.sections.some((item) => item.id === section.id),
    );
    if (
      journal &&
      !respectsImportScope(
        journal.proposal.items.find((item) => item.id === section.id)!,
        section.scope,
      )
    ) {
      // Older tasks could retain a response before enforcing its scope. Keep
      // sibling decisions and their baseline; only the invalid item is retried.
      journal.sections = journal.sections.filter(
        (item) => item.id !== section.id,
      );
      journal.proposal.items = journal.proposal.items.filter(
        (item) => item.id !== section.id,
      );
      if (!journal.sections.length)
        journals.splice(journals.indexOf(journal), 1);
      await writeJson(journalFile, journals);
      journal = undefined;
    }
    if (!journal) {
      const eligible = source.sections.filter(
        (candidate) =>
          candidate.scope === section.scope &&
          candidate.groupId === section.groupId &&
          task.items.some(
            (item) => item.id === candidate.id && item.status === 'pending',
          ) &&
          !ledger[candidate.id] &&
          !journals.some((entry) =>
            entry.sections.some((item) => item.id === candidate.id),
          ),
      );
      const batch = packMemoryImportSections(eligible).find((items) =>
        items.some((item) => item.id === section.id),
      );
      if (!batch) throw new Error('Source batch is unavailable.');
      const input: MemoryImportModelInput = {
        scope: section.scope,
        sources: batch.map(({ id, content }) => ({ id, content })),
        existing: selectImportContext(
          before.existing,
          batch.map((item) => item.content),
        ),
      };
      const reserved = memoryImportReservation(input);
      if (
        task.usage.modelCalls >=
          Math.min(task.budget.maxCalls, MEMORY_IMPORT_BUDGET.maxCalls) ||
        task.usage.reservedTokens + reserved >
          Math.min(
            task.budget.maxReservedTokens,
            MEMORY_IMPORT_BUDGET.maxReservedTokens,
          )
      )
        throw new ImportBudgetError(
          'Import budget exhausted. Retry preserves this budget; split remaining sources into an explicitly confirmed new task.',
        );
      signal.throwIfAborted();
      task.usage.modelCalls++;
      task.usage.reservedTokens += reserved;
      await writeJson(path.join(dir, 'task.json'), task);
      let proposal: MemoryImportBatchProposal;
      try {
        proposal = validateMemoryImportBatchProposal(
          await abortable(signal, () => this.options.propose(input, signal)),
          batch.map((item) => item.id),
        );
        if (
          proposal.items.some(
            (item) => !respectsImportScope(item, section.scope),
          )
        )
          throw new ImportContextError(
            'Model returned project knowledge for user memory. Retry to request a scope-valid response; consumed budget is retained.',
          );
      } catch (error) {
        if (!signal.aborted)
          for (const item of task.items)
            if (batch.some((section) => section.id === item.id)) {
              item.status = 'failed';
              item.reason =
                'Model batch failed validation or execution; explicit retry retains its consumed budget.';
            }
        throw error;
      }
      signal.throwIfAborted();
      journal = {
        scope: section.scope,
        sections: batch.map((item) => ({
          id: item.id,
          key: item.id,
        })),
        baseline: before.existing.map((item) => ({
          ref: item.ref,
          digest: digest(item.content),
        })),
        proposal,
      };
      journals.push(journal);
      await writeJson(journalFile, journals);
    }
    const expected = new Map(
      journal.baseline.map((item) => [item.ref, item.digest]),
    );
    for (const record of Object.values(ledger)) {
      if (record.phase === 'committed')
        for (const output of record.outputs) {
          const ref = `${section.scope}:${output.relativePath}`;
          if (!expected.has(ref)) expected.set(ref, output.digest);
        }
    }
    if (
      expected.size !== before.existing.length ||
      before.existing.some(
        (item) => expected.get(item.ref) !== digest(item.content),
      )
    )
      return {
        decision: 'conflict',
        reason:
          'Existing memory changed since this batch was consolidated; retained proposals cannot overwrite edits or restore forgotten knowledge.',
        documents: [],
      };
    return journal.proposal.items.find((item) => item.id === section.id)!;
  }
  private async snapshot(scope: Scope): Promise<{
    version: string;
    existing: MemoryImportModelInput['existing'];
  }> {
    const snapshot = await scanAutoMemorySnapshot(this.options.projectRoot, {
      scopes: [scope],
      trustedProject: true,
      uncapped: true,
    });
    if (!snapshot.sourceStatus.complete)
      throw new Error('Existing memory scan is incomplete.');
    const existing: MemoryImportModelInput['existing'] = [];
    for (const doc of snapshot.docs)
      existing.push({
        ref: `${scope}:${doc.relativePath}`,
        content: await fs.readFile(doc.filePath, 'utf8'),
      });
    existing.sort((a, b) => a.ref.localeCompare(b.ref));
    return { version: digest(JSON.stringify(existing)), existing };
  }
  private async importSection(
    section: ImportSection & { scope: Scope },
    batchId: string,
    signal: AbortSignal,
    propose: (
      before: { existing: MemoryImportModelInput['existing'] },
      ledger: Ledger,
      signal: AbortSignal,
    ) => Promise<MemoryImportProposal>,
    assertCommit: () => Promise<void>,
  ): Promise<ImportItemResult> {
    const root =
      section.scope === 'user'
        ? getUserAutoMemoryRoot()
        : getImportedProjectMemoryRoot(this.options.projectRoot, true);
    const scopeState = path.join(this.state, 'scopes', digest(root));
    return this.locked(
      scopeState,
      async (signal) => {
        signal.throwIfAborted();
        this.options.assertActive();
        if ((await exists(root)) && (await fs.lstat(root)).isSymbolicLink())
          throw new ImportContextError(
            'Memory import does not support a symlinked memory root. Use a non-symlink memory root before retrying; existing memories were not changed.',
          );
        const ledgerPath = path.join(scopeState, 'ledger.json');
        const ledger: Ledger = (await exists(ledgerPath))
          ? await this.readState(ledgerPath)
          : {};
        const key = section.id;
        let previous: LedgerRecord | undefined = ledger[key];
        const discardUnpublishedIntent = async (stage: string) => {
          signal.throwIfAborted();
          this.options.assertActive();
          delete ledger[key];
          await writeJson(ledgerPath, ledger);
          heldLocks.getStore()?.throwIfAborted();
          await fs.rm(stage, { recursive: true, force: true });
        };
        const outcome = (
          status: ImportItemResult['status'],
          reason?: string,
        ): ImportItemResult => ({
          id: section.id,
          scope: section.scope,
          status,
          ...(reason ? { reason } : {}),
        });
        if (previous?.phase === 'intent') {
          const stage = path.join(scopeState, previous.stage);
          if (
            (await exists(stage)) &&
            !(await exists(path.join(root, 'imported', key))) &&
            (await this.snapshot(section.scope)).version !==
              previous.memoryVersion
          ) {
            await discardUnpublishedIntent(stage);
            previous = undefined;
          }
        }
        if (previous) {
          const stage = path.join(scopeState, previous.stage);
          const destination = path.join(root, 'imported', key);
          if (
            previous.phase === 'intent' &&
            (await exists(stage)) &&
            !(await exists(destination))
          ) {
            for (const output of previous.outputs) {
              const file = path.join(stage, path.basename(output.relativePath));
              if (digest(await fs.readFile(file, 'utf8')) !== output.digest)
                throw new Error('Invalid staged import.');
            }
            signal.throwIfAborted();
            this.options.assertActive();
            await privateDirectory(path.join(root, 'imported'), this.base);
            signal.throwIfAborted();
            this.options.assertActive();
            await assertCommit();
            heldLocks.getStore()?.throwIfAborted();
            await fs.rename(stage, destination);
          }
          for (const output of previous.outputs) {
            const file = await resolveTrustedMemoryFile(
              root,
              getMemoryRootTrustedAnchor(root),
              output.relativePath,
            );
            if (
              !file ||
              digest(await fs.readFile(file, 'utf8')) !== output.digest
            )
              return outcome(
                'conflict',
                'Previously imported memory was edited or forgotten; it will not be restored.',
              );
          }
          previous.phase = 'committed';
          await writeJson(ledgerPath, ledger);
          await rebuildAutoMemoryIndexAtRoot(root, section.scope);
          if (previous.batchId === batchId)
            return {
              ...previous.outcome,
              id: section.id,
              scope: section.scope,
            };
          return outcome(
            previous.outcome.status === 'added'
              ? 'duplicate'
              : previous.outcome.status,
            'This source has already been processed.',
          );
        }
        const before = await this.snapshot(section.scope);
        const proposal = await propose(before, ledger, signal);
        signal.throwIfAborted();
        this.options.assertActive();
        if ((await this.snapshot(section.scope)).version !== before.version)
          return outcome(
            'conflict',
            'Existing memory changed during consolidation; preview and retry the source.',
          );
        await assertCommit();
        if (proposal.decision === 'conflict')
          return outcome('conflict', proposal.reason);
        if (proposal.decision !== 'new') {
          const result = outcome(
            proposal.decision === 'skip' ? 'skipped' : 'duplicate',
            proposal.reason,
          );
          ledger[key] = {
            batchId,
            phase: 'committed',
            outputs: [],
            stage: '',
            outcome: result,
          };
          await writeJson(ledgerPath, ledger);
          return result;
        }
        const documents: string[] = [];
        for (const content of new Set(proposal.documents)) {
          const parsed = parseAutoMemoryTopicDocument('import.md', content);
          if (!parsed) throw new Error('Invalid native memory.');
          if (
            section.scope === 'user' &&
            parsed.type !== 'user' &&
            parsed.type !== 'feedback'
          )
            throw new Error(
              'Project knowledge cannot be imported into user memory.',
            );
          const bodyDigest = digest(parsed.body.trim());
          for (const [sourceId, record] of Object.entries(ledger)) {
            if (
              record.outputs.some((output) => output.bodyDigest === bodyDigest)
            ) {
              // Publication renames the stage into this directory, so an
              // intent that never created it imported nothing.
              if (
                record.phase === 'intent' &&
                !(await exists(path.join(root, 'imported', sourceId)))
              )
                continue;
              for (const output of record.outputs) {
                const file = await resolveTrustedMemoryFile(
                  root,
                  getMemoryRootTrustedAnchor(root),
                  output.relativePath,
                );
                if (
                  !file ||
                  digest(await fs.readFile(file, 'utf8')) !== output.digest
                )
                  return outcome(
                    'conflict',
                    'Previously edited or forgotten imported knowledge cannot be recreated.',
                  );
              }
            }
          }
          if (
            before.existing.some(
              (existing) =>
                parseAutoMemoryTopicDocument(
                  'existing.md',
                  existing.content,
                )?.body.trim() === parsed.body.trim(),
            )
          )
            continue;
          if (
            !documents.some(
              (existing) =>
                parseAutoMemoryTopicDocument(
                  'new.md',
                  existing,
                )?.body.trim() === parsed.body.trim(),
            )
          )
            documents.push(content);
        }
        if (!documents.length) {
          const result = outcome(
            'duplicate',
            'All proposed knowledge already exists.',
          );
          ledger[key] = {
            batchId,
            phase: 'committed',
            outputs: [],
            stage: '',
            outcome: result,
          };
          await writeJson(ledgerPath, ledger);
          return result;
        }
        const stageName = `stage-${key}`;
        const stage = path.join(scopeState, stageName);
        if (await exists(stage)) {
          await privateDirectory(stage, this.base);
          await fs.rm(stage, { recursive: true });
        }
        await privateDirectory(stage, this.base);
        const outputs: LedgerRecord['outputs'] = [];
        for (const [index, content] of documents.entries()) {
          const filename = `${index}.md`;
          await fs.writeFile(path.join(stage, filename), content, {
            flag: 'wx',
            mode: 0o600,
          });
          outputs.push({
            relativePath: `imported/${key}/${filename}`,
            digest: digest(content),
            bodyDigest: digest(
              parseAutoMemoryTopicDocument('import.md', content)!.body.trim(),
            ),
          });
        }
        const result = {
          ...outcome('added', proposal.reason),
          refs: outputs.map(
            (output) => `${section.scope}:${output.relativePath}`,
          ),
        };
        ledger[key] = {
          batchId,
          phase: 'intent',
          outputs,
          stage: stageName,
          memoryVersion: before.version,
          outcome: result,
        };
        await writeJson(ledgerPath, ledger);
        signal.throwIfAborted();
        this.options.assertActive();
        await privateDirectory(path.join(root, 'imported'), this.base);
        signal.throwIfAborted();
        this.options.assertActive();
        if ((await this.snapshot(section.scope)).version !== before.version) {
          await discardUnpublishedIntent(stage);
          return outcome(
            'conflict',
            'Existing memory changed before publication.',
          );
        }
        await assertCommit();
        heldLocks.getStore()?.throwIfAborted();
        await fs.rename(stage, path.join(root, 'imported', key));
        ledger[key].phase = 'committed';
        await writeJson(ledgerPath, ledger);
        await rebuildAutoMemoryIndexAtRoot(root, section.scope);
        return result;
      },
      signal,
    );
  }
}
