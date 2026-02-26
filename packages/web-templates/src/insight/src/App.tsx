import { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { StatsRow } from './Header';
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
import { ShareCard, type Theme } from './ShareCard';
import './styles.css';
import type { InsightData } from './types';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react';

// Main App Component
function InsightApp({ data }: { data: InsightData }) {
  const [cardTheme, setCardTheme] = useState<Theme>('dark');
  const pendingExport = useRef(false);

  const performExport = async () => {
    const card = document.getElementById('share-card');
    if (!card || !window.html2canvas) {
      alert('Export functionality is not available.');
      return;
    }

    try {
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
    }
  };

  // Export after React re-renders the card with the new theme
  useEffect(() => {
    if (pendingExport.current) {
      pendingExport.current = false;
      performExport();
    }
  }, [cardTheme]);

  const handleExportWithTheme = (theme: Theme) => {
    if (theme === cardTheme) {
      performExport();
    } else {
      pendingExport.current = true;
      setCardTheme(theme);
    }
  };

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
      {/* Elegant Header */}
      <header className="insights-header">
        <div className="header-content">
          <div className="header-title-section">
            <h1 className="header-title">Qwen Code Insights</h1>
            <p className="header-subtitle">
              {data.totalMessages
                ? `${data.totalMessages.toLocaleString()} messages across ${data.totalSessions?.toLocaleString()} sessions`
                : 'Your personalized coding journey and patterns'}
              {dateRangeStr && ` · ${dateRangeStr}`}
            </p>
          </div>

          <ExportCardButton onExport={handleExportWithTheme} />
        </div>
      </header>

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

      <ShareCard data={data} theme={cardTheme} />
    </div>
  );
}

// Export Card Button with theme dropdown
function ExportCardButton({ onExport }: { onExport: (theme: Theme) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  const handleSelect = (theme: Theme) => {
    setIsOpen(false);
    onExport(theme);
  };

  return (
    <div className="export-dropdown-wrapper" ref={wrapperRef}>
      <button className="export-card-btn" onClick={() => setIsOpen(!isOpen)}>
        <svg
          width="14"
          height="14"
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
        <span>Export Card</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`export-chevron ${isOpen ? 'open' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && (
        <div className="export-dropdown">
          <button
            className="export-dropdown-item"
            onClick={() => handleSelect('light')}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
            <span>Light Theme</span>
          </button>
          <button
            className="export-dropdown-item"
            onClick={() => handleSelect('dark')}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
            <span>Dark Theme</span>
          </button>
        </div>
      )}
    </div>
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
