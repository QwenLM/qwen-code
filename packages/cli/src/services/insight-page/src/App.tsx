import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Chart,
  LineController,
  LineElement,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  PointElement,
  Legend,
  Title,
  Tooltip,
} from 'chart.js';
import type { ChartConfiguration } from 'chart.js';
import HeatMap from '@uiw/react-heat-map';
import html2canvas from 'html2canvas';

// Register Chart.js components
Chart.register(
  LineController,
  LineElement,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  PointElement,
  Legend,
  Title,
  Tooltip,
);

interface UsageMetadata {
  input: number;
  output: number;
  total: number;
}

interface InsightData {
  heatmap: { [date: string]: number };
  tokenUsage: { [date: string]: UsageMetadata };
  currentStreak: number;
  longestStreak: number;
  longestWorkDate: string | null;
  longestWorkDuration: number;
  activeHours: { [hour: number]: number };
  latestActiveTime: string | null;
  achievements: Array<{
    id: string;
    name: string;
    description: string;
  }>;
}

function App() {
  const [insights, setInsights] = useState<InsightData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hourChartRef = useRef<HTMLCanvasElement>(null);
  const hourChartInstance = useRef<Chart | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load insights data
  useEffect(() => {
    const loadInsights = async () => {
      try {
        setLoading(true);
        const response = await fetch('/api/insights');
        if (!response.ok) {
          throw new Error('Failed to fetch insights');
        }
        const data: InsightData = await response.json();
        setInsights(data);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
        setInsights(null);
      } finally {
        setLoading(false);
      }
    };

    loadInsights();
  }, []);

  // Create hour chart when insights change
  useEffect(() => {
    if (!insights || !hourChartRef.current) return;

    // Destroy existing chart if it exists
    if (hourChartInstance.current) {
      hourChartInstance.current.destroy();
    }

    const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
    const data = labels.map((_, i) => insights.activeHours[i] || 0);

    const ctx = hourChartRef.current.getContext('2d');
    if (!ctx) return;

    hourChartInstance.current = new Chart(ctx, {
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
      } as ChartConfiguration['options'],
    });
  }, [insights]);

  const handleExport = async () => {
    if (!containerRef.current) return;

    try {
      const button = document.getElementById('export-btn') as HTMLButtonElement;
      button.style.display = 'none';

      const canvas = await html2canvas(containerRef.current, {
        scale: 2,
        useCORS: true,
        logging: false,
      });

      const imgData = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = imgData;
      link.download = `qwen-insights-${new Date().toISOString().slice(0, 10)}.png`;
      link.click();

      button.style.display = 'block';
    } catch (err) {
      console.error('Error capturing image:', err);
      alert('Failed to export image. Please try again.');
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-slate-100">
        <div className="glass-card px-8 py-6 text-center">
          <h2 className="text-xl font-semibold text-slate-900">
            Loading insights...
          </h2>
          <p className="mt-2 text-sm text-slate-600">
            Fetching your coding patterns
          </p>
        </div>
      </div>
    );
  }

  if (error || !insights) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-slate-100">
        <div className="glass-card px-8 py-6 text-center">
          <h2 className="text-xl font-semibold text-rose-700">
            Error loading insights
          </h2>
          <p className="mt-2 text-sm text-slate-600">
            {error || 'Please try again later.'}
          </p>
        </div>
      </div>
    );
  }

  // Prepare heatmap data for react-heat-map
  const heatmapData = Object.entries(insights.heatmap).map(([date, count]) => ({
    date,
    count,
  }));

  const cardClass = 'glass-card p-6';
  const sectionTitleClass =
    'text-lg font-semibold tracking-tight text-slate-900';
  const captionClass = 'text-sm font-medium text-slate-500';

  return (
    <div className="min-h-screen" ref={containerRef}>
      <div className="mx-auto max-w-6xl px-6 py-10 md:py-12">
        <header className="mb-8 space-y-3 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            Insights
          </p>
          <h1 className="text-3xl font-semibold text-slate-900 md:text-4xl">
            Qwen Code Insights
          </h1>
          <p className="text-sm text-slate-600">
            Your personalized coding journey and patterns
          </p>
        </header>

        <div className="grid gap-4 md:grid-cols-3 md:gap-6">
          <div className={`${cardClass} h-full`}>
            <div className="flex items-start justify-between">
              <div>
                <p className={captionClass}>Current Streak</p>
                <p className="mt-1 text-4xl font-bold text-slate-900">
                  {insights.currentStreak}
                  <span className="ml-2 text-base font-semibold text-slate-500">
                    days
                  </span>
                </p>
              </div>
              <span className="rounded-full bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700">
                Longest {insights.longestStreak}d
              </span>
            </div>
          </div>

          <div className={`${cardClass} h-full`}>
            <div className="flex items-center justify-between">
              <h3 className={sectionTitleClass}>Active Hours</h3>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                24h
              </span>
            </div>
            <div className="mt-4 h-56 w-full">
              <canvas ref={hourChartRef}></canvas>
            </div>
          </div>

          <div className={`${cardClass} h-full space-y-3`}>
            <h3 className={sectionTitleClass}>Work Session</h3>
            <div className="grid grid-cols-2 gap-3 text-sm text-slate-700">
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Longest
                </p>
                <p className="mt-1 text-lg font-semibold text-slate-900">
                  {insights.longestWorkDuration}m
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Date
                </p>
                <p className="mt-1 text-lg font-semibold text-slate-900">
                  {insights.longestWorkDate || '-'}
                </p>
              </div>
              <div className="col-span-2 rounded-xl bg-slate-50 px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Last Active
                </p>
                <p className="mt-1 text-lg font-semibold text-slate-900">
                  {insights.latestActiveTime || '-'}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className={`${cardClass} mt-4 space-y-4 md:mt-6`}>
          <div className="flex items-center justify-between">
            <h3 className={sectionTitleClass}>Activity Heatmap</h3>
            <span className="text-xs font-semibold text-slate-500">
              Past year
            </span>
          </div>
          <div className="overflow-x-auto">
            <div className="min-w-[720px] rounded-xl border border-slate-100 bg-white/70 p-4 shadow-inner shadow-slate-100">
              <HeatMap
                value={heatmapData}
                width={1000}
                style={{ color: '#0f172a' } satisfies CSSProperties}
                startDate={
                  new Date(new Date().setFullYear(new Date().getFullYear() - 1))
                }
                endDate={new Date()}
                rectSize={14}
                legendCellSize={12}
                rectProps={{
                  rx: 2,
                }}
                panelColors={{
                  0: '#e2e8f0',
                  2: '#a5d8ff',
                  4: '#74c0fc',
                  10: '#339af0',
                  20: '#1c7ed6',
                }}
              />
            </div>
          </div>
        </div>

        <div className={`${cardClass} mt-4 md:mt-6`}>
          <div className="space-y-3">
            <h3 className={sectionTitleClass}>Token Usage</h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl bg-slate-50 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Input
                </p>
                <p className="mt-1 text-2xl font-bold text-slate-900">
                  {Object.values(insights.tokenUsage)
                    .reduce((acc, usage) => acc + usage.input, 0)
                    .toLocaleString()}
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Output
                </p>
                <p className="mt-1 text-2xl font-bold text-slate-900">
                  {Object.values(insights.tokenUsage)
                    .reduce((acc, usage) => acc + usage.output, 0)
                    .toLocaleString()}
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Total
                </p>
                <p className="mt-1 text-2xl font-bold text-slate-900">
                  {Object.values(insights.tokenUsage)
                    .reduce((acc, usage) => acc + usage.total, 0)
                    .toLocaleString()}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className={`${cardClass} mt-4 space-y-4 md:mt-6`}>
          <div className="flex items-center justify-between">
            <h3 className={sectionTitleClass}>Achievements</h3>
            <span className="text-xs font-semibold text-slate-500">
              {insights.achievements.length} total
            </span>
          </div>
          {insights.achievements.length === 0 ? (
            <p className="text-sm text-slate-600">
              No achievements yet. Keep coding!
            </p>
          ) : (
            <div className="divide-y divide-slate-200">
              {insights.achievements.map((achievement) => (
                <div
                  key={achievement.id}
                  className="flex flex-col gap-1 py-3 text-left"
                >
                  <span className="text-base font-semibold text-slate-900">
                    {achievement.name}
                  </span>
                  <p className="text-sm text-slate-600">
                    {achievement.description}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-center">
          <button
            id="export-btn"
            className="group inline-flex items-center gap-2 rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-soft transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 hover:-translate-y-[1px] hover:shadow-lg active:translate-y-[1px]"
            onClick={handleExport}
          >
            Export as Image
            <span className="text-slate-200 transition group-hover:translate-x-0.5">
              →
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
