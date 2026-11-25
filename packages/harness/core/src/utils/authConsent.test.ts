/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import readline from 'node:readline';
import process from 'node:process';
import { coreEvents } from './events.js';
import { getConsentForOauth } from './authConsent.js';
import { FatalAuthenticationError } from './errors.js';
import { writeToStdout } from './stdio.js';
import { isHeadlessMode } from './headless.js';

vi.mock('node:readline');
vi.mock('./headless.js', () => ({
  isHeadlessMode: vi.fn(),
}));
vi.mock('./stdio.js', () => ({
  writeToStdout: vi.fn(),
  createWorkingStdio: vi.fn(() => ({
    stdout: process.stdout,
    stderr: process.stderr,
  })),
}));

describe('getConsentForOauth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('in interactive mode', () => {
    beforeEach(() => {
      (isHeadlessMode as Mock).mockReturnValue(false);
    });

    it('should emit consent request when UI listeners are present', async () => {
      const mockEmitConsentRequest = vi.spyOn(coreEvents, 'emitConsentRequest');
      vi.spyOn(coreEvents, 'listenerCount').mockReturnValue(1);

      mockEmitConsentRequest.mockImplementation((payload) => {
        payload.onConfirm(true);
      });

      const result = await getConsentForOauth('Login required.');

      expect(result).toBe(true);
      expect(mockEmitConsentRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            'Login required. Opening authentication page in your browser.',
          ),
        }),
      );
    });

    it('should handle empty prompt correctly', async () => {
      const mockEmitConsentRequest = vi.spyOn(coreEvents, 'emitConsentRequest');
      vi.spyOn(coreEvents, 'listenerCount').mockReturnValue(1);

      mockEmitConsentRequest.mockImplementation((payload) => {
        payload.onConfirm(true);
      });

      await getConsentForOauth('');

      expect(mockEmitConsentRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringMatching(
            /^Opening authentication page in your browser\./,
          ),
        }),
      );
    });

    it('propagates cancellation to the UI and rejects pending consent', async () => {
      vi.spyOn(coreEvents, 'listenerCount').mockReturnValue(1);
      const emit = vi
        .spyOn(coreEvents, 'emitConsentRequest')
        .mockImplementation(() => {});
      const controller = new AbortController();
      const result = getConsentForOauth(
        'Managed MCP authorization',
        controller.signal,
      );
      expect(emit.mock.calls[0][0].signal).toBe(controller.signal);
      controller.abort(new Error('cancelled'));
      await expect(result).rejects.toThrow('cancelled');
      emit.mock.calls[0][0].onConfirm(true);
    });

    it('should return false when user declines via UI', async () => {
      const mockEmitConsentRequest = vi.spyOn(coreEvents, 'emitConsentRequest');
      vi.spyOn(coreEvents, 'listenerCount').mockReturnValue(1);

      mockEmitConsentRequest.mockImplementation((payload) => {
        payload.onConfirm(false);
      });

      const result = await getConsentForOauth('Login required.');

      expect(result).toBe(false);
    });

    it('should throw FatalAuthenticationError when no UI listeners are present', async () => {
      vi.spyOn(coreEvents, 'listenerCount').mockReturnValue(0);

      await expect(getConsentForOauth('Login required.')).rejects.toThrow(
        FatalAuthenticationError,
      );
    });
  });

  describe('in non-interactive mode', () => {
    beforeEach(() => {
      (isHeadlessMode as Mock).mockReturnValue(true);
    });

    it('closes readline when pending consent is cancelled', async () => {
      const rl = { on: vi.fn(), close: vi.fn() };
      (readline.createInterface as Mock).mockReturnValue(rl);
      const controller = new AbortController();
      const result = getConsentForOauth('Login required.', controller.signal);
      controller.abort(new Error('cancelled'));
      await expect(result).rejects.toThrow('cancelled');
      expect(rl.close).toHaveBeenCalledOnce();
    });

    it('should use readline to prompt for consent', async () => {
      const mockReadline = {
        on: vi.fn((event, callback) => {
          if (event === 'line') {
            callback('y');
          }
        }),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockReadline);

      const result = await getConsentForOauth('Login required.');

      expect(result).toBe(true);
      expect(readline.createInterface).toHaveBeenCalledWith(
        expect.objectContaining({
          terminal: true,
        }),
      );
      expect(writeToStdout).toHaveBeenCalledWith(
        expect.stringContaining('Login required.'),
      );
    });

    it('should accept empty response as "yes"', async () => {
      const mockReadline = {
        on: vi.fn((event, callback) => {
          if (event === 'line') {
            callback('');
          }
        }),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockReadline);

      const result = await getConsentForOauth('Login required.');

      expect(result).toBe(true);
    });

    it('should return false when user declines via readline', async () => {
      const mockReadline = {
        on: vi.fn((event, callback) => {
          if (event === 'line') {
            callback('n');
          }
        }),
        close: vi.fn(),
      };
      (readline.createInterface as Mock).mockReturnValue(mockReadline);

      const result = await getConsentForOauth('Login required.');

      expect(result).toBe(false);
    });
  });
});
