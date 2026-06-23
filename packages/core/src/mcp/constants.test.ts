/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getOAuthRedirectUri,
  OAUTH_REDIRECT_PORT,
  OAUTH_REDIRECT_PATH,
} from './constants.js';

describe('getOAuthRedirectUri', () => {
  const ENV_KEYS = [
    'BFF_ENDPOINT',
    'DATA_AGENT_INSTANCE_ID',
    'DA_RUNTIME_TYPE',
    'dsw_baseUrl',
  ] as const;

  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Snapshot then clear all env vars that influence the result so each
    // test starts from a known-empty state.
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore the original environment.
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('falls back to localhost when no environment hints are set', () => {
    expect(getOAuthRedirectUri()).toBe(
      `http://localhost:${OAUTH_REDIRECT_PORT}${OAUTH_REDIRECT_PATH}`,
    );
  });

  describe('BFF proxy', () => {
    beforeEach(() => {
      process.env['BFF_ENDPOINT'] = 'https://bff.example.com';
      process.env['DATA_AGENT_INSTANCE_ID'] = 'inst-123';
    });

    it('uses the kxuth segment for legacy instances', () => {
      expect(getOAuthRedirectUri()).toBe(
        `https://bff.example.com/skwacb/kxuth/inst-123${OAUTH_REDIRECT_PATH}`,
      );
    });

    it('uses the bxkxuth segment when DA_RUNTIME_TYPE is ACS_SANDBOX', () => {
      process.env['DA_RUNTIME_TYPE'] = 'ACS_SANDBOX';
      expect(getOAuthRedirectUri()).toBe(
        `https://bff.example.com/skwacb/bxkxuth/inst-123${OAUTH_REDIRECT_PATH}`,
      );
    });

    it('keeps the kxuth segment for any other DA_RUNTIME_TYPE value', () => {
      process.env['DA_RUNTIME_TYPE'] = 'DSW';
      expect(getOAuthRedirectUri()).toBe(
        `https://bff.example.com/skwacb/kxuth/inst-123${OAUTH_REDIRECT_PATH}`,
      );
    });

    it('keeps the kxuth segment for an empty DA_RUNTIME_TYPE', () => {
      process.env['DA_RUNTIME_TYPE'] = '';
      expect(getOAuthRedirectUri()).toBe(
        `https://bff.example.com/skwacb/kxuth/inst-123${OAUTH_REDIRECT_PATH}`,
      );
    });

    it('strips trailing slashes from BFF_ENDPOINT to avoid a double slash', () => {
      process.env['BFF_ENDPOINT'] = 'https://bff.example.com///';
      expect(getOAuthRedirectUri()).toBe(
        `https://bff.example.com/skwacb/kxuth/inst-123${OAUTH_REDIRECT_PATH}`,
      );
    });

    it('takes priority over dsw_baseUrl when both are present', () => {
      process.env['dsw_baseUrl'] = 'https://dw.aliyun.com/dsw-380036';
      expect(getOAuthRedirectUri()).toBe(
        `https://bff.example.com/skwacb/kxuth/inst-123${OAUTH_REDIRECT_PATH}`,
      );
    });

    it('falls through when BFF_ENDPOINT is set but the instance id is missing', () => {
      delete process.env['DATA_AGENT_INSTANCE_ID'];
      expect(getOAuthRedirectUri()).toBe(
        `http://localhost:${OAUTH_REDIRECT_PORT}${OAUTH_REDIRECT_PATH}`,
      );
    });

    it('treats empty-string env values as unset and falls through to localhost', () => {
      process.env['BFF_ENDPOINT'] = '';
      process.env['DATA_AGENT_INSTANCE_ID'] = '';
      expect(getOAuthRedirectUri()).toBe(
        `http://localhost:${OAUTH_REDIRECT_PORT}${OAUTH_REDIRECT_PATH}`,
      );
    });
  });

  describe('DSW proxy', () => {
    it('builds a proxy path from dsw_baseUrl', () => {
      process.env['dsw_baseUrl'] = 'https://dw.aliyun.com/dsw-380036';
      expect(getOAuthRedirectUri()).toBe(
        `https://dw.aliyun.com/dsw-380036/proxy/${OAUTH_REDIRECT_PORT}${OAUTH_REDIRECT_PATH}`,
      );
    });

    it('strips trailing slashes from dsw_baseUrl', () => {
      process.env['dsw_baseUrl'] = 'https://dw.aliyun.com/dsw-380036///';
      expect(getOAuthRedirectUri()).toBe(
        `https://dw.aliyun.com/dsw-380036/proxy/${OAUTH_REDIRECT_PORT}${OAUTH_REDIRECT_PATH}`,
      );
    });
  });
});
