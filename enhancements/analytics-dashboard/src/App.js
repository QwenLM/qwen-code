import React from 'react';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend } from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const tokenUsageData = {
  labels: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7'],
  datasets: [
    {
      label: 'Tokens Used',
      data: [1200, 1900, 3000, 5000, 2300, 3100, 4000],
      fill: false,
      backgroundColor: 'rgb(75, 192, 192)',
      borderColor: 'rgba(75, 192, 192, 0.2)',
    },
  ],
};

const commandHistory = [
    { id: 1, command: 'Explain this codebase', tokens: 500 },
    { id: 2, command: 'Refactor this function', tokens: 700 },
    { id: 3, command: 'Generate unit tests', tokens: 1200 },
    { id: 4, command: 'What are the key dependencies?', tokens: 600 },
];

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
