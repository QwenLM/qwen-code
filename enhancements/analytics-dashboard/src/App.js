import React from 'react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend } from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const usageData = window.USAGE_DATA || [];

const tokenUsageData = {
  labels: usageData.map(d => new Date(d.timestamp).toLocaleDateString()),
  datasets: [
    {
      label: 'Tokens Used',
      data: usageData.map(d => d.tokens),
      fill: false,
      backgroundColor: 'rgb(75, 192, 192)',
      borderColor: 'rgba(75, 192, 192, 0.2)',
    },
  ],
};

const commandHistory = usageData.map((d, i) => ({
    id: i + 1,
    command: d.command,
    tokens: d.tokens,
}));

function App() {
  return (
    <div style={{ padding: '2rem' }}>
      <h1>Usage Analytics Dashboard</h1>

      <h2>Token Usage (Last 7 Days)</h2>
      <div style={{ width: '600px', height: '300px' }}>
        <Line data={tokenUsageData} />
      </div>

      <h2>Command History</h2>
      <table style={{ width: '600px', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ border: '1px solid #ddd', padding: '8px' }}>Command</th>
            <th style={{ border: '1px solid #ddd', padding: '8px' }}>Tokens Used</th>
          </tr>
        </thead>
        <tbody>
          {commandHistory.map((cmd) => (
            <tr key={cmd.id}>
              <td style={{ border: '1px solid #ddd', padding: '8px' }}>{cmd.command}</td>
              <td style={{ border: '1px solid #ddd', padding: '8px' }}>{cmd.tokens}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;
