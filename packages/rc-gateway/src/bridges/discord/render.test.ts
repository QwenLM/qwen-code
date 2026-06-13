/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  renderPermissionRequest,
  subActorOf,
  buildCustomId,
  parseCustomId,
  outcomeFor,
  BUTTON_STYLE,
  COMPONENT_TYPE,
} from './render.js';

describe('discord render — sub-actor identity', () => {
  it('carries a 19-digit snowflake verbatim as a string (never Number())', () => {
    // 111122223333444455 > Number.MAX_SAFE_INTEGER — coercion would corrupt it.
    const snowflake = '111122223333444455';
    expect(subActorOf(snowflake)).toBe('discord:111122223333444455');
    // Round-trip through the rendered id must not have rounded.
    expect(subActorOf(snowflake).endsWith('444455')).toBe(true);
  });
});

describe('discord render — custom_id round-trip', () => {
  it('builds and parses vote custom_ids', () => {
    expect(buildCustomId('approve', 'req_xyz')).toBe('vote:approve:req_xyz');
    expect(parseCustomId('vote:approve:req_xyz')).toEqual({
      action: 'approve',
      requestId: 'req_xyz',
    });
    expect(parseCustomId('vote:deny:req_1')).toEqual({
      action: 'deny',
      requestId: 'req_1',
    });
  });

  it('rejects foreign / malformed custom_ids', () => {
    expect(parseCustomId(undefined)).toBeNull();
    expect(parseCustomId('something:else')).toBeNull();
    expect(parseCustomId('vote:maybe:req')).toBeNull();
    expect(parseCustomId('vote:approve:')).toBeNull(); // empty id
  });

  it('maps actions to gateway outcomes', () => {
    expect(outcomeFor('approve')).toBe('allow_once');
    expect(outcomeFor('deny')).toBe('cancelled');
  });
});

describe('discord render — permission_request (inline)', () => {
  it('renders content + an ActionRow with Approve/Deny buttons', () => {
    const msg = renderPermissionRequest(
      {
        requestId: 'req_xyz',
        bridgeHints: {
          recommendedSurface: 'inline',
          argsSummaryShort: 'Edit src/auth.ts',
        },
      },
      { baseUrl: 'http://127.0.0.1:4170' },
    );

    expect(msg.content).toContain('Edit src/auth.ts');
    expect(msg.components).toHaveLength(1);
    const row = msg.components[0];
    expect(row.type).toBe(COMPONENT_TYPE.actionRow);
    expect(row.components).toHaveLength(2);

    const [approve, deny] = row.components;
    expect(approve.style).toBe(BUTTON_STYLE.success);
    expect(approve.custom_id).toBe('vote:approve:req_xyz');
    expect(approve.url).toBeUndefined();
    expect(deny.style).toBe(BUTTON_STYLE.danger);
    expect(deny.custom_id).toBe('vote:deny:req_xyz');
  });

  it('defaults to inline when no surface hint is present', () => {
    const msg = renderPermissionRequest(
      { requestId: 'req_1', bridgeHints: { argsSummaryShort: 'do a thing' } },
      { baseUrl: 'http://x' },
    );
    expect(msg.components[0].components).toHaveLength(2);
    expect(msg.components[0].components[0].custom_id).toBe(
      'vote:approve:req_1',
    );
  });

  it('clamps an over-long custom_id to inert rather than emitting an invalid one', () => {
    const longId = 'r'.repeat(200);
    const msg = renderPermissionRequest(
      {
        requestId: longId,
        bridgeHints: { recommendedSurface: 'inline', argsSummaryShort: 'x' },
      },
      { baseUrl: 'http://x' },
    );
    // vote:approve:<200 chars> exceeds Discord's 100-char custom_id cap → inert.
    expect(msg.components[0].components[0].custom_id).toBe('');
  });

  it('falls back to a generic summary when argsSummaryShort is missing', () => {
    const msg = renderPermissionRequest(
      { requestId: 'req_1', bridgeHints: { recommendedSurface: 'inline' } },
      { baseUrl: 'http://x' },
    );
    expect(msg.content).toContain('A tool wants to run.');
  });
});

describe('discord render — permission_request (deeplink)', () => {
  it('renders a single Link button to the web client and OMITS argsSummaryFull', () => {
    const full = 'SECRET-FULL-ARGS-' + 'z'.repeat(800);
    const msg = renderPermissionRequest(
      {
        requestId: 'req_xyz',
        bridgeHints: {
          recommendedSurface: 'deeplink',
          argsSummaryShort: 'Edit src/auth.ts',
          argsSummaryFull: full,
        },
      },
      { baseUrl: 'http://127.0.0.1:4170/' },
    );

    expect(msg.content).toContain('Edit src/auth.ts');
    // The full args must never reach the channel in deeplink mode.
    expect(msg.content).not.toContain('SECRET-FULL-ARGS');
    expect(JSON.stringify(msg)).not.toContain('SECRET-FULL-ARGS');

    expect(msg.components).toHaveLength(1);
    const row = msg.components[0];
    expect(row.components).toHaveLength(1);
    const btn = row.components[0];
    expect(btn.style).toBe(BUTTON_STYLE.link);
    expect(btn.label).toBe('Open in web client');
    expect(btn.custom_id).toBeUndefined();
    // Trailing slash on baseUrl normalized; requestId path-encoded.
    expect(btn.url).toBe('http://127.0.0.1:4170/ui/permission/req_xyz');
  });

  it('path-encodes a requestId with unsafe characters in the deeplink', () => {
    const msg = renderPermissionRequest(
      {
        requestId: 'a/b c',
        bridgeHints: { recommendedSurface: 'deeplink', argsSummaryShort: 'x' },
      },
      { baseUrl: 'http://x' },
    );
    expect(msg.components[0].components[0].url).toBe(
      'http://x/ui/permission/a%2Fb%20c',
    );
  });
});
