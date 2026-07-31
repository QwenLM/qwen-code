/**
 * Tests for Read Pattern Detection
 *
 * Verifies:
 * - Bash read commands: cat, sed, head, tail
 * - Shell wrappers: /bin/zsh -lc 'cat file'
 * - PowerShell gating: looksLikePowerShell triggers PS path
 * - Non-read commands return null
 */
import { describe, it, expect } from 'bun:test';
import { parseReadCommand } from '../read-patterns.ts';
import { looksLikePowerShell, isPowerShellAvailable } from '../../powershell-validator.ts';

// ============================================================
// Bash Read Commands
// ============================================================

describe('parseReadCommand - bash', () => {
  it('detects cat with single file', () => {
    const result = parseReadCommand('cat file.ts');
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('file.ts');
  });

  it('detects cat with path', () => {
    const result = parseReadCommand('cat /home/user/guide.md');
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('/home/user/guide.md');
  });

  it('returns null for cat with flags', () => {
    expect(parseReadCommand('cat -n file.ts')).toBeNull();
  });

  it('returns null for cat with multiple files', () => {
    expect(parseReadCommand('cat file1.ts file2.ts')).toBeNull();
  });

  it('detects sed line range', () => {
    const result = parseReadCommand("sed -n '1,100p' file.ts");
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('file.ts');
    expect(result!.startLine).toBe(1);
    expect(result!.endLine).toBe(100);
  });

  it('detects sed single line', () => {
    const result = parseReadCommand("sed -n '50p' file.ts");
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('file.ts');
    expect(result!.startLine).toBe(50);
    expect(result!.endLine).toBe(50);
  });

  it('detects head -n', () => {
    const result = parseReadCommand('head -n 50 file.ts');
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('file.ts');
    expect(result!.startLine).toBe(1);
    expect(result!.endLine).toBe(50);
  });

  it('detects head short form', () => {
    const result = parseReadCommand('head -50 file.ts');
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('file.ts');
    expect(result!.endLine).toBe(50);
  });

  it('detects tail -n', () => {
    const result = parseReadCommand('tail -n 50 file.ts');
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('file.ts');
    // tail doesn't set startLine/endLine (unknown file length)
  });

  it('returns null for non-read commands', () => {
    expect(parseReadCommand('rm -rf /')).toBeNull();
    expect(parseReadCommand('echo hello')).toBeNull();
    expect(parseReadCommand('ls -la')).toBeNull();
  });

  it('detects shell-wrapped reads', () => {
    const result = parseReadCommand("/bin/zsh -lc 'cat guide.md'");
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('guide.md');
    expect(result!.originalCommand).toBe("/bin/zsh -lc 'cat guide.md'");
  });

  it('detects bash -c wrapped reads', () => {
    const result = parseReadCommand("bash -c 'cat /path/to/guide.md'");
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('/path/to/guide.md');
  });
});

// ============================================================
// PowerShell Gating
// ============================================================

describe('parseReadCommand - PowerShell gating', () => {
  it('looksLikePowerShell detects Get-Content', () => {
    expect(looksLikePowerShell('Get-Content guide.md')).toBe(true);
  });

  it('looksLikePowerShell detects Get-Content with params', () => {
    expect(looksLikePowerShell('Get-Content -Path "C:\\Users\\guide.md" -Encoding UTF8')).toBe(true);
  });

  it('looksLikePowerShell does not match plain cat', () => {
    expect(looksLikePowerShell('cat file.ts')).toBe(false);
  });

  // PowerShell AST tests only run when pwsh is available
  if (isPowerShellAvailable()) {
    it('detects Get-Content with AST parser', () => {
      const result = parseReadCommand('Get-Content guide.md');
      expect(result).not.toBeNull();
      expect(result!.filePath).toBe('guide.md');
    });

    it('detects Get-Content with -Path parameter', () => {
      const result = parseReadCommand('Get-Content -Path "C:\\Users\\guide.md"');
      expect(result).not.toBeNull();
      expect(result!.filePath).toBe('C:\\Users\\guide.md');
    });

    it('detects gc alias', () => {
      const result = parseReadCommand('gc guide.md');
      // gc is a PowerShell alias but looksLikePowerShell may not detect it
      // (it uses Verb-Noun pattern). This tests the full flow when PS is available.
      if (looksLikePowerShell('gc guide.md')) {
        expect(result).not.toBeNull();
        expect(result!.filePath).toBe('guide.md');
      }
    });

    it('detects Get-Content in pipeline', () => {
      const result = parseReadCommand('Get-Content guide.md | Select-String "pattern"');
      expect(result).not.toBeNull();
      expect(result!.filePath).toBe('guide.md');
    });

    it('detects Get-Content with -Encoding', () => {
      const result = parseReadCommand('Get-Content -Path guide.md -Encoding UTF8');
      expect(result).not.toBeNull();
      expect(result!.filePath).toBe('guide.md');
    });
  }
});
