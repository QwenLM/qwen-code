/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isShellCommandReadOnly } from './shellReadOnlyChecker.js';

describe('evaluateShellCommandReadOnly', () => {
  it('allows simple read-only command', () => {
    const result = isShellCommandReadOnly('ls -la');
    expect(result).toBe(true);
  });

  it('rejects mutating commands like rm', () => {
    const result = isShellCommandReadOnly('rm -rf temp');
    expect(result).toBe(false);
  });

  it('rejects redirection output', () => {
    const result = isShellCommandReadOnly('ls > out.txt');
    expect(result).toBe(false);
  });

  it('rejects command substitution', () => {
    const result = isShellCommandReadOnly('echo $(touch file)');
    expect(result).toBe(false);
  });

  it('allows git status but rejects git commit', () => {
    expect(isShellCommandReadOnly('git status')).toBe(true);
    const commitResult = isShellCommandReadOnly('git commit -am "msg"');
    expect(commitResult).toBe(false);
  });

  it('rejects find with exec', () => {
    const result = isShellCommandReadOnly('find . -exec rm {} \\;');
    expect(result).toBe(false);
  });

  it('rejects sed in-place', () => {
    const result = isShellCommandReadOnly("sed -i 's/foo/bar/' file");
    expect(result).toBe(false);
  });

  it('rejects empty command', () => {
    const result = isShellCommandReadOnly('   ');
    expect(result).toBe(false);
  });

  it('respects environment prefix followed by allowed command', () => {
    const result = isShellCommandReadOnly('FOO=bar ls');
    expect(result).toBe(true);
  });

  describe('awk command security', () => {
    it('allows safe awk commands', () => {
      expect(isShellCommandReadOnly("awk '{print $1}' file.txt")).toBe(true);
      expect(isShellCommandReadOnly('awk \'BEGIN {print "hello"}\'')).toBe(
        true,
      );
      expect(isShellCommandReadOnly("awk '/pattern/ {print}' file.txt")).toBe(
        true,
      );
    });

    it('rejects awk with system() calls', () => {
      expect(isShellCommandReadOnly('awk \'BEGIN {system("rm -rf /")}\'')).toBe(
        false,
      );
      expect(
        isShellCommandReadOnly('awk \'{system("touch file")}\' input.txt'),
      ).toBe(false);
      expect(isShellCommandReadOnly('awk \'BEGIN { system ( "ls" ) }\'')).toBe(
        false,
      );
    });

    it('rejects awk with file output redirection', () => {
      expect(
        isShellCommandReadOnly('awk \'{print > "output.txt"}\' input.txt'),
      ).toBe(false);
      expect(
        isShellCommandReadOnly('awk \'{printf "%s\\n", $0 > "file.txt"}\''),
      ).toBe(false);
      expect(
        isShellCommandReadOnly('awk \'{print >> "append.txt"}\' input.txt'),
      ).toBe(false);
      expect(
        isShellCommandReadOnly('awk \'{printf "%s" >> "file.txt"}\''),
      ).toBe(false);
    });

    it('rejects awk with command pipes', () => {
      expect(isShellCommandReadOnly('awk \'{print | "sort"}\' input.txt')).toBe(
        false,
      );
      expect(
        isShellCommandReadOnly('awk \'{printf "%s\\n", $0 | "wc -l"}\''),
      ).toBe(false);
    });

    it('rejects awk with getline from commands', () => {
      expect(isShellCommandReadOnly('awk \'BEGIN {getline < "date"}\'')).toBe(
        false,
      );
      expect(isShellCommandReadOnly('awk \'BEGIN {"date" | getline}\'')).toBe(
        false,
      );
    });

    it('rejects awk with close() calls', () => {
      expect(isShellCommandReadOnly('awk \'BEGIN {close("file")}\'')).toBe(
        false,
      );
      expect(isShellCommandReadOnly("awk '{close(cmd)}' input.txt")).toBe(
        false,
      );
    });
  });

  describe('sed command security', () => {
    it('allows safe sed commands', () => {
      expect(isShellCommandReadOnly("sed 's/foo/bar/' file.txt")).toBe(true);
      expect(isShellCommandReadOnly("sed -n '1,5p' file.txt")).toBe(true);
      expect(isShellCommandReadOnly("sed '/pattern/d' file.txt")).toBe(true);
    });

    it('rejects sed with execute command', () => {
      expect(isShellCommandReadOnly("sed 's/foo/bar/e' file.txt")).toBe(false);
      expect(isShellCommandReadOnly("sed 'e date' file.txt")).toBe(false);
    });

    it('rejects sed with write command', () => {
      expect(
        isShellCommandReadOnly("sed 's/foo/bar/w output.txt' file.txt"),
      ).toBe(false);
      expect(isShellCommandReadOnly("sed 'w backup.txt' file.txt")).toBe(false);
    });

    it('rejects sed with read command', () => {
      expect(
        isShellCommandReadOnly("sed 's/foo/bar/r input.txt' file.txt"),
      ).toBe(false);
      expect(isShellCommandReadOnly("sed 'r header.txt' file.txt")).toBe(false);
    });

    it('still rejects sed in-place editing', () => {
      expect(isShellCommandReadOnly("sed -i 's/foo/bar/' file.txt")).toBe(
        false,
      );
      expect(
        isShellCommandReadOnly("sed --in-place 's/foo/bar/' file.txt"),
      ).toBe(false);
    });
  });
});
