/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { DashboardCards, HeatmapSection } from './Charts';
import type { InsightData, QualitativeData, InsightLocalizedStrings } from './types';
import { CopyButton, MarkdownText } from './Components';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react';

// -----------------------------------------------------------------------------
// i18n Helper
// -----------------------------------------------------------------------------
function getI18n(): InsightLocalizedStrings {
  if (typeof window !== 'undefined' && window.INSIGHT_I18N) {
    return window.INSIGHT_I18N;
  }
  // Default English strings
  return {
    language: 'en',
    title: 'Qwen Code Insights',
    subtitle: 'Your personalized coding journey and patterns',
    messagesAcrossSessions: 'messages across {{sessions}} sessions',
    atAGlance: 'At a Glance',
    whatsWorking: "What's working:",
    whatsHindering: "What's hindering you:",
    quickWins: 'Quick wins to try:',
    ambitiousWorkflows: 'Ambitious workflows:',
    impressiveThingsYouDid: 'Impressive Things You Did',
    whereThingsGoWrong: 'Where Things Go Wrong',
    existingFeaturesToTry: 'Existing Qwen Code Features to Try',
    newWaysToUse: 'New Ways to Use Qwen Code',
    onTheHorizon: 'On the Horizon',
    whatYouWorkOn: 'What You Work On',
    howYouUseQwenCode: 'How You Use Qwen Code',
    whatYouWanted: 'What You Wanted',
    topToolsUsed: 'Top Tools Used',
    whatHelpedMost: "What Helped Most (Qwen's Capabilities)",
    outcomes: 'Outcomes',
    primaryFrictionTypes: 'Primary Friction Types',
    inferredSatisfaction: 'Inferred Satisfaction (model-estimated)',
    suggestedQwenMdAdditions: 'Suggested QWEN.md Additions',
    copyToQwenMd: 'Just copy this into Qwen Code to add it to your QWEN.md.',
    copyAllChecked: 'Copy All Checked',
    copiedAll: 'Copied All!',
    whyForYou: 'Why for you:',
    pasteIntoQwenCode: 'Paste into Qwen Code:',
    gettingStarted: 'Getting started:',
    keyPattern: 'Key pattern:',
    exportCard: 'Export Card',
    lightTheme: 'Light Theme',
    darkTheme: 'Dark Theme',
    noDataAvailable: 'No insight data available',
    seeMoreImpressive: 'Impressive Things You Did →',
    seeMoreFriction: 'Where Things Go Wrong →',
    seeMoreFeatures: 'Features to Try →',
    seeMoreHorizon: 'On the Horizon →',
  };
}

// -----------------------------------------------------------------------------
// Qualitative Insight Components
// -----------------------------------------------------------------------------

export function AtAGlance({ qualitative }: { qualitative: QualitativeData }) {
  const { atAGlance } = qualitative;
  const i18n = getI18n();
  if (!atAGlance) return null;

  return (
    <div className="at-a-glance">
      <div className="glance-title">{i18n.atAGlance}</div>
      <div className="glance-sections">
        <div className="glance-section">
          <strong>{i18n.whatsWorking}</strong>{' '}
          <MarkdownText>{atAGlance.whats_working}</MarkdownText>
          <a href="#section-wins" className="see-more">
            {i18n.seeMoreImpressive}
          </a>
        </div>
        <div className="glance-section">
          <strong>{i18n.whatsHindering}</strong>{' '}
          <MarkdownText>{atAGlance.whats_hindering}</MarkdownText>
          <a href="#section-friction" className="see-more">
            {i18n.seeMoreFriction}
          </a>
        </div>
        <div className="glance-section">
          <strong>{i18n.quickWins}</strong>{' '}
          <MarkdownText>{atAGlance.quick_wins}</MarkdownText>
          <a href="#section-features" className="see-more">
            {i18n.seeMoreFeatures}
          </a>
        </div>
        <div className="glance-section">
          <strong>{i18n.ambitiousWorkflows}</strong>{' '}
          <MarkdownText>{atAGlance.ambitious_workflows}</MarkdownText>
          <a href="#section-horizon" className="see-more">
            {i18n.seeMoreHorizon}
          </a>
        </div>
      </div>
    </div>
  );
}

