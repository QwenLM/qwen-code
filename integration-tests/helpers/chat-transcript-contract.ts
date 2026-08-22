import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { readFileSync } from 'node:fs';
import {
  createDaemonTranscriptState,
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
  type DaemonEvent,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { TranscriptUpdateIdentityProjector } from '../../packages/cli/src/acp-integration/session/transcript-update-identity.js';
import {
  adaptAcpTranscriptUpdates,
  projectStableTranscriptBlockIds,
} from '../../packages/vscode-ide-companion/src/webview/adapters/acpTranscriptAdapter.js';
import { transcriptBlocksToDaemonMessages } from '../../packages/web-shell/client/adapters/transcriptToMessages.js';

export interface TranscriptCandidate {
  readonly blocks: readonly DaemonTranscriptBlock[];
  readonly compatible: boolean;
}

export interface VscodeIdentityGate {
  readonly directDaemon: 'pass' | 'fail';
  readonly acp: 'pass' | 'fail';
  readonly selectedPath: 'acp' | 'direct-daemon' | null;
  readonly blockers: readonly string[];
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

export function evaluateVscodeIdentityGate(input: {
  daemonEvents: readonly DaemonEvent[];
  acpUpdates: readonly unknown[];
  scopeKey: string;
}): VscodeIdentityGate {
  const direct = adaptDirectDaemonEvents(input.daemonEvents, input.scopeKey);
  const directTail = adaptDirectDaemonEvents(
    input.daemonEvents.slice(1),
    input.scopeKey,
  );
  const acp = adaptAcpTranscriptUpdates(input.acpUpdates, input.scopeKey);
  const acpTail = adaptAcpTranscriptUpdates(
    input.acpUpdates.slice(1),
    input.scopeKey,
  );
  const liveProjector = new TranscriptUpdateIdentityProjector();
  const promptId = 'session-a########1';
  const liveUpdates = ['first ', 'second'].map((text) =>
    liveProjector.project(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      } as SessionUpdate,
      promptId,
    ),
  );
  const live = adaptAcpTranscriptUpdates(liveUpdates, input.scopeKey);
  const liveTail = adaptAcpTranscriptUpdates(
    liveUpdates.slice(1),
    input.scopeKey,
  );
  const directPassed = stableTailIdentity(direct, directTail);
  const acpPassed =
    stableTailIdentity(acp, acpTail) && stableTailIdentity(live, liveTail, 0);
  const blockers = [
    ...(directPassed ? [] : ['direct-daemon stable identity matrix failed']),
    ...(acpPassed ? [] : ['ACP stable identity matrix failed']),
  ];
  return {
    directDaemon: directPassed ? 'pass' : 'fail',
    acp: acpPassed ? 'pass' : 'fail',
    selectedPath: acpPassed ? 'acp' : directPassed ? 'direct-daemon' : null,
    blockers,
  };
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
