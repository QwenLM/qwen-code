/* eslint-disable react/jsx-no-undef */
/* eslint-disable react/prop-types */
/* eslint-disable no-undef */

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
            primarySuccess={data.primarySuccess}
            outcomes={data.outcomes}
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

      <ExportButton />
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
