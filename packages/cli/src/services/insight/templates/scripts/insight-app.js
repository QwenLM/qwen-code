/* eslint-disable react/prop-types */
/* eslint-disable no-undef */
// React-based implementation of the insight app
// Converts the vanilla JavaScript implementation to React

const { useState, useRef, useEffect } = React;

// Simple Markdown Parser Component
function MarkdownText({ children }) {
  if (!children || typeof children !== 'string') return children;

  // Split by bold markers (**text**)
  const parts = children.split(/(\*\*.*?\*\*)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        return part;
      })}
    </>
  );
}

// Header Component
function Header({ data, dateRangeStr }) {
  const { totalMessages, totalSessions } = data;

  return (
    <header className="mb-8 space-y-3 text-center">
      <h1 className="text-3xl font-semibold text-slate-900 md:text-4xl">
        Qwen Code Insights
      </h1>
      <p className="text-sm text-slate-600">
        {totalMessages
          ? `${totalMessages} messages across ${totalSessions} sessions`
          : 'Your personalized coding journey and patterns'}
        {dateRangeStr && ` | ${dateRangeStr}`}
      </p>
    </header>
  );
}

function StatsRow({ data }) {
  const {
    totalMessages = 0,
    totalLinesAdded = 0,
    totalLinesRemoved = 0,
    totalFiles = 0,
    // totalSessions = 0,
    // totalHours = 0,
  } = data;

  const heatmapKeys = Object.keys(data.heatmap || {});
  let daysSpan = 0;
  if (heatmapKeys.length > 0) {
    const dates = heatmapKeys.map((d) => new Date(d));
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    const diffTime = Math.abs(maxDate - minDate);
    daysSpan = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
  }

  const msgsPerDay = daysSpan > 0 ? Math.round(totalMessages / daysSpan) : 0;

  return (
    <div className="stats-row">
      <div className="stat">
        <div className="stat-value">{totalMessages}</div>
        <div className="stat-label">Messages</div>
      </div>
      <div className="stat">
        <div className="stat-value">
          +{totalLinesAdded}/-{totalLinesRemoved}
        </div>
        <div className="stat-label">Lines</div>
      </div>
      <div className="stat">
        <div className="stat-value">{totalFiles}</div>
        <div className="stat-label">Files</div>
      </div>
      <div className="stat">
        <div className="stat-value">{daysSpan}</div>
        <div className="stat-label">Days</div>
      </div>
      <div className="stat">
        <div className="stat-value">{msgsPerDay}</div>
        <div className="stat-label">Msgs/Day</div>
      </div>
    </div>
  );
}

