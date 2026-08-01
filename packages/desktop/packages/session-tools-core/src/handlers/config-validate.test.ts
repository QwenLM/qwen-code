import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleConfigValidate } from './config-validate.ts';

function createCtx(workspacePath: string) {
  return {
    sessionId: 'test-session',
    workspacePath,
    get sourcesPath() { return join(workspacePath, 'sources'); },
    get skillsPath() { return join(workspacePath, 'skills'); },
    plansFolderPath: join(workspacePath, 'plans'),
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    },
    fs: {
      exists: (path: string) => existsSync(path),
      readFile: (path: string) => readFileSync(path, 'utf-8'),
      readFileBuffer: (path: string) => readFileSync(path),
      writeFile: (path: string, content: string) => writeFileSync(path, content),
      isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
      readdir: (path: string) => readdirSync(path),
      stat: (path: string) => {
        const s = statSync(path);
        return { size: s.size, isDirectory: () => s.isDirectory() };
      },
    },
    validators: undefined,
    loadSourceConfig: () => null,
  } as const;
}

describe('config-validate automations target', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-validate-automations-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('validates automations.json when present', async () => {
    writeFileSync(join(tempDir, 'automations.json'), JSON.stringify({ version: 2, automations: {} }));

    const result = await handleConfigValidate(createCtx(tempDir), { target: 'automations' });
    expect(result.content[0]?.text).toContain('Validation passed');
  });

  it('returns no-config message when automations.json does not exist', async () => {
    const result = await handleConfigValidate(createCtx(tempDir), { target: 'automations' });
    expect(result.content[0]?.text).toContain('No automations.json');
  });
});

describe('config-validate source fallback', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-validate-sources-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns a structured validation result for invalid source slugs', async () => {
    const result = await handleConfigValidate(createCtx(tempDir), {
      target: 'sources',
      sourceSlug: '../sessions',
    });

    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBe(false);
    expect(text).toContain('Validation failed');
    expect(text).toContain('sourceSlug: Invalid source slug: "../sessions"');
  });

  it('skips legacy invalid source directories during all-source fallback validation', async () => {
    const sourcesDir = join(tempDir, 'sources');
    mkdirSync(join(sourcesDir, 'legacy-source-'), { recursive: true });
    mkdirSync(join(sourcesDir, 'valid-source'), { recursive: true });
    writeFileSync(
      join(sourcesDir, 'valid-source', 'config.json'),
      JSON.stringify({
        slug: 'valid-source',
        name: 'Valid Source',
        type: 'mcp',
      })
    );

    const result = await handleConfigValidate(createCtx(tempDir), {
      target: 'sources',
    });
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBe(false);
    expect(text).toContain('Validation passed');
    expect(text).toContain("Source 'legacy-source-' has invalid slug format, skipping source validation");
    expect(text).not.toContain('File not found');
  });
});
