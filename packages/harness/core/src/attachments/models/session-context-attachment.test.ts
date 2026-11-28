/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createAttachmentMessage } from '../factory.js';
import { normalizeMessagesForAPI } from '../../protocol/provider/request-converter.js';
import {
  SessionContextAttachment,
  type SessionContextReason,
} from './session-context-attachment.js';

const text = (
  data: ConstructorParameters<typeof SessionContextAttachment>[0],
) =>
  JSON.stringify(
    normalizeMessagesForAPI([
      createAttachmentMessage(new SessionContextAttachment(data)),
    ]),
  );

describe('session context change projection', () => {
  it('renders a complete snapshot in stable field order', () => {
    const output = text({
      type: 'session_context',
      context: {
        perforceMode: 'Perforce workspace',
        gitStatus: 'Git snapshot',
        attachedProject: 'Project',
        userEmail: 'user@example.test',
      },
    });
    expect(output).toContain("As you answer the user's questions");
    expect(output.indexOf('# userEmail')).toBeLessThan(
      output.indexOf('# attachedProject'),
    );
    expect(output.indexOf('# attachedProject')).toBeLessThan(
      output.indexOf('# gitStatus'),
    );
    expect(output.indexOf('# gitStatus')).toBeLessThan(
      output.indexOf('# perforceMode'),
    );
  });

  it.each([
    ['session_start', 'when this session started'],
    ['compaction', 'after the conversation was compacted'],
    ['policy_refresh', "after the organization's managed settings changed"],
    ['managed_folder_check', "after a check of this machine's managed folder"],
    ['directory_added', 'after a working directory was added'],
    ['settings_sync', 'after settings were synced onto this machine'],
    ['account_change', 'after the account changed'],
    ['hooks_invalidate', 'after a plugin had the context re-read'],
    ['policy_verdict', "after the organization's policy arrived"],
    ['project_reread', 'after an earlier read of the attached project failed'],
    ['memory_paused', 'after memory was paused for this session'],
    ['memory_resumed', 'after memory was resumed for this session'],
    ['auto_memory_off', 'after auto-memory was turned off for this session'],
    [
      'auto_memory_back_on',
      'after auto-memory was turned back on for this session',
    ],
  ] as const)('renders the %s refresh reason', (reason, description) => {
    const output = text({
      type: 'session_context',
      context: { gitStatus: 'Current values' },
      changed: true,
      reason,
    });
    expect(output).toContain(
      `The session context was re-read ${description}; these values replace the earlier ones:`,
    );
    expect(output).toContain('Current values');
  });

  it.each([undefined, 'future_reason' as SessionContextReason])(
    'uses a generic replacement notice for unavailable reason %s',
    (reason) => {
      expect(
        text({
          type: 'session_context',
          context: { attachedProject: 'New project' },
          changed: true,
          reason,
        }),
      ).toContain(
        'The session context has changed; these values replace the earlier ones:',
      );
    },
  );

  it('announces an empty replacement instead of silently retaining old values', () => {
    expect(
      text({
        type: 'session_context',
        context: {},
        changed: true,
        reason: 'account_change',
      }),
    ).toContain(
      'The session context was re-read after the account changed; the values announced earlier (account, project, git status) no longer apply.',
    );
    expect(text({ type: 'session_context', context: {} })).toBe('[]');
  });

  it('round-trips changed and reason through transcript serialization', () => {
    const original = [
      createAttachmentMessage(
        new SessionContextAttachment({
          type: 'session_context',
          context: { gitStatus: 'Retained' },
          changed: true,
          reason: 'compaction',
        }),
      ),
    ];
    const restored = JSON.parse(JSON.stringify(original));
    expect(restored[0].attachment).toMatchObject({
      changed: true,
      reason: 'compaction',
    });
    expect(normalizeMessagesForAPI(restored)).toEqual(
      normalizeMessagesForAPI(original),
    );
  });
});
