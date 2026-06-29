/**
 * Tests for session ID validation to prevent path traversal attacks.
 * Security-critical: These tests verify protection against CVE-style vulnerabilities.
 *
 * IMPORTANT: These tests must verify BOTH:
 * 1. The validation functions work correctly (unit tests)
 * 2. The actual storage functions produce safe paths (integration tests)
 */
import { describe, it, expect } from 'bun:test';
import { join, normalize } from 'path';
import {
  validateSessionId,
  sanitizeSessionId,
  isValidSessionId,
} from '../src/sessions/validation.ts';
import {
  getSessionPath,
  getSessionAttachmentsPath,
  getSessionPlansPath,
  getSessionDownloadsPath,
} from '../src/sessions/storage.ts';

// ============================================================
// validateSessionId
// ============================================================

describe('validateSessionId', () => {
  describe('valid session IDs', () => {
    it('accepts standard generated session IDs', () => {
      expect(() => validateSessionId('260202-swift-river')).not.toThrow();
      expect(() => validateSessionId('250115-happy-mountain')).not.toThrow();
    });

    it('accepts alphanumeric IDs', () => {
      expect(() => validateSessionId('abc123')).not.toThrow();
      expect(() => validateSessionId('session1')).not.toThrow();
    });

    it('accepts IDs with hyphens', () => {
      expect(() => validateSessionId('my-session-id')).not.toThrow();
      expect(() => validateSessionId('a-b-c')).not.toThrow();
    });

    it('accepts IDs with underscores', () => {
      expect(() => validateSessionId('my_session_id')).not.toThrow();
      expect(() => validateSessionId('session_1_test')).not.toThrow();
    });

    it('accepts mixed format IDs', () => {
      expect(() => validateSessionId('session_2024-01-15_test')).not.toThrow();
    });
  });

  describe('path traversal attacks', () => {
    it('rejects simple path traversal', () => {
      expect(() => validateSessionId('../etc/passwd')).toThrow('Security Error');
      expect(() => validateSessionId('../../tmp')).toThrow('Security Error');
    });

    it('rejects deep path traversal', () => {
      expect(() => validateSessionId('../../../../tmp')).toThrow('Security Error');
      expect(() => validateSessionId('../../../../../../../tmp')).toThrow('Security Error');
    });

    it('rejects path traversal in middle of string', () => {
      expect(() => validateSessionId('session/../../../tmp')).toThrow('Security Error');
      expect(() => validateSessionId('foo/../bar')).toThrow('Security Error');
    });

    it('rejects absolute paths', () => {
      expect(() => validateSessionId('/tmp/evil')).toThrow('Security Error');
      expect(() => validateSessionId('/etc/passwd')).toThrow('Security Error');
    });

    it('rejects Windows-style paths', () => {
      expect(() => validateSessionId('C:\\Windows\\System32')).toThrow('Security Error');
      expect(() => validateSessionId('..\\..\\tmp')).toThrow('Security Error');
    });
  });

  describe('invalid formats', () => {
    it('rejects empty string', () => {
      expect(() => validateSessionId('')).toThrow('Security Error');
    });

    it('rejects null/undefined', () => {
      expect(() => validateSessionId(null as unknown as string)).toThrow('Security Error');
      expect(() => validateSessionId(undefined as unknown as string)).toThrow('Security Error');
    });

    it('rejects IDs with spaces', () => {
      expect(() => validateSessionId('session id')).toThrow('Security Error');
      expect(() => validateSessionId('my session')).toThrow('Security Error');
    });

    it('rejects IDs with special characters', () => {
      expect(() => validateSessionId('session@id')).toThrow('Security Error');
      expect(() => validateSessionId('session#1')).toThrow('Security Error');
      expect(() => validateSessionId('session$test')).toThrow('Security Error');
    });

    it('rejects IDs with dots (potential hidden file/traversal)', () => {
      expect(() => validateSessionId('.hidden')).toThrow('Security Error');
      expect(() => validateSessionId('..double')).toThrow('Security Error');
      expect(() => validateSessionId('session.name')).toThrow('Security Error');
    });
  });
});

// ============================================================
// sanitizeSessionId
// ============================================================

describe('sanitizeSessionId', () => {
  it('returns valid IDs unchanged', () => {
    expect(sanitizeSessionId('260202-swift-river')).toBe('260202-swift-river');
    expect(sanitizeSessionId('abc123')).toBe('abc123');
  });

  it('strips path traversal components', () => {
    expect(sanitizeSessionId('../../../tmp')).toBe('tmp');
    expect(sanitizeSessionId('foo/../bar')).toBe('bar');
    expect(sanitizeSessionId('../../etc/passwd')).toBe('passwd');
  });

  it('returns empty string for null/undefined', () => {
    expect(sanitizeSessionId(null as unknown as string)).toBe('');
    expect(sanitizeSessionId(undefined as unknown as string)).toBe('');
  });

  it('returns basename for absolute paths', () => {
    expect(sanitizeSessionId('/tmp/evil')).toBe('evil');
    expect(sanitizeSessionId('/etc/passwd')).toBe('passwd');
  });
});

// ============================================================
// isValidSessionId
// ============================================================

describe('isValidSessionId', () => {
  it('returns true for valid session IDs', () => {
    expect(isValidSessionId('260202-swift-river')).toBe(true);
    expect(isValidSessionId('abc123')).toBe(true);
    expect(isValidSessionId('my_session')).toBe(true);
  });

  it('returns false for path traversal attempts', () => {
    expect(isValidSessionId('../../../tmp')).toBe(false);
    expect(isValidSessionId('../../../../etc/passwd')).toBe(false);
  });

  it('returns false for invalid formats', () => {
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId('session id')).toBe(false);
    expect(isValidSessionId('session@id')).toBe(false);
  });
});

