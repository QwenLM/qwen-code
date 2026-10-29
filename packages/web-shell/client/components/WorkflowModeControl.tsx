import { useId } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import type {
  DaemonWorkflowMode,
  DaemonWorkflowModeStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../i18n';
import { getWorkflowModeMessages } from './workflow-mode-messages';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Switch } from './ui/switch';
import styles from './ChatEditor.module.css';

export interface WorkflowModeControlProps {
  workflowMode?: DaemonWorkflowMode;
  workflowModeStatus?: DaemonWorkflowModeStatus;
  workflowModePending?: boolean;
  onWorkflowModeChange?: (requested: boolean) => void;
}

export function WorkflowModeControl({
  workflowMode,
  workflowModeStatus: status,
  workflowModePending: pending = false,
  onWorkflowModeChange,
}: WorkflowModeControlProps) {
  const { language } = useI18n();
  const messages = getWorkflowModeMessages(language);
  const descriptionId = useId();
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

  return (
    <Popover>
      <div
        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap"
        data-web-shell-workflow-mode-control
        data-state={status}
        data-pending={pending || undefined}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`${styles.toolBtn} focus-visible:outline-2 focus-visible:outline-ring ${!mode ? 'opacity-60' : ''}`}
            data-web-shell-workflow-mode-details
            data-disabled={!mode ? '' : undefined}
            aria-label={messages.details}
            aria-describedby={descriptionId}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.stopPropagation();
              }
            }}
          >
            Workflow
            {pending || status === 'syncing' ? (
              <LoaderCircleIcon
                size={12}
                className="animate-spin"
                aria-hidden="true"
              />
            ) : status === 'unknown' ? (
              <span aria-hidden="true">?</span>
            ) : mode?.requested && !mode.effective ? (
              <span aria-hidden="true">!</span>
            ) : null}
          </button>
        </PopoverTrigger>
        {mode && (
          <Switch
            type="button"
            size="sm"
            className="after:inset-x-0"
            aria-label={messages.label}
            aria-describedby={descriptionId}
            aria-busy={pending || undefined}
            checked={mode.requested}
            disabled={disabled}
            onCheckedChange={onWorkflowModeChange}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.stopPropagation();
              }
            }}
          />
        )}
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
      </div>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={8}
        className="max-w-[calc(100vw-2rem)] text-xs"
        aria-label={messages.label}
      >
        {description}
      </PopoverContent>
    </Popover>
  );
}
