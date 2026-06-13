/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  subActorOf,
  buildCallbackData,
  parseCallbackData,
  outcomeFor,
  escapeMarkdownV2,
  renderPermissionRequest,
} from './render.js';

describe('telegram render helpers', () => {
  it('subActorOf formats telegram:<id>', () => {
    expect(subActorOf(12345)).toBe('telegram:12345');
  });

  it('callback_data round-trips and maps to gateway outcomes', () => {
    expect(buildCallbackData('approve', 'req_xyz')).toBe(
      'vote:approve:req_xyz',
    );
    expect(buildCallbackData('deny', 'req_xyz')).toBe('vote:deny:req_xyz');
    expect(parseCallbackData('vote:approve:req_xyz')).toEqual({
      action: 'approve',
      requestId: 'req_xyz',
    });
    expect(parseCallbackData('vote:deny:r1')?.action).toBe('deny');
    expect(outcomeFor('approve')).toBe('allow_once');
    expect(outcomeFor('deny')).toBe('cancelled');
  });

  it('parseCallbackData rejects foreign / malformed data', () => {
    expect(parseCallbackData('start:abc')).toBeNull();
    expect(parseCallbackData(undefined)).toBeNull();
    expect(parseCallbackData('vote:maybe:x')).toBeNull();
  });

  it('escapeMarkdownV2 escapes reserved chars', () => {
    expect(escapeMarkdownV2('a.b-c(d)')).toBe('a\\.b\\-c\\(d\\)');
    expect(escapeMarkdownV2('x_y*z')).toBe('x\\_y\\*z');
  });
});

describe('renderPermissionRequest', () => {
  const baseUrl = 'http://127.0.0.1:4170';

  it('inline surface → summary verbatim + Approve/Deny callback buttons', () => {
    const msg = renderPermissionRequest(
      {
        requestId: 'req_xyz',
        bridgeHints: {
          recommendedSurface: 'inline',
          argsSummaryShort: 'Edit src/auth/login.ts (+12 -3)',
        },
      },
      { baseUrl },
    );
    // Summary appears verbatim (plain text, not markdown-escaped).
    expect(msg.text).toContain('Edit src/auth/login.ts (+12 -3)');
    expect(msg.inlineKeyboard[0][0]).toEqual({
      text: 'Approve',
      callback_data: 'vote:approve:req_xyz',
    });
    expect(msg.inlineKeyboard[0][1]).toEqual({
      text: 'Deny',
      callback_data: 'vote:deny:req_xyz',
    });
  });

  it('deeplink surface → single Open button, omits full args', () => {
    const full = 'X'.repeat(800);
    const msg = renderPermissionRequest(
      {
        requestId: 'req_secret',
        bridgeHints: {
          recommendedSurface: 'deeplink',
          argsSummaryShort: 'set_env (sensitive args hidden)',
          argsSummaryFull: full,
        },
      },
      { baseUrl },
    );
    expect(msg.text).toContain('set_env (sensitive args hidden)');
    expect(msg.text).not.toContain(full); // never dumps full args to chat
    expect(msg.inlineKeyboard).toEqual([
      [
        {
          text: 'Open in web client',
          url: `${baseUrl}/ui/permission/req_secret`,
        },
      ],
    ]);
  });

  it('defaults to inline + a generic body when hints are missing', () => {
    const msg = renderPermissionRequest({ requestId: 'r1' }, { baseUrl });
    expect(msg.inlineKeyboard[0].map((b) => b.text)).toEqual([
      'Approve',
      'Deny',
    ]);
    expect(msg.text.length).toBeGreaterThan(0);
  });

  it('clamps an over-64-byte callback_data to inert rather than emitting it', () => {
    const longId = 'r'.repeat(80);
    const msg = renderPermissionRequest(
      { requestId: longId, bridgeHints: { recommendedSurface: 'inline' } },
      { baseUrl },
    );
    expect(msg.inlineKeyboard[0][0].callback_data).toBe('');
  });
});
