/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseNetworkTargetUrl } from '@qwen-code/network-policy';
import type { NetworkPolicy } from '@qwen-code/network-policy';

const ENVIRONMENT_REFERENCE = /^\$[A-Za-z_][A-Za-z0-9_]*$/;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
// eslint-disable-next-line no-control-regex
const INVALID_URL_CHARACTER = /[\s\\\u0000-\u001f\u007f]/u;

export interface GenericWebhookConfig {
  webhookUrl: string;
  bearerToken?: string;
  networkPolicy: NetworkPolicy;
}

export function parseGenericWebhookConfig(
  config: Readonly<Record<string, unknown>>,
  allowEnvironmentReferences = false,
): GenericWebhookConfig {
  const allowPrivateNetwork = config['allowPrivateNetwork'];
  if (
    allowPrivateNetwork !== undefined &&
    typeof allowPrivateNetwork !== 'boolean'
  ) {
    throw new Error('Generic webhook allowPrivateNetwork must be a boolean.');
  }
  const networkPolicy =
    allowPrivateNetwork === true ? 'allow-private' : 'public';
  const webhookUrl = config['webhookUrl'];
  try {
    if (typeof webhookUrl !== 'string') throw new Error();
    if (
      !allowEnvironmentReferences ||
      !ENVIRONMENT_REFERENCE.test(webhookUrl)
    ) {
      const authority = /^https?:\/\/([^/?#]+)/i.exec(webhookUrl)?.[1];
      if (
        !authority ||
        authority.includes('@') ||
        webhookUrl.includes('#') ||
        INVALID_URL_CHARACTER.test(webhookUrl)
      ) {
        throw new Error();
      }
      parseNetworkTargetUrl(webhookUrl, networkPolicy);
    }
  } catch {
    throw new Error(
      'Generic webhook URL must be an absolute HTTP(S) URL permitted by its network policy, without credentials, fragments or whitespace.',
    );
  }
  const bearerToken = config['bearerToken'];
  if (
    bearerToken !== undefined &&
    (typeof bearerToken !== 'string' ||
      (!BEARER_TOKEN.test(bearerToken) &&
        !(
          allowEnvironmentReferences && ENVIRONMENT_REFERENCE.test(bearerToken)
        )))
  ) {
    throw new Error(
      'Generic webhook Bearer token must be a valid non-empty token.',
    );
  }
  return {
    webhookUrl,
    ...(bearerToken === undefined ? {} : { bearerToken }),
    networkPolicy,
  };
}
