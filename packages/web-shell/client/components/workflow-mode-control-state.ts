import type {
  DaemonWorkflowMode,
  DaemonWorkflowModeStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { WebShellLanguage } from '../i18n';
import { getWorkflowModeMessages } from './workflow-mode-messages';

export interface WorkflowModeControlOptions {
  workflowMode?: DaemonWorkflowMode;
  workflowModeStatus?: DaemonWorkflowModeStatus;
  workflowModePending?: boolean;
  onWorkflowModeChange?: (requested: boolean) => void;
}

export function getWorkflowModeControlState(
  {
    workflowMode,
    workflowModeStatus: status,
    workflowModePending: pending = false,
    onWorkflowModeChange,
  }: WorkflowModeControlOptions,
  language: WebShellLanguage,
) {
  const messages = getWorkflowModeMessages(language);
  if (!status || status === 'unsupported') return null;
  const mode = status === 'unbound' ? undefined : workflowMode;

  const disabled =
    status !== 'ready' ||
    pending ||
    !mode ||
    !onWorkflowModeChange ||
    (!mode.available && !mode.requested);
  const state =
    status === 'unbound'
      ? messages.unbound
      : pending
        ? messages.updating
        : status === 'syncing'
          ? messages.syncing
          : status === 'unknown' || !mode
            ? messages.unknown
            : mode.requested
              ? mode.effective
                ? messages.on
                : messages.onUnavailable
              : mode.available
                ? messages.off
                : messages.unavailable;
  const reason =
    mode?.available === false
      ? mode.reason === 'initializing'
        ? messages.initializing
        : mode.reason === 'workflow_unavailable'
          ? messages.workflowUnavailable
          : mode.reason === 'unsupported'
            ? messages.unsupported
            : mode.reason
      : undefined;
  const description = [state, reason, mode ? messages.nextTurn : undefined]
    .filter(Boolean)
    .join(' ');

  return { mode, disabled, description, messages, status, pending };
}
