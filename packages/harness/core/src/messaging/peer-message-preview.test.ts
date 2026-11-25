/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { QueuedCommand } from '../input/types.js';
import { buildCrossSessionEnvelope } from './cross-session-envelope.js';
import {
  MAX_BODY_LINES,
  MAX_BODY_LINE_LENGTH,
  MAX_PREVIEW_LENGTH,
  sanitizeForDisplay,
  summarizeHeldMessage,
} from './peer-message-preview.js';

function command(prompt: QueuedCommand['prompt']): QueuedCommand {
  return { prompt, commandMode: 'prompt' };
}

/**
 * A command shaped the way the inbound path builds one: the model reads the
 * envelope, and `origin.body` carries the same text unwrapped.
 */
function peerCommand(
  body: string,
  from = 'uds:%2Ftmp%2Fqwen-socks%2F12345.sock',
): QueuedCommand {
  return {
    prompt: buildCrossSessionEnvelope({ from, body }),
    commandMode: 'prompt',
    origin: { kind: 'peer', transport: 'uds', from, body },
  };
}

function summarize(prompt: QueuedCommand['prompt'], from = 'uds:/tmp/a.sock') {
  return summarizeHeldMessage({ command: command(prompt), from });
}

describe('peer message preview', () => {
  describe('sanitizeForDisplay', () => {
    // [AC17] The realistic impersonation vectors for a terminal dialog.
    it('strips escapes, zero-width characters and box drawing', () => {
      expect(sanitizeForDisplay('a[31mred[0m')).toBe('a[31mred[0m');
      expect(sanitizeForDisplay('in​visible')).toBe('invisible');
      expect(sanitizeForDisplay('‮override')).toBe('override');
      expect(sanitizeForDisplay('─│ border')).toBe(' border');
    });

    it('keeps newlines and tabs', () => {
      expect(sanitizeForDisplay('one\ntwo\tthree')).toBe('one\ntwo\tthree');
    });

    // Deliberately not a general punctuation strip: these are ordinary
    // characters in Chinese and Japanese text, and removing them would mangle
    // the common case to defend against the rare one.
    it('leaves CJK punctuation alone', () => {
      const text = '他说「你好」——【重要】';
      expect(sanitizeForDisplay(text)).toBe(text);
    });
  });

  describe('summarizeHeldMessage', () => {
    it('collapses a preview to one bounded line', () => {
      const summary = summarize('  lots\n  of\n  whitespace  ');
      expect(summary.preview).toBe('lots of whitespace');
    });

    it('caps the preview length', () => {
      const summary = summarize('x'.repeat(MAX_PREVIEW_LENGTH + 50));
      expect(summary.preview).toHaveLength(MAX_PREVIEW_LENGTH + 1); // plus ellipsis
      expect(summary.preview.endsWith('…')).toBe(true);
    });

    // [AC17] Both bounds, and the flag that lets a surface say so.
    it('bounds the body by line count', () => {
      const summary = summarize(
        Array.from({ length: MAX_BODY_LINES + 10 }, (_, i) => `line ${i}`).join(
          '\n',
        ),
      );
      expect(summary.body.split('\n')).toHaveLength(MAX_BODY_LINES);
      expect(summary.truncated).toBe(true);
    });

    it('bounds the body by line length', () => {
      const summary = summarize('y'.repeat(MAX_BODY_LINE_LENGTH + 10));
      expect(summary.body).toHaveLength(MAX_BODY_LINE_LENGTH + 1);
      expect(summary.truncated).toBe(true);
    });

    it('does not flag a message that fits', () => {
      const summary = summarize('short enough');
      expect(summary.truncated).toBe(false);
      expect(summary.body).toBe('short enough');
    });

    // [AC17] A non-string body is described rather than coerced.
    it('describes an unpreviewable body', () => {
      const summary = summarize([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ] as QueuedCommand['prompt']);
      expect(summary.body).toContain('Unpreviewable content: 2 block(s)');
      // The placeholder fully describes it, so there is nothing to warn about.
      expect(summary.truncated).toBe(false);
    });

    // [AC17] Identity is a claim, and the type carries it as one.
    it('sanitizes the claimed name and address', () => {
      const summary = summarizeHeldMessage({
        command: command('hi'),
        from: 'uds:/tmp/​peer.sock',
        fromName: 'worker[0m',
      });
      expect(summary.claimedName).toBe('worker[0m');
      expect(summary.claimedAddress).toBe('uds:/tmp/peer.sock');
    });

    it('counts attachments', () => {
      const summary = summarizeHeldMessage({
        command: command('hi'),
        from: 'uds:/tmp/a.sock',
        attachmentPaths: ['/uploads/one', '/uploads/two'],
      });
      expect(summary.attachmentCount).toBe(2);
    });

    // [RA6] What a reviewer decides on is the message, not the envelope the
    // model reads. Regression: previewing `prompt` spent the whole 120-character
    // budget on the opening tag and showed none of the message.
    it('[RA6] previews the message body, not the envelope wrapping it', () => {
      const body = 'please run the integration suite and report the failures';
      const summary = summarizeHeldMessage({
        command: peerCommand(body),
        from: 'uds:%2Ftmp%2Fqwen-socks%2F12345.sock',
      });
      expect(summary.preview).toBe(body);
      expect(summary.body).toBe(body);
      expect(summary.preview).not.toContain('cross-session-message');
    });

    // [RA6] The flag has to describe the body, not the wrapping — an envelope is
    // never "short enough" once its attributes are counted.
    it('[RA6] measures truncation against the body', () => {
      const body = Array.from(
        { length: MAX_BODY_LINES + 10 },
        (_, i) => `line ${i}`,
      ).join('\n');
      const summary = summarizeHeldMessage({
        command: peerCommand(body),
        from: 'uds:%2Ftmp%2Fqwen-socks%2F12345.sock',
      });
      expect(summary.body.split('\n')).toHaveLength(MAX_BODY_LINES);
      expect(summary.body).not.toContain('cross-session-message');
      expect(summary.truncated).toBe(true);
    });

    // [RA6] An envelope may carry an empty body, and blank space in the dialog
    // would say less than the markup this replaced.
    it('[RA6] names an empty body rather than rendering blank space', () => {
      for (const body of ['', '   \n  ']) {
        const summary = summarizeHeldMessage({
          command: peerCommand(body),
          from: 'uds:%2Ftmp%2Fqwen-socks%2F12345.sock',
        });
        expect(summary.preview).toBe('(empty message)');
        expect(summary.body).toBe('(empty message)');
      }
    });
  });

});
