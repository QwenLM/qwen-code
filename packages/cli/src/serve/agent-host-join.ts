/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The one-line join link a coordinator hands out under Agent → Runtime:
 * `<coordinator URL>/join/<workspace id>/<enrollment token>`.
 *
 * It only ever travels to `qwen serve --join`; nothing serves that path. It
 * bundles the three values `--agent-host-server`, `--agent-host-workspace-id`
 * and QWEN_AGENT_HOST_ENROLLMENT_TOKEN used to be typed separately. The token
 * is single-use and short-lived, and the host saves its own credential after
 * enrolling, so the link is spent once it has been used.
 */
export interface AgentHostJoinTarget {
  serverUrl: string;
  workspaceId: string;
  token: string;
}

const SEGMENT = /^[A-Za-z0-9_-]{1,256}$/;

export function parseJoinLink(link: string): AgentHostJoinTarget {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error('--join expects the link shown by the coordinator.');
  }
  const marker = url.pathname.lastIndexOf('/join/');
  const [workspaceId, token, ...rest] =
    marker >= 0 ? url.pathname.slice(marker + '/join/'.length).split('/') : [];
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !workspaceId ||
    !token ||
    rest.some(Boolean) ||
    !SEGMENT.test(workspaceId) ||
    !SEGMENT.test(token)
  ) {
    throw new Error(
      '--join expects a link like https://host:4170/join/<workspace>/<token>.',
    );
  }
  const base = url.pathname.slice(0, marker).replace(/\/+$/, '');
  return {
    serverUrl: `${url.origin}${base}`,
    workspaceId,
    token,
  };
}
