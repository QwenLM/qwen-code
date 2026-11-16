/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single owner of the GitHub API-root → web-origin mapping. The adapter
 * resolves prompt-metadata URLs with it, and the daemon's channel-events
 * route emits the resolved origin as link metadata, so browser clients
 * concatenate a ready origin instead of re-deriving it (the browser bundle
 * cannot import this Node-only package).
 */
export function resolveGithubWebOrigin(baseUrl: unknown): string {
  const raw =
    typeof baseUrl === 'string' && baseUrl.trim()
      ? baseUrl.trim()
      : 'https://api.github.com';
  return (
    raw
      .replace(/\/api\/v3\/?$/, '')
      .replace(/^https:\/\/api\.github\.com/, 'https://github.com')
      // GitHub Enterprise Cloud data-residency tenants serve the web UI at
      // <tenant>.ghe.com and the REST API at api.<tenant>.ghe.com. Binding
      // URLs carry the web host, so map the API host to it. Scoped to a
      // single .ghe.com label on purpose: a self-hosted GHE Server may
      // legitimately serve web and API from an `api.`-prefixed host.
      .replace(/^https:\/\/api\.([^./]+\.ghe\.com)/i, 'https://$1')
      .replace(/\/+$/, '')
  );
}
