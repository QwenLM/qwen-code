/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  getAutoMemoryRoot,
  getUserAutoMemoryRoot,
} from '@qwen-code/qwen-code-core/memory/paths.js';
import {
  scanAllAutoMemoryTopicDocuments,
  scanAllUserAutoMemoryTopicDocuments,
  type ScannedAutoMemoryDocument,
} from '@qwen-code/qwen-code-core/memory/scan.js';
import { buildManagedAutoMemoryIndex } from '@qwen-code/qwen-code-core/memory/indexer.js';
import { scanForSecrets } from '@qwen-code/qwen-code-core/memory/secret-scanner.js';
import { atomicWriteFile } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import { openNoFollow } from '@qwen-code/qwen-code-core/utils/no-follow-open.js';
import { realpathNearestExisting } from '@qwen-code/qwen-code-core/utils/paths.js';
import { loadServeFastPathSettings } from '../../serve/fast-path-settings.js';
import {
  parseCodexMemories,
  type CodexMemoryCandidate,
} from './codex-parser.js';

const LEDGER = '.codex-import.json';
const LOCK = '.codex-import.lock';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const ledgerSchema = z
  .object({
    version: z.literal(1),
    candidates: z
      .record(
        z.string().regex(/^[a-f0-9]{20}$/),
        z.string().regex(/^[a-f0-9]{64}$/),
      )
      .optional(),
    records: z.record(
      z.string().regex(/^[a-f0-9]{20}$/),
      z
        .object({
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          file: z
            .string()
            .regex(/^codex-[a-f0-9]+\.md$/)
            .nullable(),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
  })
  .strict();
type Ledger = z.infer<typeof ledgerSchema>;

type ImportStatus =
  | 'ready'
  | 'duplicate'
  | 'conflict'
  | 'previously-imported'
  | 'blocked'
  | 'imported';
export interface ImportEntry extends CodexMemoryCandidate {
  targetRoot?: string;
  resolvedProject?: string;
  scope: 'user' | 'project';
  scopeReason?: string;
  status: ImportStatus;
}
export interface ImportPreview {
  dryRun: boolean;
  sourceDigest: string;
  entries: ImportEntry[];
  reviewNotes: Array<{ path: string; content: string }>;
  warnings: string[];
}
export interface CodexImportOptions {
  source?: string;
  projectMap?: Record<string, string>;
  selectedIds?: string[];
  dryRun?: boolean;
  reviewedSource?: string;
}
interface Destination {
  root: string;
  project?: string;
  runtimeDir: string;
  docs: ScannedAutoMemoryDocument[];
  ledger: Ledger;
}

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const normalize = (value: string) =>
  value.normalize('NFKC').replace(/\s+/g, ' ').trim();
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
async function readFile(
  file: string,
): Promise<{ content: string; mtimeMs: number } | undefined> {
  let handle;
  try {
    handle = await openNoFollow(file);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES)
      throw new Error(`Expected a regular file under 2 MiB: ${file}`);
    return { content: await handle.readFile('utf8'), mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}
async function resolveMainProject(
  directory: string,
): Promise<string | undefined> {
  const exists = async (file: string) => {
    try {
      return await fs.lstat(file);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  };
  const pointer = async (file: string) => {
    if (!(await exists(file))?.isFile()) return undefined;
    const value = (await readFile(file))?.content.trim();
    return value && !/[\r\n\0]/.test(value) ? value : undefined;
  };
  const gitStore = async (root: string) =>
    (await exists(path.join(root, 'HEAD')))?.isFile() &&
    (await exists(path.join(root, 'objects')))?.isDirectory() &&
    (await exists(path.join(root, 'refs')))?.isDirectory();
  try {
    let current = directory;
    while (true) {
      const marker = path.join(current, '.git');
      const stat = await exists(marker);
      if (stat) {
        if (stat.isDirectory())
          return (await gitStore(marker)) ? current : undefined;
        if (!stat.isFile()) return undefined;
        const gitfile = await pointer(marker);
        const location = gitfile?.match(/^gitdir: (.+)$/)?.[1];
        if (!location) return undefined;
        const gitdir = await fs.realpath(path.resolve(current, location));
        const commonFile = path.join(gitdir, 'commondir');
        if (!(await exists(commonFile)))
          return (await gitStore(gitdir)) ? current : undefined;
        const commonPointer = await pointer(commonFile);
        const backlink = await pointer(path.join(gitdir, 'gitdir'));
        if (!commonPointer || !backlink) return undefined;
        if ((await fs.realpath(path.resolve(gitdir, backlink))) !== marker)
          return undefined;
        const common = await fs.realpath(path.resolve(gitdir, commonPointer));
        if (path.basename(common) !== '.git' || !(await gitStore(common)))
          return undefined;
        // Automatic inference supports ordinary Git layouts only. Config
        // indirection can move the worktree or turn this into a bare store.
        const configFile = path.join(common, 'config');
        if (!(await exists(configFile))?.isFile()) return undefined;
        const config = (await readFile(configFile))?.content;
        if (
          !config ||
          /\\\r?$/m.test(config) ||
          /\[\s*include/i.test(config) ||
          (await exists(path.join(common, 'config.worktree'))) ||
          (await exists(path.join(gitdir, 'config.worktree')))
        )
          return undefined;
        let core = false;
        let nonBare = false;
        for (const line of config.split(/\r?\n/)) {
          if (/^\s*\[/.test(line)) {
            core = /^\s*\[\s*core\s*\]\s*(?:[#;].*)?$/i.test(line);
            if (/^\s*\[\s*core(?:\s|\])/i.test(line) && !core) return undefined;
          } else if (core && !/^\s*(?:[#;]|$)/.test(line)) {
            if (/^\s*worktree(?:\s|=|$)/i.test(line)) return undefined;
            if (/^\s*bare(?:\s|=|$)/i.test(line)) {
              if (!/^\s*bare\s*=\s*(false|no|off|0)\s*(?:[#;].*)?$/i.test(line))
                return undefined;
              nonBare = true;
            }
          }
        }
        return nonBare ? path.dirname(common) : undefined;
      }
      if (await gitStore(current)) return undefined;
      const parent = path.dirname(current);
      if (parent === current) return directory;
      current = parent;
    }
  } catch {
    return undefined;
  }
}
function redact(content: string): string {
  return scanForSecrets(content).length
    ? '[Blocked: possible credential; inspect the source locally.]'
    : content;
}
async function readSource(source: string) {
  const files = [];
  for (const relative of ['memory_summary.md', 'MEMORY.md']) {
    const file = await readFile(path.join(source, relative));
    if (file) files.push({ path: relative, ...file });
  }
  if (!files.length)
    throw new Error(
      'No memory_summary.md or MEMORY.md found in the source directory.',
    );
  const notesDir = path.join(source, 'extensions', 'ad_hoc', 'notes');
  const notes: Array<{ path: string; content: string }> = [];
  let names: string[] = [];
  try {
    if (!within(source, await fs.realpath(notesDir)))
      throw new Error(
        'Supplemental notes must stay inside the source directory.',
      );
    names = (await fs.readdir(notesDir))
      .filter((name) => name.endsWith('.md'))
      .sort();
  } catch (error) {
    if (!missing(error)) throw error;
  }
  for (const name of names) {
    const file = await readFile(path.join(notesDir, name));
    if (file)
      notes.push({
        path: `extensions/ad_hoc/notes/${name}`,
        content: file.content,
      });
  }
  return {
    files,
    notes,
    digest: hash(
      JSON.stringify([
        files.map(({ path, content }) => ({ path, content })),
        notes,
      ]),
    ),
  };
}
async function readLedger(root: string): Promise<Ledger> {
  const file = await readFile(path.join(root, LEDGER));
  if (!file) return { version: 1, records: {} };
  const parsed = ledgerSchema.safeParse(JSON.parse(file.content));
  if (!parsed.success)
    throw new Error(
      `Invalid Codex import ledger in ${root}; refusing to overwrite it.`,
    );
  return parsed.data;
}
async function scanDestination(
  destination: Pick<Destination, 'project' | 'runtimeDir'>,
) {
  return Storage.runWithResolvedRuntimeBaseDir(destination.runtimeDir, () =>
    destination.project
      ? scanAllAutoMemoryTopicDocuments(destination.project, undefined, false)
      : scanAllUserAutoMemoryTopicDocuments(),
  );
}
async function validateDestination(
  root: string,
  source: string,
  projects: string[],
) {
  const canonical = realpathNearestExisting(root);
  if (
    within(source, canonical) ||
    projects.some((project) => within(project, canonical))
  ) {
    throw new Error(
      'Import destination must be private and outside the source and project directories.',
    );
  }
  // Also reject a configured runtime inside an unrelated checkout.
  let current = canonical;
  while (true) {
    try {
      await fs.lstat(path.join(current, '.git'));
      throw new Error('Import destination must not be inside a Git checkout.');
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return canonical;
}
function renderDocument(entry: ImportEntry): string {
  const field = (value: string) =>
    JSON.stringify(value.replace(/\p{Cc}/gu, ' ').trim());
  return `---\nname: ${field(entry.name)}\ndescription: ${field(`${entry.name}; source date ${entry.updatedAt ?? 'unknown'}`)}\ntype: ${entry.type}\ncodex_source: ${field(`${entry.sourceFile}:${entry.sourceLine}`)}\ncodex_updated_at: ${field(entry.updatedAt ?? 'unknown')}\n---\n\n${entry.content}\n`;
}

async function plan(options: CodexImportOptions) {
  if (process.env['QWEN_CODE_MEMORY_LOCAL'] === '1')
    throw new Error(
      'Codex import does not support repository-local memory. Unset QWEN_CODE_MEMORY_LOCAL.',
    );
  const source = await fs.realpath(
    options.source ??
      path.join(
        process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex'),
        'memories',
      ),
  );
  const input = await readSource(source);
  const parsed = parseCodexMemories(input.files);
  const mappings = options.projectMap ?? {};
  for (const [from, to] of Object.entries(mappings)) {
    if (!path.isAbsolute(from) || !path.isAbsolute(to))
      throw new Error(
        'Project mappings must use absolute source and target directories.',
      );
  }
  const projects = new Map<string, string>();
  const projectErrors = new Map<string, string>();
  for (const candidate of parsed.candidates) {
    if (
      !candidate.sourceProject ||
      projects.has(candidate.sourceProject) ||
      projectErrors.has(candidate.sourceProject)
    )
      continue;
    const target = mappings[candidate.sourceProject] ?? candidate.sourceProject;
    if (!path.isAbsolute(target)) {
      projectErrors.set(
        candidate.sourceProject,
        'Project path is not absolute on this platform. Use a local absolute cwd in a reviewed source export.',
      );
      continue;
    }
    const notDirectory =
      'Project target is not a directory. Correct the path or provide an exact --project-map.';
    try {
      const canonical = await fs.realpath(target);
      if (!(await fs.stat(canonical)).isDirectory()) {
        projectErrors.set(candidate.sourceProject, notDirectory);
        continue;
      }
      const mainProject = await resolveMainProject(canonical);
      if (mainProject) projects.set(candidate.sourceProject, mainProject);
      else
        projectErrors.set(
          candidate.sourceProject,
          'Cannot verify the Git main checkout. Repair Git metadata or provide an exact --project-map to the main project directory.',
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        projectErrors.set(candidate.sourceProject, notDirectory);
      } else if (missing(error)) {
        projectErrors.set(
          candidate.sourceProject,
          'Project target directory does not exist. Provide an exact --project-map to an existing directory.',
        );
      } else throw error;
    }
  }
  const destinations = new Map<string, Destination>();
  const entries: ImportEntry[] = [];
  for (const candidate of parsed.candidates) {
    const entry: ImportEntry = {
      ...candidate,
      scope: candidate.sourceFile === 'memory_summary.md' ? 'user' : 'project',
      status: 'ready',
    };
    entries.push(entry);
    if (
      scanForSecrets(
        [candidate.name, candidate.content, candidate.sourceProject].join(' '),
      ).length
    ) {
      entry.content = redact(candidate.content);
      entry.name = 'Blocked credential candidate';
      delete entry.sourceProject;
      entry.status = 'blocked';
      entry.reason = 'Possible credential in source content.';
      continue;
    }
    const project =
      entry.scope === 'user'
        ? undefined
        : projects.get(candidate.sourceProject ?? '');
    if (entry.scope === 'project' && !project) {
      entry.scope = 'user';
      entry.scopeReason =
        candidate.reason ?? projectErrors.get(candidate.sourceProject ?? '');
      delete entry.reason;
    }
    entry.resolvedProject = project;
    const cwd = project ?? process.cwd();
    const settings = loadServeFastPathSettings(cwd);
    const resolved = Storage.runWithRuntimeBaseDir(
      settings.advanced?.runtimeOutputDir,
      cwd,
      () => ({
        root: project ? getAutoMemoryRoot(project) : getUserAutoMemoryRoot(),
        runtimeDir: Storage.getRuntimeBaseDir(),
      }),
    );
    entry.targetRoot = await validateDestination(resolved.root, source, [
      ...projects.values(),
    ]);
    let destination = destinations.get(entry.targetRoot);
    if (!destination) {
      destination = {
        ...resolved,
        root: entry.targetRoot,
        project,
        docs: [],
        ledger: await readLedger(entry.targetRoot),
      };
      destination.docs = await scanDestination(destination);
      destinations.set(entry.targetRoot, destination);
    }
  }
  for (const destination of destinations.values()) {
    const candidates = entries.filter(
      (entry) => entry.targetRoot === destination.root,
    );
    const known = new Map(Object.entries(destination.ledger.candidates ?? {}));
    for (const [id, record] of Object.entries(destination.ledger.records))
      known.set(id, record.fingerprint);
    const identities = new Map<ImportEntry, string>();
    for (const entry of candidates) {
      const fingerprint = hash(normalize(entry.content));
      const match = [...known].find(([, value]) => value === fingerprint);
      if (match) {
        identities.set(entry, match[0]);
        known.delete(match[0]);
      }
    }
    const reserved = new Set(identities.values());
    for (const entry of candidates) {
      const identity = identities.get(entry);
      if (identity) {
        entry.id = identity;
      } else if (reserved.has(entry.id)) {
        entry.id = hash(`${entry.id}\0${normalize(entry.content)}`).slice(
          0,
          20,
        );
        entry.status = 'conflict';
        entry.reason =
          'Source entries moved and this changed entry has no reliable prior identity. Review it in a separate source section.';
      } else if (
        destination.ledger.candidates?.[entry.id] &&
        !destination.ledger.records[entry.id]
      ) {
        entry.id = hash(`${entry.id}\0${normalize(entry.content)}`).slice(
          0,
          20,
        );
      }
    }
  }
  const identityCounts = new Map<string, number>();
  for (const entry of entries)
    identityCounts.set(entry.id, (identityCounts.get(entry.id) ?? 0) + 1);
  for (const entry of entries) {
    if (identityCounts.get(entry.id)! > 1) {
      entry.id = hash(
        `${entry.id}\0${entry.targetRoot}\0${entry.sourceFile}\0${entry.sourceLine}`,
      ).slice(0, 20);
      if (entry.status !== 'blocked') {
        entry.status = 'conflict';
        entry.reason =
          'Source movement reused an identity across destinations. Review these entries in separate source sections.';
      }
    }
    if (!entry.targetRoot || entry.status !== 'ready') continue;
    const destination = destinations.get(entry.targetRoot)!;
    const fingerprint = hash(normalize(entry.content));
    const record = destination.ledger.records[entry.id];
    if (record) {
      const existing = record.file
        ? await readFile(path.join(destination.root, record.file))
        : undefined;
      if (!existing) {
        entry.status = 'previously-imported';
        entry.reason = record.file
          ? 'Previously imported or reserved; target is absent. It will not be restored after forget or consolidation.'
          : 'Existing equivalent memory was already recorded; it will not be restored automatically.';
      } else if (
        record.fingerprint !== fingerprint ||
        record.digest !== hash(existing.content)
      ) {
        entry.status = 'conflict';
        entry.reason =
          'Source or imported document changed; existing memory is preserved.';
      } else {
        entry.status = 'previously-imported';
        entry.reason = 'This entry was already imported.';
      }
      continue;
    }
    if (
      Object.values(destination.ledger.records).some(
        (record) => record.fingerprint === fingerprint,
      )
    ) {
      entry.status = 'previously-imported';
      entry.reason =
        'This content was previously imported; it will not be restored automatically.';
    } else if (
      destination.docs.some(
        (doc) => normalize(doc.body) === normalize(entry.content),
      )
    ) {
      entry.status = 'duplicate';
      entry.reason =
        'Exact normalized content already exists in this memory scope.';
    } else if (
      destination.docs.some(
        (doc) => normalize(doc.title) === normalize(entry.name),
      ) ||
      (await readFile(path.join(destination.root, `codex-${entry.id}.md`)))
    ) {
      entry.status = 'conflict';
      entry.reason =
        'A document with the same title or destination exists with different content.';
    } else if (
      entries
        .slice(0, entries.indexOf(entry))
        .some(
          (previous) =>
            previous !== entry &&
            previous.targetRoot === entry.targetRoot &&
            normalize(previous.content) === normalize(entry.content) &&
            previous.status === 'ready' &&
            (!options.selectedIds?.length ||
              options.selectedIds.includes(previous.id)),
        )
    ) {
      entry.status = 'duplicate';
      entry.reason = 'Duplicate of another candidate in this destination.';
    }
  }
  const preview: ImportPreview = {
    dryRun: Boolean(options.dryRun || !options.selectedIds?.length),
    sourceDigest: input.digest,
    entries,
    reviewNotes: input.notes.map((note) => ({
      ...note,
      path: redact(note.path),
      content: redact(note.content),
    })),
    warnings: [
      ...parsed.warnings,
      ...(entries.some((entry) => entry.scope === 'project')
        ? [
            'Project entries use the displayed main project memory scope. Qwen does not automatically recall that scope from a linked worktree.',
          ]
        : []),
      ...(input.notes.length
        ? [
            'Supplemental source notes can contain corrections or deletion requests. Review them before selecting entries; applying requires --review-source with this preview sourceDigest. They are not automatically interpreted.',
          ]
        : []),
    ],
  };
  return { preview, destinations, source };
}

export async function runCodexImport(
  options: CodexImportOptions,
): Promise<ImportPreview> {
  let planned = await plan(options);
  const selectedIds = new Set(options.selectedIds ?? []);
  const validateSelection = () => {
    const entries = planned.preview.entries;
    for (const id of selectedIds) {
      if (!entries.some((entry) => entry.id === id))
        throw new Error(`Unknown candidate ID: ${id}`);
    }
    const blocked = entries.filter(
      (entry) =>
        selectedIds.has(entry.id) &&
        ['conflict', 'blocked'].includes(entry.status),
    );
    if (blocked.length)
      throw new Error(
        `Selected entries cannot be imported: ${blocked.map((entry) => `${entry.id} (${entry.status})`).join(', ')}. Run --dry-run to inspect them.`,
      );
  };
  if (planned.preview.dryRun) return planned.preview;
  validateSelection();
  if (
    options.reviewedSource !== undefined &&
    options.reviewedSource !== planned.preview.sourceDigest
  ) {
    throw new Error(
      'Source changed since preview. Review again before importing (--review-source).',
    );
  }
  if (
    planned.preview.reviewNotes.length &&
    options.reviewedSource !== planned.preview.sourceDigest
  ) {
    throw new Error(
      'Review the supplemental source notes in --dry-run, then pass --review-source <sourceDigest> for the unchanged source.',
    );
  }
  const locks: Array<{ root: string; handle: fs.FileHandle }> = [];
  try {
    const roots = [
      ...new Set(
        planned.preview.entries
          .filter(
            (entry) =>
              selectedIds.has(entry.id) &&
              (entry.status === 'ready' ||
                entry.status === 'duplicate' ||
                entry.status === 'previously-imported'),
          )
          .map((entry) => entry.targetRoot!),
      ),
    ].sort();
    if (!roots.length) return planned.preview;
    for (const root of roots) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await validateDestination(
        root,
        planned.source,
        [...planned.destinations.values()].flatMap((destination) =>
          destination.project ? [destination.project] : [],
        ),
      );
      const handle = await fs.open(path.join(root, LOCK), 'wx', 0o600);
      locks.push({ root, handle });
    }
    const sourceDigest = planned.preview.sourceDigest;
    planned = await plan(options);
    if (planned.preview.sourceDigest !== sourceDigest)
      throw new Error(
        'Source changed while preparing import; run --dry-run again.',
      );
    validateSelection();
    const ready = planned.preview.entries.filter(
      (entry) =>
        selectedIds.has(entry.id) &&
        (entry.status === 'ready' || entry.status === 'duplicate'),
    );
    if (ready.some((entry) => !roots.includes(entry.targetRoot!)))
      throw new Error(
        'Destination configuration changed; run --dry-run again.',
      );
    for (const entry of ready) {
      const destination = planned.destinations.get(entry.targetRoot!)!;
      const candidates = (destination.ledger.candidates ??= {});
      for (const candidate of planned.preview.entries) {
        if (
          candidate.targetRoot === destination.root &&
          candidate.status !== 'conflict' &&
          candidate.status !== 'blocked'
        )
          candidates[candidate.id] ??= hash(normalize(candidate.content));
      }
      const duplicate = entry.status === 'duplicate';
      const file = duplicate ? null : `codex-${entry.id}.md`;
      const content = renderDocument(entry);
      destination.ledger.records[entry.id] = {
        fingerprint: hash(normalize(entry.content)),
        file,
        digest: hash(content),
      };
      // Reserve before publishing: interruption can skip an entry, never resurrect it.
      await atomicWriteFile(
        path.join(destination.root, LEDGER),
        JSON.stringify(destination.ledger, null, 2) + '\n',
        { encoding: 'utf8', mode: 0o600, noFollow: true },
      );
      if (!file) {
        entry.status = 'previously-imported';
        entry.reason =
          'Existing equivalent memory recorded; later imports will not restore it after deletion.';
        continue;
      }
      const target = path.join(destination.root, file);
      await fs.writeFile(target, content, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      if (entry.updatedAt) {
        const date = new Date(entry.updatedAt);
        await fs.utimes(target, date, date);
      }
      entry.status = 'imported';
    }
    for (const root of roots) {
      const destination = planned.destinations.get(root)!;
      const docs = await scanDestination(destination);
      docs.sort(
        (a, b) => b.mtimeMs - a.mtimeMs || a.filename.localeCompare(b.filename),
      );
      await atomicWriteFile(
        path.join(root, 'MEMORY.md'),
        buildManagedAutoMemoryIndex(docs.slice(0, 200)),
        { encoding: 'utf8', mode: 0o600, noFollow: true },
      );
    }
    return planned.preview;
  } finally {
    for (const { root, handle } of locks.reverse()) {
      await handle.close();
      await fs.unlink(path.join(root, LOCK));
    }
  }
}