// ============================================================
// INTEGRATION TESTS - Test actual storage functions
// These verify the REAL code path is protected
// ============================================================

describe('getSessionPath - defense in depth', () => {
  const workspaceRoot = '/Users/test/.craft-agent/workspaces/test-workspace';
  const expectedSessionsDir = `${workspaceRoot}/sessions`;

  it('returns correct path for valid session IDs', () => {
    const result = getSessionPath(workspaceRoot, '260202-swift-river');
    expect(result).toBe(`${expectedSessionsDir}/260202-swift-river`);
  });

  it('sanitizes path traversal attempts - path stays within workspace', () => {
    // Even if validation is bypassed, defense-in-depth should protect
    const result = getSessionPath(workspaceRoot, '../../../tmp');

    // The path should NOT escape the sessions directory
    expect(result).toBe(`${expectedSessionsDir}/tmp`);
    expect(result.startsWith(expectedSessionsDir)).toBe(true);

    // Verify it doesn't contain path traversal
    expect(result.includes('..')).toBe(false);
  });

  it('sanitizes deep path traversal - stays within workspace', () => {
    const result = getSessionPath(workspaceRoot, '../../../../../../../../tmp');
    expect(result).toBe(`${expectedSessionsDir}/tmp`);
    expect(result.startsWith(expectedSessionsDir)).toBe(true);
  });

  it('sanitizes absolute path attempts', () => {
    const result = getSessionPath(workspaceRoot, '/etc/passwd');
    expect(result).toBe(`${expectedSessionsDir}/passwd`);
    expect(result.startsWith(expectedSessionsDir)).toBe(true);
  });

  it('sanitizes mixed traversal attempts', () => {
    const result = getSessionPath(workspaceRoot, 'foo/../../../etc/passwd');
    // basename() returns 'passwd' for this input
    expect(result).toBe(`${expectedSessionsDir}/passwd`);
    expect(result.startsWith(expectedSessionsDir)).toBe(true);
  });
});

describe('getSessionAttachmentsPath - defense in depth', () => {
  const workspaceRoot = '/Users/test/.craft-agent/workspaces/test-workspace';
  const expectedSessionsDir = `${workspaceRoot}/sessions`;

  it('returns correct path for valid session IDs', () => {
    const result = getSessionAttachmentsPath(workspaceRoot, '260202-swift-river');
    expect(result).toBe(`${expectedSessionsDir}/260202-swift-river/attachments`);
  });

  it('sanitizes path traversal - attachments path stays within workspace', () => {
    const result = getSessionAttachmentsPath(workspaceRoot, '../../../tmp');

    // Should resolve to sessions/tmp/attachments, NOT /tmp/attachments
    expect(result).toBe(`${expectedSessionsDir}/tmp/attachments`);
    expect(result.startsWith(expectedSessionsDir)).toBe(true);
    expect(result.includes('..')).toBe(false);
  });

  it('prevents the exact PoC attack from security report', () => {
    // This is the exact payload from the security researcher's report
    const maliciousSessionId = '../../../../../../../../tmp';
    const result = getSessionAttachmentsPath(workspaceRoot, maliciousSessionId);

    // CRITICAL: Must NOT resolve to /tmp/attachments
    expect(result).not.toBe('/tmp/attachments');
    expect(result).toBe(`${expectedSessionsDir}/tmp/attachments`);
    expect(result.startsWith(expectedSessionsDir)).toBe(true);
  });
});

describe('getSessionPlansPath - defense in depth', () => {
  const workspaceRoot = '/Users/test/.craft-agent/workspaces/test-workspace';
  const expectedSessionsDir = `${workspaceRoot}/sessions`;

  it('sanitizes path traversal attempts', () => {
    const result = getSessionPlansPath(workspaceRoot, '../../../tmp');
    expect(result).toBe(`${expectedSessionsDir}/tmp/plans`);
    expect(result.startsWith(expectedSessionsDir)).toBe(true);
  });
});

describe('getSessionDownloadsPath - defense in depth', () => {
  const workspaceRoot = '/Users/test/.craft-agent/workspaces/test-workspace';
  const expectedSessionsDir = `${workspaceRoot}/sessions`;

  it('sanitizes path traversal attempts', () => {
    const result = getSessionDownloadsPath(workspaceRoot, '../../../tmp');
    expect(result).toBe(`${expectedSessionsDir}/tmp/downloads`);
    expect(result.startsWith(expectedSessionsDir)).toBe(true);
  });
});

// ============================================================
// CRITICAL: Verify path normalization doesn't reintroduce vulnerability
// ============================================================

describe('path normalization safety', () => {
  const workspaceRoot = '/Users/test/.craft-agent/workspaces/test-workspace';

  it('normalized path still stays within workspace', () => {
    const result = getSessionPath(workspaceRoot, '../../../tmp');
    const normalized = normalize(result);

    // Even after normalization, path should be safe
    expect(normalized.startsWith(workspaceRoot)).toBe(true);
  });

  it('join() with sanitized input produces safe path', () => {
    // Simulate what happens in the real code
    const maliciousInput = '../../../../tmp';
    const sanitized = sanitizeSessionId(maliciousInput); // Returns 'tmp'
    const result = join(workspaceRoot, 'sessions', sanitized);

    expect(result).toBe(`${workspaceRoot}/sessions/tmp`);
    expect(result.startsWith(workspaceRoot)).toBe(true);
  });
});
