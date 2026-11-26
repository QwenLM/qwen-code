/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Config } from '../config/config.js';
import {
  ENV_BUSINESS_PRODUCT,
  ENV_CLIENT_TYPE,
  ENV_CLIENT_VERSION,
} from '../config/brand.js';
import { captureExtensionCommonFeatures } from './extension-feature-common.js';
vi.mock(
  '../utils/version.js',
  () => ({
    getVersion: async () => 'test-cli',
    getVersionSync: () => 'test-cli',
  })
);

describe(
  'extension common features',
  () => {
    afterEach(() => vi.unstubAllEnvs());
    it('retains identity privacy', async () => {
        for (const usageEnabled of [true, false]) {
          const config = {
            getUsageStatisticsEnabled: () => usageEnabled,
            getSessionId: () => 's',
            getTelemetryIdentityContext: () => ({
              principalType: 'user',
              principalId: 'principal',
              userId: 'user',
              accountId: 'account',
              organizationId: 'org',
            }),
          } as unknown as Config;
          expect(
            await captureExtensionCommonFeatures(
              config,
              'event',
              'ts'
            ),
          ).toMatchObject({
            principalType: 'user',
            organizationId: 'org',
            principalId: usageEnabled ? 'principal' : '',
            userId: usageEnabled ? 'user' : '',
            accountId: usageEnabled ? 'account' : '',
          });
        }
      },
    );
    it.each(['ide', 'cli', 'jb', 'qoder_work', 'qoder_wake', 'app'])(
      'uses business product %s without product version fallback and applies identity privacy',
      async (product) => {
        vi.stubEnv(
          ENV_BUSINESS_PRODUCT,
          product
        );
        vi.stubEnv(
          ENV_CLIENT_TYPE,
          'different-client-type'
        );
        vi.stubEnv(
          ENV_CLIENT_VERSION,
          undefined
        );
        const config = {
          getSessionId: () => 's',
          getUsageStatisticsEnabled: () => false,
          getTelemetryIdentityContext: () => ({
            principalType: 'user',
            principalId: 'private',
            userId: 'private',
            accountId: 'private',
            organizationId: 'org',
          }),
        } as unknown as Config;
        const result = await captureExtensionCommonFeatures(
          config,
          'id',
          'ts'
        );
        expect(result).toMatchObject({
          eventId: 'id',
          eventTs: 'ts',
          sessionId: 's',
          cliVersion: 'test-cli',
          product,
          productVersion: '',
          userId: '',
          principalId: '',
          accountId: '',
          organizationId: 'org',
        });
        expect(Object.keys(result)).toHaveLength(18);
      },
    );
    it(
      'retains service account identity under the existing privacy rule',
      async () => {
        vi.stubEnv(
          ENV_CLIENT_VERSION,
          'host-version'
        );
        const config = {
          getUsageStatisticsEnabled: () => false,
          getTelemetryIdentityContext: () => ({
            principalType: 'service_account',
            principalId: 'sa',
          }),
        } as unknown as Config;
        expect(
          await captureExtensionCommonFeatures(
            config,
            'e',
            't'
          ),
        ).toMatchObject({ principalId: 'sa', productVersion: 'host-version' });
      }
    );
  }
);
