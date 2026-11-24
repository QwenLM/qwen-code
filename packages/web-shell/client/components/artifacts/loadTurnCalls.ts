import type {
  DaemonSessionToolCalls,
  DaemonToolTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { buildTrajectory } from '../../trajectory/buildTrajectory';
import { projectTrajectoryWindow } from '../../trajectory/projectTrajectoryWindow';
import type { TrajectoryToolRow } from '../../trajectory/types';

export async function loadTurnCalls(
  readCalls: () => Promise<DaemonSessionToolCalls>,
  recordId: string,
): Promise<TrajectoryToolRow[]> {
  const result = await readCalls();
  if (result.turnId !== recordId)
    throw new Error('Tool calls belong to another turn');
  const trajectory = buildTrajectory(projectTrajectoryWindow(result.events));
  const user = trajectory.rows.find(
    (row) =>
      'block' in row &&
      row.block.kind === 'user' &&
      row.block.sourceRecordIds?.includes(recordId),
  );
  if (!user) throw new Error('Turn not found in tool calls response');
  const rows = trajectory.rows.filter(
    (row): row is TrajectoryToolRow =>
      row.kind === 'tool' &&
      row.turnIndex === user.turnIndex &&
      !row.block.backgroundTurn,
  );
  const depths = toolCallDepths(rows.map((row) => row.block));
  return rows.map((row) => ({
    ...row,
    depth: depths.get(row.block.toolCallId) ?? 0,
  }));
}

export function toolCallDepths(
  blocks: readonly DaemonToolTranscriptBlock[],
): Map<string, number> {
  const byCallId = new Map(blocks.map((block) => [block.toolCallId, block]));
  const byBlockId = new Map(blocks.map((block) => [block.id, block]));
  return new Map(
    blocks.map((block) => {
      const seen = new Set([block.toolCallId]);
      let current = block;
      let depth = 0;
      while (depth < 8) {
        const parent =
          (current.parentToolCallId
            ? byCallId.get(current.parentToolCallId)
            : undefined) ??
          (current.parentBlockId
            ? byBlockId.get(current.parentBlockId)
            : undefined);
        if (!parent || seen.has(parent.toolCallId)) break;
        seen.add(parent.toolCallId);
        depth += 1;
        current = parent;
      }
      return [block.toolCallId, depth];
    }),
  );
}
