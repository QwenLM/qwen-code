import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shouldAllowToolInMode, extractBashWriteTarget } from '../../agent/mode-manager.ts';

describe('mode-manager path containment for plans/data exceptions', () => {
  let base: string;
  let plansDir: string;
  let dataDir: string;
  let siblingPlans: string;
  let siblingData: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'craft-mode-boundary-test-'));
    plansDir = join(base, 'plans');
    dataDir = join(base, 'data');
    siblingPlans = join(base, 'plans-evil', 'pwn.md');
    siblingData = join(base, 'data-bypass', 'out.json');

    mkdirSync(plansDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('allows Write inside plans folder', () => {
    const result = shouldAllowToolInMode(
      'Write',
      { file_path: join(plansDir, 'ok.md') },
      'safe',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks Write to sibling path with plans prefix', () => {
    const result = shouldAllowToolInMode(
      'Write',
      { file_path: siblingPlans },
      'safe',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    );
    expect(result.allowed).toBe(false);
  });

  it('blocks Bash redirect to sibling path with data prefix', () => {
    const result = shouldAllowToolInMode(
      'Bash',
      { command: `echo "x" > "${siblingData}"` },
      'safe',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    );
    expect(result.allowed).toBe(false);
  });

  it('allows Bash redirect inside data folder', () => {
    const result = shouldAllowToolInMode(
      'Bash',
      { command: `echo "x" > "${join(dataDir, 'ok.json')}"` },
      'safe',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks Write via symlink escape from plans folder', () => {
    if (process.platform === 'win32') return;

    const outsideDir = join(base, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(plansDir, 'escape-link'), 'dir');

    const result = shouldAllowToolInMode(
      'Write',
      { file_path: join(plansDir, 'escape-link', 'evil.md') },
      'safe',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    );
    expect(result.allowed).toBe(false);
  });

  it('blocks Bash redirect via symlink escape from data folder', () => {
    if (process.platform === 'win32') return;

    const outsideDir = join(base, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(dataDir, 'escape-link'), 'dir');

    const result = shouldAllowToolInMode(
      'Bash',
      { command: `echo "x" > "${join(dataDir, 'escape-link', 'evil.json')}"` },
      'safe',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    );
    expect(result.allowed).toBe(false);
  });

  it('does not treat JavaScript arrow syntax (=>) as a bash write redirect target', () => {
    const command = "node -e \"const f = (s) => s.includes('electron'); console.log(f('typecheck'))\"";
    expect(extractBashWriteTarget(command)).toBeNull();
  });

  it('keeps allowlist mismatch messaging for node -e arrow command (no write-path error)', () => {
    const command = "node -e \"const f = (s) => s.includes('electron'); console.log(f('typecheck'))\"";
    const result = shouldAllowToolInMode(
      'Bash',
      { command },
      'safe',
      { plansFolderPath: plansDir, dataFolderPath: dataDir }
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('read-only allowlist');
      expect(result.reason).not.toContain('Write blocked (Plan mode) - target not in allowed folders');
    }
  });
});
