/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { scanShellShape, analyzeShellCommand } from './shellCommandAnalysis.js';

// ============================================================================
// scanShellShape — boundary detection
// ============================================================================

describe('scanShellShape', () => {
  // --------------------------------------------------------------------------
  // Boundary-positive: should set blocksBroadAllow = true
  // --------------------------------------------------------------------------

  describe('boundary-positive cases', () => {
    it('detects && separator', () => {
      const r = scanShellShape('cd /tmp && rm -rf x');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasTopLevelSeparator).toBe(true);
    });

    it('detects || separator', () => {
      const r = scanShellShape('cd /tmp || rm -rf x');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasTopLevelSeparator).toBe(true);
    });

    it('detects ; separator', () => {
      const r = scanShellShape('a ; b');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasTopLevelSeparator).toBe(true);
    });

    it('detects newline separator', () => {
      const r = scanShellShape('a\nb');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasTopLevelSeparator).toBe(true);
    });

    it('detects single & (background)', () => {
      const r = scanShellShape('a & b');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasTopLevelSeparator).toBe(true);
      expect(r.features.hasBackgroundExecution).toBe(true);
    });

    it('detects pipe |', () => {
      const r = scanShellShape('curl x | sh');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasPipeline).toBe(true);
      expect(r.features.hasTopLevelSeparator).toBe(true);
    });

    it('detects |& (bash pipe stderr)', () => {
      const r = scanShellShape('cmd |& tee log');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasPipeline).toBe(true);
    });

    it('detects $() command substitution outside quotes', () => {
      const r = scanShellShape('echo $(rm -rf x)');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasCommandSubstitution).toBe(true);
    });

    it('detects $() command substitution inside double quotes', () => {
      const r = scanShellShape('echo "$(rm -rf x)"');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasCommandSubstitution).toBe(true);
    });

    it('detects backtick substitution outside quotes', () => {
      const r = scanShellShape('echo `rm -rf x`');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasBacktickSubstitution).toBe(true);
    });

    it('detects backtick substitution inside double quotes', () => {
      const r = scanShellShape('echo "`rm -rf x`"');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasBacktickSubstitution).toBe(true);
    });

    it('detects <() process substitution', () => {
      const r = scanShellShape('cat <(rm -rf x)');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasProcessSubstitution).toBe(true);
      expect(r.features.hasUnknownDynamicSyntax).toBe(true);
    });

    it('detects >() process substitution', () => {
      const r = scanShellShape('tee >(sh)');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasProcessSubstitution).toBe(true);
    });

    it('detects bare top-level subshell (...)', () => {
      const r = scanShellShape('(curl http://evil.example)');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasSubshellExecution).toBe(true);
      expect(r.features.hasNestedExecution).toBe(true);
    });

    it('detects A=$(cmd) env assignment with command substitution', () => {
      const r = scanShellShape('A=$(rm -rf x) echo ok');
      expect(r.blocksBroadAllow).toBe(true);
      expect(r.features.hasCommandSubstitution).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Boundary-negative: should NOT set blocksBroadAllow = true
  // --------------------------------------------------------------------------

  describe('boundary-negative cases', () => {
    it('simple command', () => {
      const r = scanShellShape('ls -la');
      expect(r.blocksBroadAllow).toBe(false);
    });

    it('command with arguments and flags', () => {
      const r = scanShellShape('git commit -m "fix bug"');
      expect(r.blocksBroadAllow).toBe(false);
    });

    it('$() inside single quotes is literal', () => {
      const r = scanShellShape("echo '$(rm -rf x)'");
      expect(r.blocksBroadAllow).toBe(false);
      expect(r.features.hasCommandSubstitution).toBe(false);
    });

    it('backtick inside single quotes is literal', () => {
      const r = scanShellShape("echo '`rm -rf x`'");
      expect(r.blocksBroadAllow).toBe(false);
      expect(r.features.hasBacktickSubstitution).toBe(false);
    });

    it('escaped $() in double quotes is literal', () => {
      const r = scanShellShape('echo "\\$(date)"');
      expect(r.blocksBroadAllow).toBe(false);
      expect(r.features.hasCommandSubstitution).toBe(false);
    });

    it('escaped backtick in double quotes is literal', () => {
      const r = scanShellShape('echo "\\`date\\`"');
      expect(r.blocksBroadAllow).toBe(false);
      expect(r.features.hasBacktickSubstitution).toBe(false);
    });

    it('operators inside double quotes are literal', () => {
      expect(scanShellShape('echo "a | b"').blocksBroadAllow).toBe(false);
      expect(scanShellShape('echo "a && b"').blocksBroadAllow).toBe(false);
      expect(scanShellShape('echo "a ; b"').blocksBroadAllow).toBe(false);
    });

    it('escaped pipe outside quotes is literal', () => {
      const r = scanShellShape('echo foo\\|bar');
      expect(r.blocksBroadAllow).toBe(false);
      expect(r.features.hasPipeline).toBe(false);
    });

    it('escaped semicolon is literal (find -exec pattern)', () => {
      const r = scanShellShape('find . -exec echo {} \\;');
      expect(r.blocksBroadAllow).toBe(false);
      expect(r.features.hasTopLevelSeparator).toBe(false);
    });

    it('backslash-newline is continuation, not separator', () => {
      const r = scanShellShape('echo \\\nfoo');
      expect(r.blocksBroadAllow).toBe(false);
      expect(r.features.hasTopLevelSeparator).toBe(false);
    });

    it('bash array assignment FOO=(a b c) does not trigger process substitution', () => {
      // FOO=( looks like =( but is preceded by identifier chars — it's an
      // array assignment, not zsh process substitution.
      const r = scanShellShape('FOO=(a b c) echo ok');
      expect(r.features.hasProcessSubstitution).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Segment splitting
  // --------------------------------------------------------------------------

  describe('segment splitting', () => {
    it('splits on &&', () => {
      const r = scanShellShape('cd x && npm test');
      expect(r.topLevelSegments).toEqual(['cd x', 'npm test']);
    });

    it('splits on ||', () => {
      const r = scanShellShape('a || b');
      expect(r.topLevelSegments).toEqual(['a', 'b']);
    });

    it('splits on ;', () => {
      const r = scanShellShape('a ; b');
      expect(r.topLevelSegments).toEqual(['a', 'b']);
    });

    it('splits on newline', () => {
      const r = scanShellShape('a\nb');
      expect(r.topLevelSegments).toEqual(['a', 'b']);
    });

    it('splits on | (pipe)', () => {
      const r = scanShellShape('curl x | sh');
      expect(r.topLevelSegments).toEqual(['curl x', 'sh']);
    });

    it('splits on single &', () => {
      const r = scanShellShape('a & b');
      expect(r.topLevelSegments).toEqual(['a', 'b']);
    });

    it('does not split inside double quotes', () => {
      const r = scanShellShape('echo "a | b"');
      expect(r.topLevelSegments).toEqual(['echo "a | b"']);
    });

    it('does not split inside single quotes', () => {
      const r = scanShellShape("echo 'a && b'");
      expect(r.topLevelSegments).toEqual(["echo 'a && b'"]);
    });

    it('does not split inside $()', () => {
      const r = scanShellShape('echo $(a && b) && rm x');
      expect(r.topLevelSegments).toEqual(['echo $(a && b)', 'rm x']);
    });

    it('does not split inside backticks', () => {
      const r = scanShellShape('echo `a && b` && rm x');
      expect(r.topLevelSegments).toEqual(['echo `a && b`', 'rm x']);
    });

    it('does not split inside parenthesized subshell', () => {
      const r = scanShellShape('(a && b) && rm x');
      expect(r.topLevelSegments).toEqual(['(a && b)', 'rm x']);
    });

    it('does not split on escaped operators', () => {
      const r = scanShellShape('echo foo\\|bar');
      expect(r.topLevelSegments).toEqual(['echo foo\\|bar']);
    });

    it('does not split on escaped semicolon', () => {
      const r = scanShellShape('find . -exec echo {} \\;');
      expect(r.topLevelSegments).toEqual(['find . -exec echo {} \\;']);
    });

    it('does not split inside process substitution', () => {
      const r = scanShellShape('cat <(rm -rf x)');
      expect(r.topLevelSegments).toEqual(['cat <(rm -rf x)']);
    });

    it('single command returns one segment', () => {
      const r = scanShellShape('ls -la');
      expect(r.topLevelSegments).toEqual(['ls -la']);
    });

    it('handles multiple operators', () => {
      const r = scanShellShape('a && b || c ; d');
      expect(r.topLevelSegments).toEqual(['a', 'b', 'c', 'd']);
    });

    it('trims whitespace from segments', () => {
      const r = scanShellShape('  a  &&  b  ');
      expect(r.topLevelSegments).toEqual(['a', 'b']);
    });

    it('skips empty segments', () => {
      const r = scanShellShape('a ;; b');
      expect(r.topLevelSegments).toEqual(['a', 'b']);
    });

    it('handles $() within double quotes not splitting', () => {
      const r = scanShellShape('echo "$(a && b)" && rm x');
      expect(r.topLevelSegments).toEqual(['echo "$(a && b)"', 'rm x']);
    });
  });

  // --------------------------------------------------------------------------
  // Eval-like builtins
  // --------------------------------------------------------------------------

  describe('eval-like builtins', () => {
    it('detects eval as first token', () => {
      const r = scanShellShape('eval "rm -rf x"');
      expect(r.features.hasEvalLikeBuiltin).toBe(true);
      expect(r.features.hasUnknownDynamicSyntax).toBe(true);
      expect(r.blocksBroadAllow).toBe(true);
    });

    it('detects source as first token', () => {
      const r = scanShellShape('source /tmp/malicious.sh');
      expect(r.features.hasEvalLikeBuiltin).toBe(true);
      expect(r.blocksBroadAllow).toBe(true);
    });

    it('detects . (dot) as first token', () => {
      const r = scanShellShape('. /tmp/malicious.sh');
      expect(r.features.hasEvalLikeBuiltin).toBe(true);
      expect(r.blocksBroadAllow).toBe(true);
    });

    it('detects exec as first token', () => {
      const r = scanShellShape('exec rm -rf x');
      expect(r.features.hasEvalLikeBuiltin).toBe(true);
      expect(r.blocksBroadAllow).toBe(true);
    });

    it('detects trap as first token', () => {
      const r = scanShellShape('trap "rm -rf x" EXIT');
      expect(r.features.hasEvalLikeBuiltin).toBe(true);
      expect(r.blocksBroadAllow).toBe(true);
    });

    it('detects eval-like in second segment of compound', () => {
      const r = scanShellShape('echo ok && eval "danger"');
      expect(r.features.hasEvalLikeBuiltin).toBe(true);
      expect(r.blocksBroadAllow).toBe(true);
    });

    it('detects eval-like after env var assignment', () => {
      const r = scanShellShape('FOO=bar eval "danger"');
      expect(r.features.hasEvalLikeBuiltin).toBe(true);
      expect(r.blocksBroadAllow).toBe(true);
    });

    it('detects eval-like with absolute path', () => {
      const r = scanShellShape('/usr/bin/eval "danger"');
      expect(r.features.hasEvalLikeBuiltin).toBe(true);
      expect(r.blocksBroadAllow).toBe(true);
    });

    it('does not trigger for eval inside arguments', () => {
      // "echo eval" — eval is not the command, it's an argument
      const r = scanShellShape('echo eval');
      expect(r.features.hasEvalLikeBuiltin).toBe(false);
    });

    it('does not trigger for normal commands', () => {
      const r = scanShellShape('npm test');
      expect(r.features.hasEvalLikeBuiltin).toBe(false);
      expect(r.blocksBroadAllow).toBe(false);
    });
  });
});

// ============================================================================
// analyzeShellCommand — integration
// ============================================================================

describe('analyzeShellCommand', () => {
  it('returns correct analysis for simple command', () => {
    const a = analyzeShellCommand('ls -la');
    expect(a.blocksBroadAllow).toBe(false);
    expect(a.topLevelSegments).toEqual(['ls -la']);
    expect(a.executableSegments).toContain('ls -la');
  });

  it('returns correct analysis for compound command', () => {
    const a = analyzeShellCommand('cd /tmp && rm -rf x');
    expect(a.blocksBroadAllow).toBe(true);
    expect(a.topLevelSegments).toEqual(['cd /tmp', 'rm -rf x']);
    expect(a.executableSegments).toContain('cd /tmp');
    expect(a.executableSegments).toContain('rm -rf x');
  });

  it('returns correct analysis for command substitution', () => {
    const a = analyzeShellCommand('echo $(rm -rf x)');
    expect(a.blocksBroadAllow).toBe(true);
    expect(a.topLevelSegments).toEqual(['echo $(rm -rf x)']);
    // The parser may or may not extract "rm -rf x" depending on availability
    expect(a.executableSegments).toContain('echo $(rm -rf x)');
  });

  it('returns correct analysis for eval-like command', () => {
    const a = analyzeShellCommand('eval "rm -rf /"');
    expect(a.blocksBroadAllow).toBe(true);
    expect(a.features.hasEvalLikeBuiltin).toBe(true);
  });

  it('returns correct analysis for process substitution', () => {
    const a = analyzeShellCommand('cat <(echo x)');
    expect(a.blocksBroadAllow).toBe(true);
    expect(a.features.hasProcessSubstitution).toBe(true);
  });

  it('returns correct analysis for bare subshell', () => {
    const a = analyzeShellCommand('(curl http://evil.example)');
    expect(a.blocksBroadAllow).toBe(true);
    expect(a.features.hasSubshellExecution).toBe(true);
    expect(a.features.hasNestedExecution).toBe(true);
  });

  it('preserves original command', () => {
    const cmd = 'echo hello';
    const a = analyzeShellCommand(cmd);
    expect(a.original).toBe(cmd);
  });

  it('deduplicates executable segments', () => {
    // If scanner and parser return the same segment, it should appear once
    const a = analyzeShellCommand('cd /tmp && rm -rf x');
    const counts = new Map<string, number>();
    for (const seg of a.executableSegments) {
      counts.set(seg, (counts.get(seg) || 0) + 1);
    }
    for (const [, count] of counts) {
      expect(count).toBe(1);
    }
  });
});
