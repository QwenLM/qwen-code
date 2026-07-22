/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { sanitizeRetrievalQuery } from './semantic-index.js';

describe('sanitizeRetrievalQuery', () => {
  it('removes code, credentials, JWTs, and long high-entropy tokens', () => {
    const value = sanitizeRetrievalQuery(
      [
        'How should this repository build?',
        '```ts\nconst secret = true;\n```',
        'ghp_abcdefghijklmnopqrstuvwxyz123456',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature123',
        'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5z',
      ].join(' '),
    );

    expect(value).toBe('How should this repository build?');
  });
});
