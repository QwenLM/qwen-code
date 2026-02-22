import { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Header, StatsRow } from './Header';
import {
  AtAGlance,
  NavToc,
  ProjectAreas,
  InteractionStyle,
  ImpressiveWorkflows,
  FrictionPoints,
  Improvements,
  FutureOpportunities,
  MemorableMoment,
} from './Qualitative';
import { ShareCard } from './ShareCard';
import './styles.css';
import { InsightData } from './types';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react';

// Main App Component
function InsightApp({ data }: { data: InsightData }) {
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
    const timestamps = dates.map((d) => d.getTime());
    const minDate = new Date(Math.min(...timestamps));
    const maxDate = new Date(Math.max(...timestamps));
    const formatDate = (d: Date) => d.toISOString().split('T')[0];
    dateRangeStr = `${formatDate(minDate)} to ${formatDate(maxDate)}`;
  }

  return (
    <div>
      <div className="header-with-action">
        <Header data={data} dateRangeStr={dateRangeStr} />
        <ShareButton />
      </div>

      {data.qualitative && (
        <>
          <AtAGlance qualitative={data.qualitative} />
          <NavToc />
        </>
      )}

      <StatsRow data={data} />

      {data.qualitative && (
        <>
          <ProjectAreas
            qualitative={data.qualitative}
            topGoals={data.topGoals}
            topTools={data.topTools}
          />
        </>
      )}

      {data.qualitative && (
        <>
          <InteractionStyle qualitative={data.qualitative} insights={data} />
        </>
      )}

      {data.qualitative && (
        <>
          <ImpressiveWorkflows
            qualitative={data.qualitative}
            primarySuccess={data.primarySuccess!}
            outcomes={data.outcomes!}
          />
          <FrictionPoints
            qualitative={data.qualitative}
            satisfaction={data.satisfaction}
            friction={data.friction}
          />
          <Improvements qualitative={data.qualitative} />
          <FutureOpportunities qualitative={data.qualitative} />
          <MemorableMoment qualitative={data.qualitative} />
        </>
      )}

      <ShareCard data={data} />
    </div>
  );
}

// Share Button Component
function ShareButton() {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    const card = document.getElementById('share-card');
    if (!card || !window.html2canvas) {
      alert('Export functionality is not available.');
      return;
    }

    setIsExporting(true);
    try {
      // Clone the card off-screen so it renders but isn't visible
      const clone = card.cloneNode(true) as HTMLElement;
      clone.style.position = 'fixed';
      clone.style.left = '-9999px';
      clone.style.top = '0';
      clone.style.pointerEvents = 'none';
      document.body.appendChild(clone);

      const canvas = await window.html2canvas(clone, {
        scale: 2,
        useCORS: true,
        logging: false,
        width: 1200,
        height: clone.scrollHeight,
      });

      document.body.removeChild(clone);

      const imgData = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = imgData;
      link.download = `qwen-insights-card-${new Date().toISOString().slice(0, 10)}.png`;
      link.click();
    } catch (error) {
      console.error('Export card error:', error);
      alert('Failed to export card. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <button onClick={handleExport} disabled={isExporting} className="share-btn">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
        <polyline points="16 6 12 2 8 6" />
        <line x1="12" y1="2" x2="12" y2="15" />
      </svg>
      {isExporting ? 'Exporting...' : 'Share as Card'}
    </button>
  );
}

// App Initialization - Mount React app when DOM is ready
const container = document.getElementById('react-root');
if (container && window.INSIGHT_DATA && ReactDOM) {
  const root = ReactDOM.createRoot(container);
  root.render(<InsightApp data={window.INSIGHT_DATA} />);
} else {
  console.error('Failed to mount React app:', {
    container: !!container,
    data: !!window.INSIGHT_DATA,
    ReactDOM: !!ReactDOM,
  });
}
