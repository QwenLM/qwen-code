import { useMemo, useState } from 'react';
import { useSkills } from '@qwen-code/webui/daemon-react-sdk';
import { errorMessage, ResourceState } from '../common/ResourceState';

interface SkillsPanelProps {
  onAddToChat?: (text: string) => void;
  onRunSkill?: (text: string) => void;
}

export function SkillsPanel({ onAddToChat, onRunSkill }: SkillsPanelProps) {
  const skills = useSkills({ autoLoad: true });
  const [query, setQuery] = useState('');
  const [levelFilter, setLevelFilter] = useState('all');
  const [copiedSkill, setCopiedSkill] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const levels = useMemo(
    () => Array.from(new Set(skills.skills.map((skill) => skill.level))).sort(),
    [skills.skills],
  );
  const filteredSkills = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return skills.skills.filter((skill) => {
      const matchesLevel = levelFilter === 'all' || skill.level === levelFilter;
      if (!matchesLevel) return false;
      if (!normalizedQuery) return true;
      return `${skill.name} ${skill.description} ${skill.argumentHint ?? ''}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [levelFilter, query, skills.skills]);

  async function copySkillName(name: string) {
    setActionError(undefined);
    try {
      await navigator.clipboard.writeText(name);
      setCopiedSkill(name);
      window.setTimeout(() => setCopiedSkill(undefined), 1200);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  return (
    <div className="web-panel">
      <div className="web-panel-header">
        <div>
          <h2>Skills</h2>
          <p>
            {filteredSkills.length} / {skills.skills.length} available skill
            {skills.skills.length === 1 ? '' : 's'}
          </p>
        </div>
        <button type="button" onClick={() => void skills.reload()}>
          Refresh
        </button>
      </div>
      <div className="web-filter-bar">
        <input
          aria-label="Search skills"
          name="skill-search"
          placeholder="Search skills"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="Filter skills by level"
          value={levelFilter}
          onChange={(event) => setLevelFilter(event.target.value)}
        >
          <option value="all">All levels</option>
          {levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </div>
      <div className="web-action-result">
        Skills are read-only here; Run sends the slash command to chat.
      </div>
      {actionError ? <div className="web-error">{actionError}</div> : null}
      <ResourceState
        loading={skills.loading}
        error={skills.error}
        empty={filteredSkills.length === 0}
        emptyText="No skills match the current filters."
      >
        <div className="web-list">
          {filteredSkills.map((skill) => (
            <article className="web-card" key={`${skill.level}:${skill.name}`}>
              <div className="web-card-main">
                <h3>{skill.name}</h3>
                <p>{skill.description}</p>
                <div className="web-meta">
                  <span>{skill.level}</span>
                  {skill.modelInvocable ? <span>model invocable</span> : null}
                  {skill.argumentHint ? (
                    <span>{skill.argumentHint}</span>
                  ) : null}
                </div>
              </div>
              <div className="web-card-actions">
                <button
                  type="button"
                  onClick={() => void copySkillName(skill.name)}
                >
                  {copiedSkill === skill.name ? 'Copied' : 'Copy name'}
                </button>
                {onAddToChat ? (
                  <button
                    type="button"
                    onClick={() => onAddToChat(`/${skill.name} `)}
                  >
                    Insert command
                  </button>
                ) : null}
                {onRunSkill ? (
                  <button
                    type="button"
                    onClick={() => onRunSkill(`/${skill.name}`)}
                  >
                    Run
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </ResourceState>
    </div>
  );
}