// Main App Component
function InsightApp({ data }) {
  if (!data) {
    return (
      <div className="text-center text-slate-600">
        No insight data available
      </div>
    );
  }

  // Calculate date range
  const heatmapKeys = Object.keys(data.heatmap || {});
  let dateRangeStr = '';
  if (heatmapKeys.length > 0) {
    const dates = heatmapKeys.map((d) => new Date(d));
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    const formatDate = (d) => d.toISOString().split('T')[0];
    dateRangeStr = `${formatDate(minDate)} to ${formatDate(maxDate)}`;
  }

  return (
    <div>
      <Header data={data} dateRangeStr={dateRangeStr} />

      {data.qualitative && (
        <>
          <AtAGlance qualitative={data.qualitative} />
          <NavToc />
        </>
      )}

      <StatsRow data={data} />

      <DashboardCards insights={data} />

      {data.qualitative && (
        <>
          <ProjectAreas qualitative={data.qualitative} />
        </>
      )}

      <HeatmapSection heatmap={data.heatmap} />

      {data.qualitative && (
        <>
          <InteractionStyle qualitative={data.qualitative} />
        </>
      )}

      <TokenUsageSection tokenUsage={data.tokenUsage} />
      <AchievementsSection achievements={data.achievements} />

      {data.qualitative && (
        <>
          <ImpressiveWorkflows qualitative={data.qualitative} />
          <FrictionPoints qualitative={data.qualitative} />
          <Improvements qualitative={data.qualitative} />
          <FutureOpportunities qualitative={data.qualitative} />
          <MemorableMoment qualitative={data.qualitative} />
        </>
      )}

      <ExportButton />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Qualitative Insight Components
// -----------------------------------------------------------------------------

function AtAGlance({ qualitative }) {
  const { atAGlance } = qualitative;
  if (!atAGlance) return null;

  return (
    <div className="at-a-glance">
      <div className="glance-title">At a Glance</div>
      <div className="glance-sections">
        <div className="glance-section">
          <strong>What&apos;s working:</strong>{' '}
          <MarkdownText>{atAGlance.whats_working}</MarkdownText>
          <a href="#section-wins" className="see-more">
            Impressive Things You Did →
          </a>
        </div>
        <div className="glance-section">
          <strong>What&apos;s hindering you:</strong>{' '}
          <MarkdownText>{atAGlance.whats_hindering}</MarkdownText>
          <a href="#section-friction" className="see-more">
            Where Things Go Wrong →
          </a>
        </div>
        <div className="glance-section">
          <strong>Quick wins to try:</strong>{' '}
          <MarkdownText>{atAGlance.quick_wins}</MarkdownText>
          <a href="#section-features" className="see-more">
            Features to Try →
          </a>
        </div>
        <div className="glance-section">
          <strong>Ambitious workflows:</strong>{' '}
          <MarkdownText>{atAGlance.ambitious_workflows}</MarkdownText>
          <a href="#section-horizon" className="see-more">
            On the Horizon →
          </a>
        </div>
      </div>
    </div>
  );
}

function NavToc() {
  return (
    <nav className="nav-toc">
      <a href="#section-work">What You Work On</a>
      <a href="#section-usage">How You Use QC</a>
      <a href="#section-wins">Impressive Things</a>
      <a href="#section-friction">Where Things Go Wrong</a>
      <a href="#section-features">Features to Try</a>
      <a href="#section-patterns">New Usage Patterns</a>
      <a href="#section-horizon">On the Horizon</a>
      <a href="#section-feedback">Team Feedback</a>
    </nav>
  );
}

function ProjectAreas({ qualitative }) {
  const { projectAreas } = qualitative;
  if (!Array.isArray(projectAreas?.areas) || !projectAreas.areas.length)
    return null;

  return (
    <>
      <h2
        id="section-work"
        className="text-xl font-semibold text-slate-900 mt-8 mb-4"
      >
        What You Work On
      </h2>
      <div className="project-areas">
        {projectAreas.areas.map((area, idx) => (
          <div key={idx} className="project-area">
            <div className="area-header">
              <span className="area-name">{area.name}</span>
              <span className="area-count">~{area.session_count} sessions</span>
            </div>
            <div className="area-desc">
              <MarkdownText>{area.description}</MarkdownText>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function InteractionStyle({ qualitative }) {
  const { interactionStyle } = qualitative;
  if (!interactionStyle) return null;

  return (
    <>
      <h2
        id="section-usage"
        className="text-xl font-semibold text-slate-900 mt-8 mb-4"
      >
        How You Use Qwen Code
      </h2>
      <div className="narrative">
        <p>
          <MarkdownText>{interactionStyle.narrative}</MarkdownText>
        </p>
        {interactionStyle.key_pattern && (
          <div className="key-insight">
            <strong>Key pattern:</strong>{' '}
            <MarkdownText>{interactionStyle.key_pattern}</MarkdownText>
          </div>
        )}
      </div>
    </>
  );
}

function ImpressiveWorkflows({ qualitative }) {
  const { impressiveWorkflows } = qualitative;
  if (!impressiveWorkflows) return null;

  return (
    <>
      <h2
        id="section-wins"
        className="text-xl font-semibold text-slate-900 mt-8 mb-4"
      >
        Impressive Things You Did
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
    </>
  );
}

function FrictionPoints({ qualitative }) {
  const { frictionPoints } = qualitative;
  if (!frictionPoints) return null;

  return (
    <>
      <h2
        id="section-friction"
        className="text-xl font-semibold text-slate-900 mt-8 mb-4"
      >
        Where Things Go Wrong
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
    </>
  );
}

function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button className="copy-btn" onClick={handleCopy}>
      {copied ? 'Copied!' : label}
    </button>
  );
}
// Qwen.md Additions Section Component
function QwenMdAdditionsSection({ additions }) {
  const [checkedState, setCheckedState] = useState(
    new Array(additions.length).fill(true),
  );
  const [copiedAll, setCopiedAll] = useState(false);

  const handleCheckboxChange = (position) => {
    const updatedCheckedState = checkedState.map((item, index) =>
      index === position ? !item : item,
    );
    setCheckedState(updatedCheckedState);
  };

  const handleCopyAll = () => {
    const textToCopy = additions
      .filter((_, index) => checkedState[index])
      .map((item) => item.addition)
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
      <h3>Suggested QWEN.md Additions</h3>
      <p className="text-xs text-slate-500 mb-3">
        Just copy this into Qwen Code to add it to your QWEN.md.
      </p>

      <div className="qwen-md-actions" style={{ marginBottom: '12px' }}>
        <button
          className={`copy-all-btn ${copiedAll ? 'copied' : ''}`}
          onClick={handleCopyAll}
          disabled={checkedCount === 0}
        >
          {copiedAll ? 'Copied All!' : `Copy All Checked (${checkedCount})`}
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

function Improvements({ qualitative }) {
  const { improvements } = qualitative;
  if (!improvements) return null;

  return (
    <>
      <h2
        id="section-features"
        className="text-xl font-semibold text-slate-900 mt-8 mb-4"
      >
        Existing QC Features to Try
      </h2>

      {/* QWEN.md Additions */}
      {Array.isArray(improvements.Qwen_md_additions) &&
        improvements.Qwen_md_additions.length > 0 && (
          <QwenMdAdditionsSection additions={improvements.Qwen_md_additions} />
        )}

      <p className="text-xs text-slate-500 mb-3">
        Just copy this into Qwen Code and it&apos;ll set it up for you.
      </p>

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
                <strong>Why for you:</strong>{' '}
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
        New Ways to Use Qwen Code
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

function FutureOpportunities({ qualitative }) {
  const { futureOpportunities } = qualitative;
  if (!futureOpportunities) return null;

  return (
    <>
      <h2
        id="section-horizon"
        className="text-xl font-semibold text-slate-900 mt-8 mb-4"
      >
        On the Horizon
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
                <strong>Getting started:</strong>{' '}
                <MarkdownText>{opp.how_to_try}</MarkdownText>
              </div>
              <div className="pattern-prompt">
                <div className="prompt-label">Paste into Qwen Code:</div>
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

function MemorableMoment({ qualitative }) {
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

// -----------------------------------------------------------------------------
// Existing Components
// -----------------------------------------------------------------------------

// Dashboard Cards Component
function DashboardCards({ insights }) {
  const cardClass = 'glass-card p-6';
  const sectionTitleClass =
    'text-lg font-semibold tracking-tight text-slate-900';
  const captionClass = 'text-sm font-medium text-slate-500';

  return (
    <div className="grid gap-4 md:grid-cols-3 md:gap-6">
      <StreakCard
        currentStreak={insights.currentStreak}
        longestStreak={insights.longestStreak}
        cardClass={cardClass}
        captionClass={captionClass}
      />
      <ActiveHoursChart
        activeHours={insights.activeHours}
        cardClass={cardClass}
        sectionTitleClass={sectionTitleClass}
      />
      <WorkSessionCard
        longestWorkDuration={insights.longestWorkDuration}
        longestWorkDate={insights.longestWorkDate}
        latestActiveTime={insights.latestActiveTime}
        cardClass={cardClass}
        sectionTitleClass={sectionTitleClass}
      />
    </div>
  );
}

// Streak Card Component
function StreakCard({ currentStreak, longestStreak, cardClass, captionClass }) {
  return (
    <div className={`${cardClass} h-full`}>
      <div className="flex items-start justify-between">
        <div>
          <p className={captionClass}>Current Streak</p>
          <p className="mt-1 text-4xl font-bold text-slate-900">
            {currentStreak}
            <span className="ml-2 text-base font-semibold text-slate-500">
              days
            </span>
          </p>
        </div>
        <span className="rounded-full bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700">
          Longest {longestStreak}d
        </span>
      </div>
    </div>
  );
}

// Active Hours Chart Component
function ActiveHoursChart({ activeHours, cardClass, sectionTitleClass }) {
  const chartRef = useRef(null);
  const chartInstance = useRef(null);

  useEffect(() => {
    if (chartInstance.current) {
      chartInstance.current.destroy();
    }

    const canvas = chartRef.current;
    if (!canvas || !window.Chart) return;

    const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
    const data = labels.map((_, i) => activeHours[i] || 0);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    chartInstance.current = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Activity per Hour',
            data,
            backgroundColor: 'rgba(52, 152, 219, 0.7)',
            borderColor: 'rgba(52, 152, 219, 1)',
            borderWidth: 1,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            beginAtZero: true,
          },
        },
        plugins: {
          legend: {
            display: false,
          },
        },
      },
    });

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }
    };
  }, [activeHours]);

  return (
    <div className={`${cardClass} h-full`}>
      <div className="flex items-center justify-between">
        <h3 className={sectionTitleClass}>Active Hours</h3>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
          24h
        </span>
      </div>
      <div className="mt-4 h-56 w-full">
        <canvas ref={chartRef} className="w-full h-56" />
      </div>
    </div>
  );
}

// Work Session Card Component
function WorkSessionCard({
  longestWorkDuration,
  longestWorkDate,
  latestActiveTime,
  cardClass,
  sectionTitleClass,
}) {
  return (
    <div className={`${cardClass} h-full space-y-3`}>
      <h3 className={sectionTitleClass}>Work Session</h3>
      <div className="grid grid-cols-2 gap-3 text-sm text-slate-700">
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Longest
          </p>
          <p className="mt-1 text-lg font-semibold text-slate-900">
            {longestWorkDuration}m
          </p>
        </div>
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Date
          </p>
          <p className="mt-1 text-lg font-semibold text-slate-900">
            {longestWorkDate || '-'}
          </p>
        </div>
        <div className="col-span-2 rounded-xl bg-slate-50 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Last Active
          </p>
          <p className="mt-1 text-lg font-semibold text-slate-900">
            {latestActiveTime || '-'}
          </p>
        </div>
      </div>
    </div>
  );
}

// Heatmap Section Component
function HeatmapSection({ heatmap }) {
  const cardClass = 'glass-card p-6';
  const sectionTitleClass =
    'text-lg font-semibold tracking-tight text-slate-900';

  return (
    <div className={`${cardClass} mt-4 space-y-4 md:mt-6`}>
      <div className="flex items-center justify-between">
        <h3 className={sectionTitleClass}>Activity Heatmap</h3>
        <span className="text-xs font-semibold text-slate-500">Past year</span>
      </div>
      <div className="heatmap-container">
        <div className="min-w-[720px] rounded-xl border border-slate-100 bg-white/70 p-4 shadow-inner shadow-slate-100">
          <ActivityHeatmap heatmapData={heatmap} />
        </div>
      </div>
    </div>
  );
}

// Activity Heatmap Component
function ActivityHeatmap({ heatmapData }) {
  const width = 1000;
  const height = 150;
  const cellSize = 14;
  const cellPadding = 2;

  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(today.getFullYear() - 1);

  // Generate all dates for the past year
  const dates = [];
  const currentDate = new Date(oneYearAgo);
  while (currentDate <= today) {
    dates.push(new Date(currentDate));
    currentDate.setDate(currentDate.getDate() + 1);
  }

  const colorLevels = [0, 2, 4, 10, 20];
  const colors = ['#e2e8f0', '#a5d8ff', '#74c0fc', '#339af0', '#1c7ed6'];

  function getColor(value) {
    if (value === 0) return colors[0];
    for (let i = colorLevels.length - 1; i >= 1; i--) {
      if (value >= colorLevels[i]) return colors[i];
    }
    return colors[1];
  }

  const weeksInYear = Math.ceil(dates.length / 7);
  const startX = 50;
  const startY = 20;

  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  // Generate month labels
  const monthLabels = [];
  let currentMonth = oneYearAgo.getMonth();
  let monthX = startX;

  for (let week = 0; week < weeksInYear; week++) {
    const weekDate = new Date(oneYearAgo);
    weekDate.setDate(weekDate.getDate() + week * 7);

    if (weekDate.getMonth() !== currentMonth) {
      currentMonth = weekDate.getMonth();
      monthLabels.push({
        x: monthX,
        text: months[currentMonth],
      });
      monthX = startX + week * (cellSize + cellPadding);
    }
  }

  return (
    <svg
      className="heatmap-svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      {/* Render heatmap cells */}
      {dates.map((date, index) => {
        const week = Math.floor(index / 7);
        const day = index % 7;

        const x = startX + week * (cellSize + cellPadding);
        const y = startY + day * (cellSize + cellPadding);

        const dateKey = date.toISOString().split('T')[0];
        const value = heatmapData[dateKey] || 0;
        const color = getColor(value);

        return (
          <rect
            key={dateKey}
            className="heatmap-day"
            x={x}
            y={y}
            width={cellSize}
            height={cellSize}
            rx="2"
            fill={color}
            data-date={dateKey}
            data-count={value}
          >
            <title>
              {dateKey}: {value} activities
            </title>
          </rect>
        );
      })}

      {/* Render month labels */}
      {monthLabels.map((label, index) => (
        <text key={index} x={label.x} y="15" fontSize="12" fill="#64748b">
          {label.text}
        </text>
      ))}

      {/* Render legend */}
      <text x={startX} y={height - 40} fontSize="12" fill="#64748b">
        Less
      </text>
      {colors.map((color, index) => {
        const legendX = startX + 40 + index * (cellSize + 2);
        return (
          <rect
            key={index}
            x={legendX}
            y={height - 30}
            width="10"
            height="10"
            rx="2"
            fill={color}
          />
        );
      })}
      <text
        x={startX + 40 + colors.length * (cellSize + 2) + 5}
        y={height - 21}
        fontSize="12"
        fill="#64748b"
      >
        More
      </text>
    </svg>
  );
}

// Token Usage Section Component
function TokenUsageSection({ tokenUsage }) {
  const cardClass = 'glass-card p-6';
  const sectionTitleClass =
    'text-lg font-semibold tracking-tight text-slate-900';

  function calculateTotalTokens(tokenUsage, type) {
    return Object.values(tokenUsage).reduce(
      (acc, usage) => acc + usage[type],
      0,
    );
  }

  return (
    <div className={`${cardClass} mt-4 md:mt-6`}>
      <div className="space-y-3">
        <h3 className={sectionTitleClass}>Token Usage</h3>
        <div className="grid grid-cols-3 gap-3">
          <TokenUsageCard
            label="Input"
            value={calculateTotalTokens(tokenUsage, 'input').toLocaleString()}
          />
          <TokenUsageCard
            label="Output"
            value={calculateTotalTokens(tokenUsage, 'output').toLocaleString()}
          />
          <TokenUsageCard
            label="Total"
            value={calculateTotalTokens(tokenUsage, 'total').toLocaleString()}
          />
        </div>
      </div>
    </div>
  );
}

// Token Usage Card Component
function TokenUsageCard({ label, value }) {
  return (
    <div className="rounded-xl bg-slate-50 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
    </div>
  );
}

// Achievements Section Component
function AchievementsSection({ achievements }) {
  const cardClass = 'glass-card p-6';
  const sectionTitleClass =
    'text-lg font-semibold tracking-tight text-slate-900';

  return (
    <div className={`${cardClass} mt-4 space-y-4 md:mt-6`}>
      <div className="flex items-center justify-between">
        <h3 className={sectionTitleClass}>Achievements</h3>
        <span className="text-xs font-semibold text-slate-500">
          {Array.isArray(achievements) ? achievements.length : 0} total
        </span>
      </div>
      {!Array.isArray(achievements) || achievements.length === 0 ? (
        <p className="text-sm text-slate-600">
          No achievements yet. Keep coding!
        </p>
      ) : (
        <div className="divide-y divide-slate-200">
          {achievements.map((achievement, index) => (
            <AchievementItem key={index} achievement={achievement} />
          ))}
        </div>
      )}
    </div>
  );
}

// Achievement Item Component
function AchievementItem({ achievement }) {
  return (
    <div className="flex flex-col gap-1 py-3 text-left">
      <span className="text-base font-semibold text-slate-900">
        {achievement.name}
      </span>
      <p className="text-sm text-slate-600">{achievement.description}</p>
    </div>
  );
}

// Export Button Component
function ExportButton() {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    const container = document.getElementById('container');

    if (!container || !window.html2canvas) {
      alert('Export functionality is not available.');
      return;
    }

    setIsExporting(true);

    try {
      const canvas = await html2canvas(container, {
        scale: 2,
        useCORS: true,
        logging: false,
      });

      const imgData = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = imgData;
      link.download = `qwen-insights-${new Date().toISOString().slice(0, 10)}.png`;
      link.click();
    } catch (error) {
      console.error('Export error:', error);
      alert('Failed to export image. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="mt-6 flex justify-center">
      <button
        onClick={handleExport}
        disabled={isExporting}
        className="group inline-flex items-center gap-2 rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-soft transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 hover:-translate-y-[1px] hover:shadow-lg active:translate-y-[1px] disabled:opacity-50"
      >
        {isExporting ? 'Exporting...' : 'Export as Image'}
        <span className="text-slate-200 transition group-hover:translate-x-0.5">
          →
        </span>
      </button>
    </div>
  );
}

// App Initialization - Mount React app when DOM is ready
const container = document.getElementById('react-root');
if (container && window.INSIGHT_DATA && window.ReactDOM) {
  const root = ReactDOM.createRoot(container);
  root.render(React.createElement(InsightApp, { data: window.INSIGHT_DATA }));
} else {
  console.error('Failed to mount React app:', {
    container: !!container,
    data: !!window.INSIGHT_DATA,
    ReactDOM: !!window.ReactDOM,
  });
}
