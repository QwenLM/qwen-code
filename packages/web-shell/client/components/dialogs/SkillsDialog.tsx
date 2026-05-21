import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DaemonWorkspaceSkillStatus,
  DaemonWorkspaceSkillsStatus,
} from '@qwen-code/sdk/daemon';

interface SkillsDialogProps {
  loadStatus: () => Promise<DaemonWorkspaceSkillsStatus>;
  onClose: () => void;
}

function statusLabel(skill: DaemonWorkspaceSkillStatus): string {
  if (!skill.modelInvocable) return 'disabled';
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
    };
    const timer = setTimeout(
      () => window.addEventListener('keydown', handler),
      50,
    );
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handler);
    };
  }, [onClose, reload, skills.length]);

  const summary = useMemo(() => {
    if (!status) return '';
    const enabled = skills.filter((skill) => skill.modelInvocable).length;
    return `${enabled}/${skills.length} invocable`;
  }, [skills, status]);

  return (
    <div className="resume-picker">
      <div className="resume-picker-header">
        <span className="resume-picker-title">Skills</span>
        <span className="resume-picker-count">{summary}</span>
      </div>

      <div className="resume-picker-search">
        <span className="resume-picker-search-hint">
          {message ||
            (loading ? 'Loading skills...' : `${skills.length} skills`)}
        </span>
      </div>

      <div className="resume-picker-sep" />

      <div className="resume-picker-list" ref={listRef}>
        {!loading && skills.length === 0 && (
          <div className="resume-picker-empty">No skills available.</div>
        )}
        {skills.map((skill, i) => (
          <div
            key={`${skill.level}:${skill.name}`}
            className={`resume-picker-item ${i === selectedIdx ? 'selected' : ''}`}
            onMouseEnter={() => setSelectedIdx(i)}
          >
            <div className="resume-picker-item-row">
              <span className="resume-picker-item-prefix">
                {i === selectedIdx ? '›' : ' '}
              </span>
              <span className="resume-picker-item-title">{skill.name}</span>
              <span className="resume-picker-item-badge">
                {statusLabel(skill)}
              </span>
            </div>
            <div className="resume-picker-item-meta">{metaText(skill)}</div>
            {skill.description && (
              <div className="dialog-detail">
                <div className="dialog-detail-body">{skill.description}</div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="resume-picker-sep" />

      <div className="resume-picker-footer">
        {selected
          ? `Use /skills ${selected.name} to invoke · r to refresh · Esc to close`
          : 'r to refresh · Esc to close'}
      </div>
    </div>
  );
}
