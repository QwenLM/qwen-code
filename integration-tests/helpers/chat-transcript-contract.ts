import { readFileSync } from 'node:fs';
import {
  createDaemonTranscriptState,
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
  type DaemonEvent,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { projectStableTranscriptBlockIds } from '../../packages/vscode-ide-companion/src/webview/adapters/acpTranscriptAdapter.js';
import { transcriptBlocksToDaemonMessages } from '../../packages/web-shell/client/adapters/transcriptToMessages.js';

export interface TranscriptCandidate {
  readonly blocks: readonly DaemonTranscriptBlock[];
  readonly compatible: boolean;
}

export function readJsonLines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

export function adaptDirectDaemonEvents(
  events: readonly DaemonEvent[],
  scopeKey: string,
): TranscriptCandidate {
  const transcript = reduceDaemonTranscriptEvents(
    createDaemonTranscriptState({ now: 0 }),
    events.flatMap((event) => normalizeDaemonEvent(event)),
    { now: 0 },
  );
  return projectStableTranscriptBlockIds(transcript.blocks, scopeKey);
}

export function stableTailIdentity(
  complete: TranscriptCandidate,
  tail: TranscriptCandidate,
  completeOffset = 1,
): boolean {
  if (!complete.compatible || !tail.compatible) return false;
  if (
    JSON.stringify(
      complete.blocks.slice(completeOffset).map((block) => block.id),
    ) !== JSON.stringify(tail.blocks.map((block) => block.id))
  ) {
    return false;
  }
  const completeMessages = transcriptBlocksToDaemonMessages(complete.blocks);
  const tailMessages = transcriptBlocksToDaemonMessages(tail.blocks);
  return (
    JSON.stringify(
      completeMessages
        .slice(completeOffset)
        .map((message) => [message.id, message.role]),
    ) ===
    JSON.stringify(tailMessages.map((message) => [message.id, message.role]))
  );
}
