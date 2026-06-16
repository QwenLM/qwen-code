/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  renderPermissionRequest,
  renderResolveEdit,
  subActorOf,
  voteForReaction,
  normalizeReactionKey,
  outcomeFor,
  tracksReactions,
} from './render.js';

describe('matrix render — sub-actor identity', () => {
  it('carries the fully-qualified MXID verbatim (never stripped)', () => {
    expect(subActorOf('@alice:home.example.com')).toBe(
      'matrix:@alice:home.example.com',
    );
    // Federated user: homeserver suffix must survive.
    expect(subActorOf('@alice:other-server.org')).toBe(
      'matrix:@alice:other-server.org',
    );
  });
});

describe('matrix render — reaction key → vote', () => {
  it('maps plain 👍/👎 to approve/deny', () => {
    expect(voteForReaction('\u{1F44D}')).toBe('approve');
    expect(voteForReaction('\u{1F44E}')).toBe('deny');
  });

  it('matches the variation-selector form (👍\\uFE0F) that clients actually send', () => {
    expect(voteForReaction('\u{1F44D}️')).toBe('approve');
    expect(voteForReaction('\u{1F44E}️')).toBe('deny');
  });

  it('matches skin-tone-modified thumbs (👍🏽)', () => {
    expect(voteForReaction('\u{1F44D}\u{1F3FD}')).toBe('approve');
    expect(voteForReaction('\u{1F44E}\u{1F3FF}')).toBe('deny');
  });

  it('ignores any other reaction', () => {
    expect(voteForReaction('❤️')).toBeNull(); // ❤️
    expect(voteForReaction('🎉')).toBeNull();
    expect(voteForReaction('')).toBeNull();
  });

  it('normalizeReactionKey strips variation selector and skin tone', () => {
    expect(normalizeReactionKey('\u{1F44D}️')).toBe('\u{1F44D}');
    expect(normalizeReactionKey('\u{1F44D}\u{1F3FD}')).toBe('\u{1F44D}');
  });

  it('maps votes to gateway outcomes', () => {
    expect(outcomeFor('approve')).toBe('allow_once');
    expect(outcomeFor('deny')).toBe('cancelled');
  });
});

describe('matrix render — permission_request (inline)', () => {
  it('renders argsSummaryShort + the reaction instruction', () => {
    const msg = renderPermissionRequest(
      {
        requestId: 'req_xyz',
        bridgeHints: {
          recommendedSurface: 'inline',
          argsSummaryShort: 'Edit auth.ts',
        },
      },
      { baseUrl: 'http://127.0.0.1:4170' },
    );
    expect(msg.msgtype).toBe('m.text');
    expect(msg.body).toContain('Edit auth.ts');
    expect(msg.body).toContain('React 👍 to approve, 👎 to deny');
  });

  it('defaults to inline + a generic summary when hints are absent', () => {
    const msg = renderPermissionRequest({ requestId: 'r' }, { baseUrl: 'x' });
    expect(msg.body).toContain('A tool wants to run.');
    expect(msg.body).toContain('React 👍');
  });

  it('tracksReactions is true for inline', () => {
    expect(
      tracksReactions({ bridgeHints: { recommendedSurface: 'inline' } }),
    ).toBe(true);
  });
});

describe('matrix render — permission_request (deeplink)', () => {
  it('renders a web-client URL, OMITS the reaction prompt and argsSummaryFull', () => {
    const full = 'SECRET-FULL-' + 'z'.repeat(800);
    const msg = renderPermissionRequest(
      {
        requestId: 'req_xyz',
        bridgeHints: {
          recommendedSurface: 'deeplink',
          argsSummaryShort: 'Edit auth.ts',
          argsSummaryFull: full,
        },
      },
      { baseUrl: 'http://127.0.0.1:4170/' },
    );
    expect(msg.body).toContain('Edit auth.ts');
    expect(msg.body).toContain(
      'Open in web client: http://127.0.0.1:4170/ui/permission/req_xyz',
    );
    expect(msg.body).not.toContain('React 👍');
    expect(msg.body).not.toContain('SECRET-FULL');
  });

  it('tracksReactions is false for deeplink (no reaction voting on sensitive calls)', () => {
    expect(
      tracksReactions({ bridgeHints: { recommendedSurface: 'deeplink' } }),
    ).toBe(false);
  });
});

describe('matrix render — resolve edit (m.replace)', () => {
  it('builds a NEW event with m.new_content + an m.replace relation', () => {
    const edit = renderResolveEdit(
      '⚠️ Tool call: Edit auth.ts',
      'm_42',
      'allow_once',
    );
    expect(edit['m.relates_to']).toEqual({
      rel_type: 'm.replace',
      event_id: 'm_42',
    });
    expect(edit['m.new_content'].body).toContain('Edit auth.ts');
    expect(edit['m.new_content'].body).toContain('Resolved: allow_once');
    // Fallback body conventionally prefixed with "* ".
    expect(edit.body.startsWith('* ')).toBe(true);
  });
});
