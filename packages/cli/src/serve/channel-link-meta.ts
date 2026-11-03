/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import { resolveChannelCwd } from '../commands/channel/channel-cwd.js';
import { loadSettings } from '../config/settings.js';

/**
 * Non-secret metadata the channel events page needs to link a journal row to
 * its PR/issue web page. Only these two fields ever leave the daemon here;
 * tokens and every other config field stay out.
 */
export interface ChannelLinkMeta {
  type?: string;
  baseUrl?: string;
}

/**
 * Link metadata for the channels named in a workspace's event journal,
 * resolved from the MERGED (system + user + workspace) settings the channel
 * workers run with. The management listing is scope-local, so a channel
 * configured in user/system settings with `cwd` pointing at this workspace
 * has no entry there even though its journal rows appear on this page.
 *
 * Workspace isolation mirrors the worker grouping: a channel owns this
 * workspace iff its resolved cwd canonicalizes back to it, so a user-scope
 * channel aimed at another project never leaks its metadata here.
 */
export function channelLinkMetaForEvents(
  events: ReadonlyArray<{ channel: string }>,
  workspaceCwd: string,
  loadChannels: (cwd: string) => Record<string, unknown> = (cwd) => {
    const merged = loadSettings(cwd).merged as {
      channels?: Record<string, unknown>;
    };
    return merged.channels ?? {};
  },
): Record<string, ChannelLinkMeta> {
  const names = new Set(events.map((event) => event.channel));
  if (names.size === 0) return {};
  const merged = loadChannels(workspaceCwd);
  const ownerCwd = canonicalizeWorkspace(workspaceCwd);
  const entries: Array<[string, ChannelLinkMeta]> = [];
  for (const name of names) {
    if (!Object.hasOwn(merged, name)) continue;
    const entry = merged[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const config = entry as Record<string, unknown>;
    const rawCwd = config['cwd'];
    try {
      const resolved = canonicalizeWorkspace(
        resolveChannelCwd(
          typeof rawCwd === 'string' && rawCwd.length > 0 ? rawCwd : undefined,
          workspaceCwd,
        ),
      );
      if (resolved !== ownerCwd) continue;
    } catch {
      // A cwd that cannot be canonicalized (e.g. EACCES) cannot own this
      // workspace; same treatment as the worker grouping.
      continue;
    }
    const meta: ChannelLinkMeta = {};
    if (typeof config['type'] === 'string') meta.type = config['type'];
    if (typeof config['baseUrl'] === 'string') meta.baseUrl = config['baseUrl'];
    if (Object.keys(meta).length > 0) entries.push([name, meta]);
  }
  // Object.fromEntries defines own properties, so a journal channel named
  // "__proto__" becomes a plain data key instead of polluting the prototype.
  return Object.fromEntries(entries);
}
