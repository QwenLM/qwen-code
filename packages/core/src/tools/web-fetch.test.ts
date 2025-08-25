/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { WebFetchTool } from './web-fetch.js';
import { Config, ApprovalMode } from '../config/config.js';
import { ToolConfirmationOutcome } from './tools.js';

describe('WebFetchTool', () => {
  const mockConfig = {
    getApprovalMode: vi.fn(),
    setApprovalMode: vi.fn(),
    getProxy: vi.fn(),
  } as unknown as Config;

  describe('shouldConfirmExecute', () => {
    it('should return confirmation details with the correct prompt and urls', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize this page',
      };
      const invocation = tool.build(params);
      const confirmationDetails = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      expect(confirmationDetails).toEqual({
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt:
          'Fetch content from https://example.com and process with: summarize this page',
        urls: ['https://example.com'],
        onConfirm: expect.any(Function),
      });
    });

    it('should return github urls as-is in confirmation details', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://github.com/google/gemini-react/blob/main/README.md',
        prompt: 'summarize the README',
      };
      const invocation = tool.build(params);
      const confirmationDetails = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      expect(confirmationDetails).toEqual({
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt:
          'Fetch content from https://github.com/google/gemini-react/blob/main/README.md and process with: summarize the README',
        urls: ['https://github.com/google/gemini-react/blob/main/README.md'],
        onConfirm: expect.any(Function),
      });
    });

    it('should return false if approval mode is AUTO_EDIT', async () => {
      const tool = new WebFetchTool({
        ...mockConfig,
        getApprovalMode: () => ApprovalMode.AUTO_EDIT,
      } as unknown as Config);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize this page',
      };
      const invocation = tool.build(params);
      const confirmationDetails = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      expect(confirmationDetails).toBe(false);
    });

    it('should call setApprovalMode when onConfirm is called with ProceedAlways', async () => {
      const setApprovalMode = vi.fn();
      const tool = new WebFetchTool({
        ...mockConfig,
        setApprovalMode,
      } as unknown as Config);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize this page',
      };
      const invocation = tool.build(params);
      const confirmationDetails = await invocation.shouldConfirmExecute(
        new AbortController().signal,
      );

      if (
        confirmationDetails &&
        typeof confirmationDetails === 'object' &&
        'onConfirm' in confirmationDetails
      ) {
        await confirmationDetails.onConfirm(
          ToolConfirmationOutcome.ProceedAlways,
        );
      }

      expect(setApprovalMode).toHaveBeenCalledWith(ApprovalMode.AUTO_EDIT);
    });
  });
});
