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
  /** Confirmed target for a destructive action (release), distinct from cursor. */
  confirmed?: boolean;
  /** Non-actionable row (e.g. the current session, or an inactive one). */
  disabled?: boolean;
  /** Tooltip shown when `current` (the pseudo-element ✓ can't carry text). */
  currentLabel?: string;
  /** Stable id so the listbox can point `aria-activedescendant` at this row. */
  optionId?: string;
  /**
   * `aria-selected` value. Per WAI-ARIA this marks the chosen value, not the
   * roving highlight (which `aria-activedescendant` conveys) — so it defaults
   * to `current`. Multi-select (delete) passes the checked state and release
   * passes its confirmed target instead.
   */
  ariaSelected?: boolean;
  /** Leading slot, e.g. a multi-select checkbox. */
  leading?: ReactNode;
  /** Trailing slot in the title row, e.g. a status badge. */
  trailing?: ReactNode;
  /** Test-only selector for the resume dialog's session options. */
  resumeSelector?: boolean;
  onClick: () => void;
  /**
   * Pointer moved over the row (real movement — see useListboxKeyboard). This
   * updates the roving cursor only; callers that separate cursor from confirmed
   * target (e.g. release/rewind) still keep the destructive action behind an
   * explicit Enter/click + button flow.
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
  confirmed,
  disabled,
  currentLabel,
  optionId,
  ariaSelected,
  leading,
  trailing,
  resumeSelector,
  onClick,
  onActivate,
}: SessionRowProps) {
  const { t } = useI18n();
  const timestamp = session.updatedAt || session.createdAt;

  return (
    <div
      id={optionId}
      role="option"
      aria-selected={ariaSelected ?? current}
      aria-current={current ? 'true' : undefined}
      aria-disabled={disabled || undefined}
      className={dp(
        'picker-item',
        'picker-session-item',
        active ? 'selected' : undefined,
        current ? 'dialog-current' : undefined,
        confirmed ? 'picker-item-confirmed' : undefined,
        disabled ? 'disabled' : undefined,
      )}
      title={current ? currentLabel : undefined}
      data-web-shell-resume-session={resumeSelector ? '' : undefined}
      data-session-id={resumeSelector ? session.sessionId : undefined}
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
