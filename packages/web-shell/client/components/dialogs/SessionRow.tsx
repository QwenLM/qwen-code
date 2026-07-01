import { type ReactNode } from 'react';
import { type DaemonSessionSummary } from '@qwen-code/webui/daemon-react-sdk';
import { dp } from './dialogStyles';
import { useI18n } from '../../i18n';
import { formatRelativeTime } from '../../utils/formatRelativeTime';

interface SessionRowProps {
  session: DaemonSessionSummary;
  /** Roving keyboard/hover highlight. */
  active: boolean;
  /** The user's current session — marks it with the accent bar + ✓. */
  current: boolean;
  /** Non-actionable row (e.g. the current session, or an inactive one). */
  disabled?: boolean;
  /** Tooltip shown when `current` (the pseudo-element ✓ can't carry text). */
  currentLabel?: string;
  /** Stable id so the listbox can point `aria-activedescendant` at this row. */
  optionId?: string;
  /**
   * `aria-selected` value. Defaults to `active`; multi-select dialogs pass the
   * checked state instead.
   */
  ariaSelected?: boolean;
  /** Leading slot, e.g. a multi-select checkbox. */
  leading?: ReactNode;
  /** Trailing slot in the title row, e.g. a status badge. */
  trailing?: ReactNode;
  onClick: () => void;
  /**
   * Pointer moved over the row (real movement — see useListboxKeyboard). Omit to
   * opt out of hover selection, e.g. a confirm-button dialog whose action must
   * track a deliberate click, not the cursor.
   */
  onActivate?: () => void;
}

/**
 * A session list row shared by the resume / delete / release dialogs. Owns the
 * common shell (roving highlight, current marker, disabled state) and the
 * identical metadata line (relative time · client count · active prompt);
 * per-dialog affordances go through the `leading`/`trailing` slots.
 */
export function SessionRow({
  session,
  active,
  current,
  disabled,
  currentLabel,
  optionId,
  ariaSelected,
  leading,
  trailing,
  onClick,
  onActivate,
}: SessionRowProps) {
  const { t } = useI18n();
  const timestamp = session.updatedAt || session.createdAt;

  return (
    <div
      id={optionId}
      role="option"
      aria-selected={ariaSelected ?? active}
      aria-disabled={disabled || undefined}
      className={dp(
        'picker-item',
        'picker-session-item',
        active ? 'selected' : undefined,
        current ? 'dialog-current' : undefined,
        disabled ? 'disabled' : undefined,
      )}
      title={current ? currentLabel : undefined}
      onClick={onClick}
      onMouseMove={onActivate}
    >
      <div className={dp('picker-item-row')}>
        {leading}
        <span className={dp('picker-item-title')}>
          {session.displayName || session.sessionId.slice(0, 8)}
        </span>
        {trailing}
      </div>
      <div className={dp('picker-item-meta')}>
        <span>{timestamp && formatRelativeTime(timestamp, t)}</span>
        <span className={dp('picker-item-detail')}>
          {t('common.clients', { count: session.clientCount ?? 0 })}
        </span>
        {session.hasActivePrompt && (
          <span className={dp('picker-item-detail')}>
            {t('resume.activePrompt')}
          </span>
        )}
      </div>
    </div>
  );
}
