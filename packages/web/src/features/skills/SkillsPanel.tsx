import { useSkills } from '@qwen-code/webui/daemon-react-sdk';
import { ResourceState } from '../common/ResourceState';

export function SkillsPanel() {
  const skills = useSkills({ autoLoad: true });

  return (
    <div className="web-panel">
      <div className="web-panel-header">
        <div>
          <h2>Skills</h2>
          <p>
            {skills.skills.length} available skill
            {skills.skills.length === 1 ? '' : 's'}
          </p>
        </div>
        <button type="button" onClick={() => void skills.reload()}>
          Refresh
        </button>
      </div>
      <ResourceState
        loading={skills.loading}
        error={skills.error}
        empty={skills.skills.length === 0}
        emptyText="No skills reported by the daemon."
      >
        <div className="web-list">
          {skills.skills.map((skill) => (
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
            </article>
          ))}
        </div>
      </ResourceState>
    </div>
  );
}
