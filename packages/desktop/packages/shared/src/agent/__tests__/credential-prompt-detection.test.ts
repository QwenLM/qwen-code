/**
 * Tests for credential prompt mode auto-detection
 *
 * These tests verify that:
 * - Multi-header mode is auto-detected when source has headerNames
 * - Single header mode is used when no headerNames
 * - Explicitly passed headerNames take precedence over source config
 */

import { describe, test, expect } from 'bun:test';
import {
  detectCredentialMode,
  getEffectiveHeaderNames,
} from '../../../../session-tools-core/src/source-helpers.ts';
import type { CredentialInputMode } from '../../../../session-tools-core/src/types.ts';

describe('detectCredentialMode', () => {
  test('should auto-upgrade to multi-header when source has headerNames', () => {
    const source = {
      api: {
        headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
      },
    };

    const result = detectCredentialMode(source, 'header');

    expect(result).toBe('multi-header');
  });

  test('should use single header mode when source has no headerNames', () => {
    const source = {
      api: {
        // No headerNames - single header or other auth
      },
    };

    const result = detectCredentialMode(source, 'header');

    expect(result).toBe('header');
  });

  test('should use requested mode when source has empty headerNames array', () => {
    const source = {
      api: {
        headerNames: [], // Empty array
      },
    };

    const result = detectCredentialMode(source, 'bearer');

    expect(result).toBe('bearer');
  });

  test('should handle null source gracefully', () => {
    const result = detectCredentialMode(null, 'header');

    expect(result).toBe('header');
  });

  test('should handle source with no api config', () => {
    const source = {};

    const result = detectCredentialMode(source, 'bearer');

    expect(result).toBe('bearer');
  });

  test('should use explicitly passed headerNames over source config', () => {
    const source = {
      api: {
        // Source has no headerNames
      },
    };

    // But we explicitly pass headerNames
    const result = detectCredentialMode(source, 'header', ['X-API-Key', 'X-App-Key']);

    expect(result).toBe('multi-header');
  });

  test('should prefer passed headerNames even when source has different ones', () => {
    const source = {
      api: {
        headerNames: ['Source-Header-1', 'Source-Header-2'],
      },
    };

    // Explicitly pass different headerNames
    const result = detectCredentialMode(source, 'header', ['Override-Header']);

    expect(result).toBe('multi-header');
  });

  test('should preserve other modes when no headerNames anywhere', () => {
    const modes: CredentialInputMode[] = ['bearer', 'basic', 'header', 'query'];

    for (const mode of modes) {
      const result = detectCredentialMode({}, mode);
      expect(result).toBe(mode);
    }
  });
});

describe('getEffectiveHeaderNames', () => {
  test('should return source headerNames when no explicit ones provided', () => {
    const source = {
      api: {
        headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
      },
    };

    const result = getEffectiveHeaderNames(source);

    expect(result).toEqual(['DD-API-KEY', 'DD-APPLICATION-KEY']);
  });

  test('should return explicit headerNames when provided', () => {
    const source = {
      api: {
        headerNames: ['Source-Header'],
      },
    };

    const result = getEffectiveHeaderNames(source, ['Explicit-Header-1', 'Explicit-Header-2']);

    expect(result).toEqual(['Explicit-Header-1', 'Explicit-Header-2']);
  });

  test('should return undefined when no headerNames anywhere', () => {
    const source = {
      api: {},
    };

    const result = getEffectiveHeaderNames(source);

    expect(result).toBeUndefined();
  });

  test('should handle null source', () => {
    const result = getEffectiveHeaderNames(null);

    expect(result).toBeUndefined();
  });

  test('should return explicit headerNames even for null source', () => {
    const result = getEffectiveHeaderNames(null, ['Header-1', 'Header-2']);

    expect(result).toEqual(['Header-1', 'Header-2']);
  });
});

describe('Real-world scenarios', () => {
  test('Datadog source should auto-detect multi-header mode', () => {
    const datadogSource = {
      api: {
        baseUrl: 'https://api.datadoghq.com/',
        authType: 'header',
        headerNames: ['DD-API-KEY', 'DD-APPLICATION-KEY'],
      },
    };

    const mode = detectCredentialMode(datadogSource, 'header');
    const headerNames = getEffectiveHeaderNames(datadogSource);

    expect(mode).toBe('multi-header');
    expect(headerNames).toEqual(['DD-API-KEY', 'DD-APPLICATION-KEY']);
  });

  test('Simple API key source should use header mode', () => {
    // Source without headerNames - only the api.headerNames field matters for detection
    const simpleSource = {
      api: {
        // No headerNames property
      },
    };

    const mode = detectCredentialMode(simpleSource, 'header');
    const headerNames = getEffectiveHeaderNames(simpleSource);

    expect(mode).toBe('header');
    expect(headerNames).toBeUndefined();
  });

  test('Agent explicitly requesting multi-header for unknown source', () => {
    // Agent might call the tool with explicit headerNames even if source is not found
    const mode = detectCredentialMode(null, 'header', ['Custom-Key', 'Custom-Secret']);
    const headerNames = getEffectiveHeaderNames(null, ['Custom-Key', 'Custom-Secret']);

    expect(mode).toBe('multi-header');
    expect(headerNames).toEqual(['Custom-Key', 'Custom-Secret']);
  });
});

describe('Edge cases', () => {
  test('should handle headerNames with single entry', () => {
    const source = {
      api: {
        headerNames: ['Single-Header'],
      },
    };

    // Single entry still counts as multi-header
    const mode = detectCredentialMode(source, 'header');
    expect(mode).toBe('multi-header');
  });

  test('should handle empty string in headerNames array', () => {
    const source = {
      api: {
        headerNames: ['', 'Valid-Header'],
      },
    };

    // Array is not empty, so still multi-header
    const mode = detectCredentialMode(source, 'header');
    expect(mode).toBe('multi-header');
  });

  test('should preserve basic auth mode even with headerNames', () => {
    // This is a theoretical edge case - basic auth shouldn't have headerNames
    // but the function should still work
    const source = {
      api: {
        headerNames: ['Weird-Header'],
      },
    };

    // headerNames presence forces multi-header regardless of requested mode
    const mode = detectCredentialMode(source, 'basic');
    expect(mode).toBe('multi-header');
  });
});
