/**
 * Mutation matrix for PR #7767.
 *
 * Each entry breaks exactly one behaviour the PR claims to add, then runs the
 * suite that is supposed to guard it. A mutant that leaves the suite green is
 * an unguarded behaviour. Every mutation is verified to have actually changed
 * the file before the suite runs (a silently-no-op edit would fake a "killed").
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WT = process.argv[2];
if (!WT) throw new Error('usage: mutate.mjs <worktree>');

const CORE = path.join(WT, 'packages/core');
const CLI = path.join(WT, 'packages/cli');
const CG = path.join(CORE, 'src/core/contentGenerator.ts');
const CONFIG = path.join(CORE, 'src/config/config.ts');
const ACP = path.join(CLI, 'src/acp-integration/acpAgent.ts');

const MUTANTS = [
  {
    id: 'M1',
    file: CG,
    desc: 'getGeneratorForUse() no longer clears preloadedOnly (a used generator stays discardable)',
    from: `  private getGeneratorForUse(): Promise<ContentGenerator> {
    this.preloadedOnly = false;
    return this.getGenerator();
  }`,
    to: `  private getGeneratorForUse(): Promise<ContentGenerator> {
    return this.getGenerator();
  }`,
    suite: 'core',
    spec: 'src/core/contentGenerator.test.ts',
  },
  {
    id: 'M2',
    file: CG,
    desc: 'preload() marks preloadedOnly even when a generator already exists',
    from: `  preload(): Promise<ContentGenerator> {
    if (!this.generatorPromise) {
      this.preloadedOnly = true;
    }
    return this.getGenerator();
  }`,
    to: `  preload(): Promise<ContentGenerator> {
    this.preloadedOnly = true;
    return this.getGenerator();
  }`,
    suite: 'core',
    spec: 'src/core/contentGenerator.test.ts',
  },
  {
    id: 'M3',
    file: CG,
    desc: 'resetPreload() drops the preloadedOnly guard (discards any generator)',
    from: `  resetPreload(): void {
    if (!this.preloadedOnly) return;
    this.preloadedOnly = false;
    this.generatorPromise = undefined;
  }`,
    to: `  resetPreload(): void {
    this.preloadedOnly = false;
    this.generatorPromise = undefined;
  }`,
    suite: 'core',
    spec: 'src/core/contentGenerator.test.ts',
  },
  {
    id: 'M4',
    file: CG,
    desc: 'resetPreload() is a no-op (a stale preload is never discarded)',
    from: `  resetPreload(): void {
    if (!this.preloadedOnly) return;
    this.preloadedOnly = false;
    this.generatorPromise = undefined;
  }`,
    to: `  resetPreload(): void {
    return;
  }`,
    suite: 'core',
    spec: 'src/core/contentGenerator.test.ts',
  },
  {
    id: 'M5',
    file: CG,
    desc: 'preloadContentGenerator() drops the LazyContentGenerator instanceof guard',
    from: `  if (generator instanceof LazyContentGenerator) {
    await generator.preload();
  }`,
    to: `  await (generator as unknown as LazyContentGenerator).preload();`,
    suite: 'core',
    spec: 'src/core/contentGenerator.test.ts',
  },
  {
    id: 'M6',
    file: CONFIG,
    desc: 'switchModel() no longer invalidates an unused preload (Qwen OAuth hot switch)',
    from: `      resetPreloadedContentGenerator(this.contentGenerator);
      return;`,
    to: `      return;`,
    suite: 'core',
    spec: 'src/config/config.test.ts',
  },
  {
    id: 'M7',
    file: CONFIG,
    desc: 'relocateWorkingDirectory() no longer invalidates an unused preload',
    from: `    this.cwd = expected;
    resetPreloadedContentGenerator(this.contentGenerator);`,
    to: `    this.cwd = expected;`,
    suite: 'core',
    spec: 'src/config/config.test.ts',
  },
  {
    id: 'M8',
    file: ACP,
    desc: 'preload runs synchronously inside the transport hook instead of setImmediate',
    from: `          const sessionId = message.result.sessionId;
          setImmediate(() => {`,
    to: `          const sessionId = message.result.sessionId;
          ((fn: () => void) => {
            fn();
            return { unref: () => undefined };
          })(() => {`,
    suite: 'cli',
    spec: 'src/acp-integration/acpAgent.test.ts',
  },
  {
    id: 'M9',
    file: ACP,
    desc: 'the scheduled callback keeps the wrapper captured at response time instead of re-finding the session',
    from: `          const sessionId = message.result.sessionId;
          setImmediate(() => {
            const session = agentInstance
              ?.getActiveSessions()
              .find((candidate) => candidate.getId() === sessionId);
            if (!session) return;
            void preloadContentGenerator(
              session.getConfig().getContentGenerator(),
            ).catch((error: unknown) => {`,
    to: `          const sessionId = message.result.sessionId;
          const capturedSession = agentInstance
            ?.getActiveSessions()
            .find((candidate) => candidate.getId() === sessionId);
          const capturedGenerator = capturedSession
            ?.getConfig()
            .getContentGenerator();
          setImmediate(() => {
            const session = capturedSession;
            if (!session) return;
            void preloadContentGenerator(
              capturedGenerator as never,
            ).catch((error: unknown) => {`,
    suite: 'cli',
    spec: 'src/acp-integration/acpAgent.test.ts',
  },
  {
    id: 'M10',
    file: ACP,
    desc: 'the background preload rejection is no longer caught',
    from: `            void preloadContentGenerator(
              session.getConfig().getContentGenerator(),
            ).catch((error: unknown) => {
              debugLogger.debug(
                \`[ACP] Session provider preload failed for \${sessionId}: \${
                  error instanceof Error ? error.message : String(error)
                }\`,
              );
            });`,
    to: `            void preloadContentGenerator(
              session.getConfig().getContentGenerator(),
            );`,
    suite: 'cli',
    spec: 'src/acp-integration/acpAgent.test.ts',
  },
  {
    id: 'M11',
    file: ACP,
    desc: 'the pending session/new id is matched but never consumed (duplicate responses re-preload)',
    from: `          pendingNewSessionRequestIds.delete(message.id) &&`,
    to: `          pendingNewSessionRequestIds.has(message.id) &&`,
    suite: 'cli',
    spec: 'src/acp-integration/acpAgent.test.ts',
  },
  {
    id: 'M12',
    file: ACP,
    desc: 'any sent result carrying a sessionId triggers a preload (no request correlation at all)',
    from: `          pendingNewSessionRequestIds.delete(message.id) &&
          'result' in message &&`,
    to: `          'result' in message &&`,
    suite: 'cli',
    spec: 'src/acp-integration/acpAgent.test.ts',
  },
];

const runSuite = async (suite, spec) => {
  const cwd = suite === 'core' ? CORE : CLI;
  try {
    await execFileAsync('npx', ['vitest', 'run', spec, '--reporter=dot'], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: 'true' },
    });
    return { green: true, failed: [] };
  } catch (e) {
    const text = String(e.stdout ?? '') + String(e.stderr ?? '');
    const failed = [
      ...new Set(
        [...text.matchAll(/(?:×|✕|FAIL).*?>\s([^\n]+?)(?:\s\d+ms)?$/gm)].map((m) =>
          m[1].trim(),
        ),
      ),
    ];
    return { green: false, failed, tail: text.slice(-1500) };
  }
};

const results = [];
for (const m of MUTANTS) {
  const original = fs.readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    console.log(`SKIP  ${m.id}: anchor not found in ${path.basename(m.file)}`);
    results.push({ ...m, applied: false });
    continue;
  }
  const mutated = original.replace(m.from, m.to);
  if (mutated === original) throw new Error(`${m.id}: replacement was a no-op`);
  fs.writeFileSync(m.file, mutated);
  try {
    const r = await runSuite(m.suite, m.spec);
    const killed = !r.green;
    results.push({ ...m, applied: true, killed, failed: r.failed, tail: r.tail });
    console.log(
      `${killed ? 'KILLED ' : 'SURVIVED'} ${m.id}  ${m.desc}\n         ${
        killed ? `killed by: ${r.failed.slice(0, 4).join(' | ') || '(see tail)'}` : 'NO TEST FAILED'
      }`,
    );
  } finally {
    fs.writeFileSync(m.file, original);
  }
}

fs.writeFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), 'mutation-results.json'),
  JSON.stringify(results, null, 2),
);
const survived = results.filter((r) => r.applied && !r.killed);
console.log(
  `\n${results.filter((r) => r.killed).length}/${results.filter((r) => r.applied).length} mutants killed; ${survived.length} survived`,
);
