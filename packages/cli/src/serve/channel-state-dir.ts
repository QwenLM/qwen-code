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
    channelName,
    channelType,
  );
}
