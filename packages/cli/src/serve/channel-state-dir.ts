import { createHash } from 'node:crypto';
import path from 'node:path';
import { hashDaemonWorkspace, Storage } from '@qwen-code/qwen-code-core';
import {
  assertSafeChannelName,
  isSafePathComponent,
} from './channel-selection.js';

function assertSafeChannelType(channelType: string): void {
  if (!isSafePathComponent(channelType)) {
    throw new Error(`Invalid channel type: ${JSON.stringify(channelType)}.`);
  }
}

function hashedIdentifierSegment(kind: 'name' | 'type', value: string): string {
  return createHash('sha256')
    .update(`channel-${kind}\0`, 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

export function daemonChannelStateDir(
  workspaceCwd: string,
  channelName: string,
  channelType: string,
): string {
  assertSafeChannelName(channelName);
  assertSafeChannelType(channelType);
  return path.join(
    Storage.getGlobalQwenDir(),
    'channels',
    'daemon',
    hashDaemonWorkspace(workspaceCwd),
    hashedIdentifierSegment('name', channelName),
    hashedIdentifierSegment('type', channelType),
  );
}
