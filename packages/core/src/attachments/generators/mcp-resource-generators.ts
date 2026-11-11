/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseAtMentions } from '../at-mentions.js';
import {
  type AttachmentExternalContext,
  McpResourceAttachment,
} from '../types.js';
import { raceWithAbortSignal } from '../../utils/abort-race.js';
import { runLogger } from '../../utils/runLogger.js';

/** Each resource fails independently. Timeouts also cancel the underlying RPC. */
export async function processMcpResourceMentions(
  input: string,
  externalContext?: AttachmentExternalContext,
  signal?: AbortSignal,
): Promise<McpResourceAttachment[]> {
  signal?.throwIfAborted();
  const source = externalContext?.mcpResources;
  if (!source) return [];

  const identifiers = new Set(
    parseAtMentions(input)
      .map(({ value }) => value)
      .filter((value) => value.includes(':')),
  );
  const attachments = await Promise.all(
    [...identifiers].map(
      async (identifier): Promise<McpResourceAttachment | null> => {
        const controller = new AbortController();
        const readSignal = signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal;
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          readSignal.throwIfAborted();
          const resource = source.findResource(identifier);
          if (!resource || !source.canUseServer(resource.serverName))
            return null;
          const content = await raceWithAbortSignal(
            source.readResource(resource.serverName, resource.uri, readSignal),
            readSignal,
          );
          if (!content) return null;
          return new McpResourceAttachment({
            type: 'mcp_resource',
            server: resource.serverName,
            uri: resource.uri,
            name: resource.name,
            description: resource.description,
            content,
          });
        } catch (error) {
          signal?.throwIfAborted();
          runLogger.warn(
            `[attachment] Failed to read MCP resource @${identifier}`,
            error,
          );
          return null;
        } finally {
          clearTimeout(timer);
        }
      },
    ),
  );
  signal?.throwIfAborted();
  return attachments.filter((a): a is McpResourceAttachment => a !== null);
}
