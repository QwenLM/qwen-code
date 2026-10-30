import type {
  DaemonSessionWorkflowTaskStatus,
  DaemonWorkflowDispatchStatusEntry,
} from '@qwen-code/sdk/daemon';
import {
  useSubagentDetails,
  type OpenSubagentDetails,
} from '../../subagentDetailsContext';
import { useTranscriptRenderMode } from '../../transcriptRenderMode';

export function useWorkflowAgentDetails(
  task: DaemonSessionWorkflowTaskStatus,
  onOpenSubagent?: OpenSubagentDetails,
): (dispatch: DaemonWorkflowDispatchStatusEntry) => void {
  const details = useSubagentDetails();
  const open = onOpenSubagent ?? details?.onOpen;
  const documentMode = useTranscriptRenderMode() === 'document';
  return (dispatch) => {
    if (
      documentMode ||
      (task.isHistorical && !task.parentSessionId) ||
      !dispatch.subagentId ||
      dispatch.status === 'queued' ||
      dispatch.status === 'cached'
    )
      return;
    open?.(
      {
        callId: dispatch.subagentId,
        toolName: 'agent',
        title: `Agent: ${dispatch.label}`,
        status:
          dispatch.status === 'running'
            ? 'in_progress'
            : dispatch.status === 'completed'
              ? 'completed'
              : 'failed',
        args: { description: dispatch.label, prompt: dispatch.prompt },
        rawOutput: {
          type: 'task_execution',
          workflowRunId: task.id,
          status: dispatch.status,
        },
        startTime: dispatch.startedAt ?? dispatch.queuedAt,
        endTime: dispatch.endedAt,
        wasCancelled: dispatch.status === 'cancelled',
      },
      task.parentSessionId,
    );
  };
}