export function NavToc() {
  const i18n = getI18n();
  return (
    <nav className="nav-toc">
      <a href="#section-work">{i18n.whatYouWorkOn}</a>
      <a href="#section-usage">{i18n.howYouUseQwenCode}</a>
      <a href="#section-wins">{i18n.impressiveThingsYouDid}</a>
      <a href="#section-friction">{i18n.whereThingsGoWrong}</a>
      <a href="#section-features">{i18n.existingFeaturesToTry}</a>
      <a href="#section-patterns">{i18n.newWaysToUse}</a>
      <a href="#section-horizon">{i18n.onTheHorizon}</a>
    </nav>
  );
}

export function ProjectAreas({
  qualitative,
  topGoals,
  topTools,
}: {
  qualitative: QualitativeData;
  topGoals?: Record<string, number>;
  topTools?: Record<string, number> | Array<[string, number]>;
}) {
  const { projectAreas } = qualitative;
  const i18n = getI18n();

  // Convert topTools (array of tuples) to object for chart if needed
  const topToolsObj = Array.isArray(topTools)
    ? Object.fromEntries(topTools)
    : topTools;

  return (
    <>
      <h2
        id="section-work"
        className="text-xl font-semibold text-slate-900 mt-8 mb-4"
      >
        {i18n.whatYouWorkOn}
      </h2>

      {Array.isArray(projectAreas?.areas) && projectAreas.areas.length > 0 && (
        <div className="project-areas mb-6">
          {projectAreas.areas.map((area, idx) => (
            <div key={idx} className="project-area">
              <div className="area-header">
                <span className="area-name">{area.name}</span>
                <span className="area-count">
                  ~{area.session_count} sessions
                </span>
              </div>
              <div className="area-desc">
                <MarkdownText>{area.description}</MarkdownText>
              </div>
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '24px',
          marginBottom: '24px',
        }}
      >
        {topGoals && Object.keys(topGoals).length > 0 && (
          <HorizontalBarChart
            data={topGoals}
            title={i18n.whatYouWanted}
            color="#0ea5e9"
          />
        )}
        {topToolsObj && Object.keys(topToolsObj).length > 0 && (
          <HorizontalBarChart
            data={topToolsObj}
            title={i18n.topToolsUsed}
            color="#6366f1"
          />
        )}
      </div>
    </>
  );
}

export function InteractionStyle({
  qualitative,
  insights,
}: {
  qualitative: QualitativeData;
  insights: InsightData;
}) {
  const { interactionStyle } = qualitative;
  const i18n = getI18n();
  if (!interactionStyle) return null;

  return (
    <>
      <h2
        id="section-usage"
        className="text-xl font-semibold text-slate-900 mt-8 mb-4"
      >
        {i18n.howYouUseQwenCode}
      </h2>
      <div className="narrative">
        <p>
          <MarkdownText>{interactionStyle.narrative}</MarkdownText>
        </p>
        {interactionStyle.key_pattern && (
          <div className="key-insight">
            <strong>{i18n.keyPattern}</strong>{' '}
            <MarkdownText>{interactionStyle.key_pattern}</MarkdownText>
          </div>
        )}
      </div>

      <DashboardCards insights={insights} />
      <HeatmapSection heatmap={insights.heatmap} />
    </>
  );
}

export function ImpressiveWorkflows({
  qualitative,
  primarySuccess,
  outcomes,
}: {
  qualitative: QualitativeData;
  primarySuccess: Record<string, number>;
  outcomes: Record<string, number>;
}) {
  const { impressiveWorkflows } = qualitative;
  const i18n = getI18n();
  if (!impressiveWorkflows) return null;

  return (
    <>
      <h2
        id="section-wins"
        className="text-xl font-semibold text-slate-900 mt-8 mb-4"
      >
        {i18n.impressiveThingsYouDid}
      </h2>
      {impressiveWorkflows.intro && (
        <p className="section-intro">
          <MarkdownText>{impressiveWorkflows.intro}</MarkdownText>
        </p>
      )}
      <div className="big-wins">
        {Array.isArray(impressiveWorkflows.impressive_workflows) &&
          impressiveWorkflows.impressive_workflows.map((win, idx) => (
            <div key={idx} className="big-win">
              <div className="big-win-title">{win.title}</div>
              <div className="big-win-desc">
                <MarkdownText>{win.description}</MarkdownText>
              </div>
            </div>
          ))}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '24px',
          marginTop: '24px',
          marginBottom: '24px',
        }}
      >
        {primarySuccess && Object.keys(primarySuccess).length > 0 && (
          <HorizontalBarChart
            data={primarySuccess}
            title={i18n.whatHelpedMost}
            color="#3b82f6"
            allowedKeys={[
              'fast_accurate_search',
              'correct_code_edits',
              'good_explanations',
              'proactive_help',
              'multi_file_changes',
              'good_debugging',
            ]}
          />
        )}
        {outcomes && Object.keys(outcomes).length > 0 && (
          <HorizontalBarChart
            data={outcomes}
            title={i18n.outcomes}
            color="#8b5cf6"
            allowedKeys={[
              'fully_achieved',
              'mostly_achieved',
              'partially_achieved',
              'not_achieved',
              'unclear_from_transcript',
            ]}
          />
        )}
      </div>
    </>
  );
}

// Format label for display (capitalize and replace underscores with spaces)
function formatLabel(label: string) {
  if (label === 'unclear_from_transcript') {
    return 'Unclear';
  }
  return label
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Horizontal Bar Chart Component
function HorizontalBarChart({
  data,
  title,
  color = '#3b82f6',
  allowedKeys = null,
}: {
  data: Record<string, number>;
  title: string;
  color?: string;
  allowedKeys?: string[] | null;
}) {
  if (!data || Object.keys(data).length === 0) return null;

  // Filter and sort entries
  let entries = Object.entries(data);
  if (allowedKeys) {
    entries = entries.filter(([key]) => allowedKeys.includes(key));
  }
  entries.sort((a, b) => b[1] - a[1]);

  // Limit to at most 10 items
  entries = entries.slice(0, 10);

  if (entries.length === 0) return null;

  const maxValue = Math.max(...entries.map(([, count]) => count));

  return (
    <div
      className="bar-chart-card"
      style={{
        flex: 1,
        minWidth: 0,
        backgroundColor: '#ffffff',
        borderRadius: '12px',
        padding: '20px',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
        border: '1px solid #e2e8f0',
      }}
    >
      <h3
        style={{
          fontSize: '13px',
          fontWeight: 700,
          color: '#64748b',
          marginTop: 0,
          marginBottom: '16px',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}
      >
        {title}
      </h3>
      <div
        className="bar-chart"
        style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
      >
        {entries.map(([label, count]) => {
          const percentage = maxValue > 0 ? (count / maxValue) * 100 : 0;
          return (
            <div
              key={label}
              className="bar-row"
              style={{ display: 'flex', alignItems: 'center', gap: '12px' }}
            >
              <div
                className="bar-label"
                style={{
                  width: '130px',
                  fontSize: '13px',
                  color: '#475569',
                  textAlign: 'left',
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {formatLabel(label)}
              </div>
              <div
                className="bar-wrapper"
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  minWidth: 0,
                }}
              >
                <div
                  className="bar-bg"
                  style={{
                    flex: 1,
                    height: '8px',
                    backgroundColor: '#f1f5f9',
                    borderRadius: '4px',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    className="bar-fill"
                    style={{
                      width: `${percentage}%`,
                      height: '100%',
                      backgroundColor: color,
                      borderRadius: '4px',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
                <span
                  className="bar-value"
                  style={{
                    fontSize: '13px',
                    fontWeight: 600,
                    color: '#475569',
                    minWidth: '24px',
                    textAlign: 'right',
                  }}
                >
                  {count}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function FrictionPoints({
  qualitative,
  satisfaction,
  friction,
}: {
  qualitative: QualitativeData;
  satisfaction?: Record<string, number>;
  friction?: Record<string, number>;
}) {
  const { frictionPoints } = qualitative;
  const i18n = getI18n();
  if (!frictionPoints) return null;

  return (
    <>
      <h2
        id="section-friction"
        className="text-xl font-semibold text-slate-900 mt-8 mb-4"
      >
        {i18n.whereThingsGoWrong}
      </h2>
      {frictionPoints.intro && (
        <p className="section-intro">
          <MarkdownText>{frictionPoints.intro}</MarkdownText>
        </p>
      )}
      <div className="friction-categories">
        {Array.isArray(frictionPoints.categories) &&
          frictionPoints.categories.map((cat, idx) => (
            <div key={idx} className="friction-category">
              <div className="friction-title">{cat.category}</div>
              <div className="friction-desc">
                <MarkdownText>{cat.description}</MarkdownText>
              </div>
              {Array.isArray(cat.examples) && cat.examples.length > 0 && (
                <ul className="friction-examples">
                  {cat.examples.map((ex, i) => (
                    <li key={i}>
                      <MarkdownText>{ex}</MarkdownText>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
      </div>

      {/* Facets Data Charts */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '24px',
          marginTop: '24px',
          marginBottom: '24px',
        }}
      >
        {friction && Object.keys(friction).length > 0 && (
          <HorizontalBarChart
            data={friction}
            title={i18n.primaryFrictionTypes}
            color="#ef4444"
            allowedKeys={[
              'misunderstood_request',
              'wrong_approach',
              'buggy_code',
              'user_rejected_action',
              'excessive_changes',
            ]}
          />
        )}
        {satisfaction && Object.keys(satisfaction).length > 0 && (
          <HorizontalBarChart
            data={satisfaction}
            title={i18n.inferredSatisfaction}
            color="#10b981"
            allowedKeys={[
              'happy',
              'satisfied',
              'likely_satisfied',
              'dissatisfied',
              'frustrated',
            ]}
          />
        )}
      </div>
    </>
  );
}

// Qwen.md Additions Section Component
function QwenMdAdditionsSection({
  additions,
}: {
  additions: NonNullable<
    NonNullable<QualitativeData['improvements']>['Qwen_md_additions']
  >;
}) {
  const i18n = getI18n();
  const [checkedState, setCheckedState] = useState(
    new Array(additions.length).fill(true),
  );
  const [copiedAll, setCopiedAll] = useState(false);

  const handleCheckboxChange = (position: number) => {
    const updatedCheckedState = checkedState.map((item, index) =>
      index === position ? !item : item,
    );
    setCheckedState(updatedCheckedState);
  };

  const handleCopyAll = () => {
    const textToCopy = additions
      .filter((_, index) => checkedState[index])
      .map((item: { addition: any }) => item.addition)
      .join('\n\n');

    if (!textToCopy) return;

    navigator.clipboard.writeText(textToCopy).then(() => {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
    });
  };

  const checkedCount = checkedState.filter(Boolean).length;

  return (
    <div className="qwen-md-section">
      <h3>{i18n.suggestedQwenMdAdditions}</h3>
      <p className="text-xs text-slate-500 mb-3">{i18n.copyToQwenMd}</p>

      <div className="qwen-md-actions" style={{ marginBottom: '12px' }}>
        <button
          className={`copy-all-btn ${copiedAll ? 'copied' : ''}`}
          onClick={handleCopyAll}
          disabled={checkedCount === 0}
        >
          {copiedAll ? i18n.copiedAll : `${i18n.copyAllChecked} (${checkedCount})`}
        </button>
      </div>

      {additions.map((item, idx) => (
        <div key={idx} className="qwen-md-item">
          <input
            type="checkbox"
            checked={checkedState[idx]}
            onChange={() => handleCheckboxChange(idx)}
            className="cmd-checkbox"
          />
          <div style={{ flex: 1 }}>
            <code className="cmd-code">{item.addition}</code>
            <div className="cmd-why">
              <MarkdownText>{item.why}</MarkdownText>
            </div>
          </div>
          <CopyButton text={item.addition} />
        </div>
      ))}
    </div>
  );
}

export function Improvements({
  qualitative,
}: {
  qualitative: QualitativeData;
}) {
  const { improvements } = qualitative;
  const i18n = getI18n();
  if (!improvements) return null;

  return (
    <>
      <h2
        id="section-features"
        className="text-xl font-semibold text-slate-900 mt-8 mb-4"
      >
        {i18n.existingFeaturesToTry}
      </h2>

      {/* QWEN.md Additions */}
      {Array.isArray(improvements.Qwen_md_additions) &&
        improvements.Qwen_md_additions.length > 0 && (
          <QwenMdAdditionsSection additions={improvements.Qwen_md_additions} />
        )}

      <p className="text-xs text-slate-500 mb-3">{i18n.copyToQwenMd}</p>

      {/* Features to Try */}
      <div className="features-section">
        {Array.isArray(improvements.features_to_try) &&
          improvements.features_to_try.map((feat, idx) => (
            <div key={idx} className="feature-card">
              <div className="feature-title">{feat.feature}</div>
              <div className="feature-oneliner">
                <MarkdownText>{feat.one_liner}</MarkdownText>
              </div>
              <div className="feature-why">
                <strong>{i18n.whyForYou}</strong>{' '}
                <MarkdownText>{feat.why_for_you}</MarkdownText>
              </div>
              <div className="feature-examples">
                <div className="feature-example">
                  <div className="example-code-row">
                    <code className="example-code">{feat.example_code}</code>
                    <CopyButton text={feat.example_code} />
                  </div>
                </div>
              </div>
            </div>
          ))}
      </div>

      <h2
        id="section-patterns"
        className="text-xl font-semibold text-slate-900 mt-8 mb-4"
      >
        {i18n.newWaysToUse}
      </h2>
      <p className="text-xs text-slate-500 mb-3">
        Just copy this into Qwen Code and it&apos;ll walk you through it.
      </p>

      <div className="patterns-section">
        {Array.isArray(improvements.usage_patterns) &&
          improvements.usage_patterns.map((pat, idx) => (
            <div key={idx} className="pattern-card">
              <div className="pattern-title">{pat.title}</div>
              <div className="pattern-summary">
                <MarkdownText>{pat.suggestion}</MarkdownText>
              </div>
              <div className="pattern-detail">
                <MarkdownText>{pat.detail}</MarkdownText>
              </div>
              <div className="copyable-prompt-section">
                <div className="prompt-label">Paste into Qwen Code:</div>
                <div className="copyable-prompt-row">
                  <code className="copyable-prompt">{pat.copyable_prompt}</code>
                  <CopyButton text={pat.copyable_prompt} />
                </div>
              </div>
            </div>
          ))}
      </div>
    </>
  );
}

export function FutureOpportunities({
  qualitative,
}: {
  qualitative: QualitativeData;
}) {
  const { futureOpportunities } = qualitative;
  const i18n = getI18n();
  if (!futureOpportunities) return null;

  return (
    <>
      <h2
        id="section-horizon"
        className="text-xl font-semibold text-slate-900 mt-8 mb-4"
      >
        {i18n.onTheHorizon}
      </h2>
      {futureOpportunities.intro && (
        <p className="section-intro">
          <MarkdownText>{futureOpportunities.intro}</MarkdownText>
        </p>
      )}

      <div className="horizon-section">
        {Array.isArray(futureOpportunities.opportunities) &&
          futureOpportunities.opportunities.map((opp, idx) => (
            <div key={idx} className="horizon-card">
              <div className="horizon-title">{opp.title}</div>
              <div className="horizon-possible">
                <MarkdownText>{opp.whats_possible}</MarkdownText>
              </div>
              <div className="horizon-tip">
                <strong>{i18n.gettingStarted}</strong>{' '}
                <MarkdownText>{opp.how_to_try}</MarkdownText>
              </div>
              <div className="pattern-prompt">
                <div className="prompt-label">{i18n.pasteIntoQwenCode}</div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '8px',
                  }}
                >
                  <code style={{ flex: 1 }}>{opp.copyable_prompt}</code>
                  <CopyButton text={opp.copyable_prompt} />
                </div>
              </div>
            </div>
          ))}
      </div>
    </>
  );
}

export function MemorableMoment({
  qualitative,
}: {
  qualitative: QualitativeData;
}) {
  const { memorableMoment } = qualitative;
  if (!memorableMoment) return null;

  return (
    <div className="fun-ending">
      <div className="fun-headline">&quot;{memorableMoment.headline}&quot;</div>
      <div className="fun-detail">
        <MarkdownText>{memorableMoment.detail}</MarkdownText>
      </div>
    </div>
  );
}
