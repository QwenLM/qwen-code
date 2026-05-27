import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import type {
  DaemonWorkspaceSkillStatus,
  DaemonWorkspaceSkillsStatus,
} from '@qwen-code/sdk/daemon';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';

interface SkillsDialogProps {
  loadStatus: () => Promise<DaemonWorkspaceSkillsStatus>;
  onClose: () => void;
}

function statusLabel(
  skill: DaemonWorkspaceSkillStatus,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (!skill.modelInvocable) return t('skills.status.disabled');
  return skill.status || 'ok';
}

function metaText(skill: DaemonWorkspaceSkillStatus): string {
  return [
    skill.level,
    skill.argumentHint ? `args ${skill.argumentHint}` : undefined,
    skill.model ? `model ${skill.model}` : undefined,
    skill.extensionName,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function SkillsDialog({ loadStatus, onClose }: SkillsDialogProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<DaemonWorkspaceSkillsStatus | null>(
    null,
  );
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const skills = useMemo(() => status?.skills ?? [], [status?.skills]);
  const selected = skills[selectedIdx];

  const reload = useCallback(() => {
    setLoading(true);
    loadStatus()
      .then((next) => {
        setStatus(next);
        setMessage(next.errors?.[0]?.error ?? null);
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoading(false));
  }, [loadStatus]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (selectedIdx >= skills.length && skills.length > 0) {
      setSelectedIdx(skills.length - 1);
    }
  }, [selectedIdx, skills.length]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  useDelayedGlobalKeyDown(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, Math.max(skills.length - 1, 0)));
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'r') {
        e.preventDefault();
        reload();
      }
    },
    [onClose, reload, skills.length],
  );

  const summary = useMemo(() => {
    if (!status) return '';
    const enabled = skills.filter((skill) => skill.modelInvocable).length;
    return t('skills.invocable', { enabled, total: skills.length });
  }, [skills, status, t]);

  return (
    <div className={dp('resume-picker')}>
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>{t('skills.title')}</span>
        <span className={dp('resume-picker-count')}>{summary}</span>
      </div>

      <div className={dp('resume-picker-search')}>
        <span className={dp('resume-picker-search-hint')}>
          {message ||
            (loading ? t('skills.loading') : `${skills.length} skills`)}
        </span>
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-list')} ref={listRef}>
        {!loading && skills.length === 0 && (
          <div className={dp('resume-picker-empty')}>{t('skills.empty')}</div>
        )}
        {skills.map((skill, i) => (
          <div
            key={`${skill.level}:${skill.name}`}
            className={dp(
              'resume-picker-item',
              i === selectedIdx ? 'selected' : undefined,
            )}
            onMouseEnter={() => setSelectedIdx(i)}
          >
            <div className={dp('resume-picker-item-row')}>
              <span className={dp('resume-picker-item-prefix')}>
                {i === selectedIdx ? '›' : ' '}
              </span>
              <span className={dp('resume-picker-item-title')}>
                {skill.name}
              </span>
              <span className={dp('resume-picker-item-badge')}>
                {statusLabel(skill, t)}
              </span>
            </div>
            <div className={dp('resume-picker-item-meta')}>
              {metaText(skill)}
            </div>
            {skill.description && (
              <div className={dp('dialog-detail')}>
                <div className={dp('dialog-detail-body')}>
                  {skill.description}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className={dp('resume-picker-sep')} />

      <div className={dp('resume-picker-footer')}>
        {selected
          ? t('skills.footer', { name: selected.name })
          : t('skills.footer')}
      </div>
    </div>
  );
}
