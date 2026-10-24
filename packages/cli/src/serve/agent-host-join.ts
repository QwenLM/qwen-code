/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The one-line join link a coordinator hands out under Agent → Runtime:
 * `<coordinator URL>/join/<workspace id>`.
 *
 * It only ever travels to `qwen serve --join`; nothing serves that path. The
 * single-use enrollment token travels separately in
 * QWEN_AGENT_HOST_ENROLLMENT_TOKEN so it is not exposed in process argv.
 */
export interface AgentHostJoinTarget {
  serverUrl: string;
  workspaceId: string;
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
  const [workspaceId, ...rest] =
    marker >= 0 ? url.pathname.slice(marker + '/join/'.length).split('/') : [];
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !workspaceId ||
    rest.some(Boolean) ||
    !SEGMENT.test(workspaceId)
  ) {
    throw new Error(
      '--join expects a link like https://host:4170/join/<workspace>.',
    );
  }
  const base = url.pathname.slice(0, marker).replace(/\/+$/, '');
  return {
    serverUrl: `${url.origin}${base}`,
    workspaceId,
  };
}
