/**
 * Test that buildAuthorizationHeader correctly handles empty authScheme
 *
 * This tests the actual exported function from api-tools.ts to ensure
 * the production code behaves correctly.
 */

import { describe, it, expect } from 'bun:test';
import { buildAuthorizationHeader } from '../api-tools.ts';

describe('buildAuthorizationHeader', () => {
  const token = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test';

  it('defaults to Bearer prefix when authScheme is undefined', () => {
    expect(buildAuthorizationHeader(undefined, token)).toBe(`Bearer ${token}`);
  });

  it('uses custom prefix when authScheme is provided', () => {
    expect(buildAuthorizationHeader('Token', token)).toBe(`Token ${token}`);
    expect(buildAuthorizationHeader('ApiKey', token)).toBe(`ApiKey ${token}`);
  });

  it('sends token without prefix when authScheme is empty string', () => {
    // This is the critical case: empty string should NOT add a prefix
    // Some APIs (GraphQL endpoints, internal services) expect raw tokens
    expect(buildAuthorizationHeader('', token)).toBe(token);
    expect(buildAuthorizationHeader('', token)).not.toContain('Bearer');
    expect(buildAuthorizationHeader('', token)).not.toContain(' ');
  });

  it('handles null by defaulting to Bearer (via nullish coalescing)', () => {
    // TypeScript wouldn't allow null, but test runtime behavior
    expect(buildAuthorizationHeader(null as unknown as undefined, token)).toBe(`Bearer ${token}`);
  });
});
