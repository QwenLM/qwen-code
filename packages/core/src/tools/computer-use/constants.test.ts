import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PINNED_OPEN_COMPUTER_USE_PACKAGE_NAME,
  PINNED_OPEN_COMPUTER_USE_VERSION,
  resolveComputerUsePackageSpec,
} from './constants.js';

describe('computer-use constants', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['QWEN_COMPUTER_USE_PACKAGE'];
    delete process.env['QWEN_COMPUTER_USE_PACKAGE'];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['QWEN_COMPUTER_USE_PACKAGE'];
    } else {
      process.env['QWEN_COMPUTER_USE_PACKAGE'] = originalEnv;
    }
  });

  describe('PINNED_OPEN_COMPUTER_USE_VERSION', () => {
    it('is an exact version (no range modifiers)', () => {
      // Regression guard: the pin is an exact version, NOT `^x.y.z`,
      // NOT `~x.y.z`, NOT `latest`, NOT `*`. Locking the schema surface
      // requires an exact pin — upstream is 0.x and may ship
      // schema-affecting patches.
      expect(PINNED_OPEN_COMPUTER_USE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('does not contain dist-tags or wildcards', () => {
      expect(PINNED_OPEN_COMPUTER_USE_VERSION).not.toContain('latest');
      expect(PINNED_OPEN_COMPUTER_USE_VERSION).not.toContain('next');
      expect(PINNED_OPEN_COMPUTER_USE_VERSION).not.toContain('*');
      expect(PINNED_OPEN_COMPUTER_USE_VERSION).not.toContain('^');
      expect(PINNED_OPEN_COMPUTER_USE_VERSION).not.toContain('~');
    });
  });

  describe('PINNED_OPEN_COMPUTER_USE_PACKAGE_NAME', () => {
    it('is the scoped QwenLM fork package', () => {
      expect(PINNED_OPEN_COMPUTER_USE_PACKAGE_NAME).toBe(
        '@qwen-code/open-computer-use',
      );
    });
  });

  describe('resolveComputerUsePackageSpec', () => {
    it('defaults to <PACKAGE_NAME>@<PINNED_VERSION> when env var is unset', () => {
      expect(resolveComputerUsePackageSpec()).toBe(
        `${PINNED_OPEN_COMPUTER_USE_PACKAGE_NAME}@${PINNED_OPEN_COMPUTER_USE_VERSION}`,
      );
    });

    it('honors QWEN_COMPUTER_USE_PACKAGE override', () => {
      process.env['QWEN_COMPUTER_USE_PACKAGE'] =
        '@qwen-code/open-computer-use@0.99.99';
      expect(resolveComputerUsePackageSpec()).toBe(
        '@qwen-code/open-computer-use@0.99.99',
      );
    });

    it('reads env var at call time (not at module load)', () => {
      // Different overrides between calls should both be picked up —
      // tests that mutate the env var must see fresh values per call.
      process.env['QWEN_COMPUTER_USE_PACKAGE'] = 'spec-a';
      expect(resolveComputerUsePackageSpec()).toBe('spec-a');
      process.env['QWEN_COMPUTER_USE_PACKAGE'] = 'spec-b';
      expect(resolveComputerUsePackageSpec()).toBe('spec-b');
    });
  });
});
