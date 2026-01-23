// Native JavaScript implementation of the insight app
// This replaces the React-based App.tsx functionality

let hourChartInstance = null;

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
});

function initializeApp() {
    const insights = window.INSIGHT_DATA;

    if (!insights) {
        showError('No insight data available');
        return;
    }

    // Create the main content
    createInsightContent(insights);

    // Initialize charts
    initializeHourChart(insights);

    // Initialize heatmap
    initializeHeatmap(insights);
}

function createInsightContent(insights) {
    const container = document.getElementById('container');
    const contentDiv = container.querySelector('.mx-auto');

    // Find the header and content placeholder
    const header = contentDiv.querySelector('header');
    const contentPlaceholder = contentDiv.querySelector('[data-placeholder="content"]');

    // If placeholder doesn't exist, create content after header
    if (!contentPlaceholder) {
        const content = createMainContent(insights);
        header.insertAdjacentHTML('afterend', content);
    }
}

function createMainContent(insights) {
    const cardClass = 'glass-card p-6';
    const sectionTitleClass = 'text-lg font-semibold tracking-tight text-slate-900';
    const captionClass = 'text-sm font-medium text-slate-500';

    return `
        <div class="grid gap-4 md:grid-cols-3 md:gap-6">
            <div class="${cardClass} h-full">
                <div class="flex items-start justify-between">
                    <div>
                        <p class="${captionClass}">Current Streak</p>
                        <p class="mt-1 text-4xl font-bold text-slate-900">
                            ${insights.currentStreak}
                            <span class="ml-2 text-base font-semibold text-slate-500">
                                days
                            </span>
                        </p>
                    </div>
                    <span class="rounded-full bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700">
                        Longest ${insights.longestStreak}d
                    </span>
                </div>
            </div>

            <div class="${cardClass} h-full">
                <div class="flex items-center justify-between">
                    <h3 class="${sectionTitleClass}">Active Hours</h3>
                    <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                        24h
                    </span>
                </div>
                <div class="mt-4 h-56 w-full">
                    <canvas id="hour-chart"></canvas>
                </div>
            </div>

            <div class="${cardClass} h-full space-y-3">
                <h3 class="${sectionTitleClass}">Work Session</h3>
                <div class="grid grid-cols-2 gap-3 text-sm text-slate-700">
                    <div class="rounded-xl bg-slate-50 px-3 py-2">
                        <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Longest
                        </p>
                        <p class="mt-1 text-lg font-semibold text-slate-900">
                            ${insights.longestWorkDuration}m
                        </p>
                    </div>
                    <div class="rounded-xl bg-slate-50 px-3 py-2">
                        <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Date
                        </p>
                        <p class="mt-1 text-lg font-semibold text-slate-900">
                            ${insights.longestWorkDate || '-'}
                        </p>
                    </div>
                    <div class="col-span-2 rounded-xl bg-slate-50 px-3 py-2">
                        <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Last Active
                        </p>
                        <p class="mt-1 text-lg font-semibold text-slate-900">
                            ${insights.latestActiveTime || '-'}
                        </p>
                    </div>
                </div>
            </div>
        </div>

        <div class="${cardClass} mt-4 space-y-4 md:mt-6">
            <div class="flex items-center justify-between">
                <h3 class="${sectionTitleClass}">Activity Heatmap</h3>
                <span class="text-xs font-semibold text-slate-500">
                    Past year
                </span>
            </div>
            <div class="heatmap-container">
                <div id="heatmap" class="min-w-[720px] rounded-xl border border-slate-100 bg-white/70 p-4 shadow-inner shadow-slate-100">
                    <!-- Heatmap will be inserted here -->
                </div>
            </div>
        </div>

        <div class="${cardClass} mt-4 md:mt-6">
            <div class="space-y-3">
                <h3 class="${sectionTitleClass}">Token Usage</h3>
                <div class="grid grid-cols-3 gap-3">
                    <div class="rounded-xl bg-slate-50 px-4 py-3">
                        <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Input
                        </p>
                        <p class="mt-1 text-2xl font-bold text-slate-900">
                            ${calculateTotalTokens(insights.tokenUsage, 'input').toLocaleString()}
                        </p>
                    </div>
                    <div class="rounded-xl bg-slate-50 px-4 py-3">
                        <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Output
                        </p>
                        <p class="mt-1 text-2xl font-bold text-slate-900">
                            ${calculateTotalTokens(insights.tokenUsage, 'output').toLocaleString()}
                        </p>
                    </div>
                    <div class="rounded-xl bg-slate-50 px-4 py-3">
                        <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Total
                        </p>
                        <p class="mt-1 text-2xl font-bold text-slate-900">
                            ${calculateTotalTokens(insights.tokenUsage, 'total').toLocaleString()}
                        </p>
                    </div>
                </div>
            </div>
        </div>

        <div class="${cardClass} mt-4 space-y-4 md:mt-6">
            <div class="flex items-center justify-between">
                <h3 class="${sectionTitleClass}">Achievements</h3>
                <span class="text-xs font-semibold text-slate-500">
                    ${insights.achievements.length} total
                </span>
            </div>
            ${insights.achievements.length === 0 ?
                '<p class="text-sm text-slate-600">No achievements yet. Keep coding!</p>' :
                `<div class="divide-y divide-slate-200">
                    ${insights.achievements.map(achievement => `
                        <div class="flex flex-col gap-1 py-3 text-left">
                            <span class="text-base font-semibold text-slate-900">
                                ${achievement.name}
                            </span>
                            <p class="text-sm text-slate-600">
                                ${achievement.description}
                            </p>
                        </div>
                    `).join('')}
                </div>`
            }
        </div>
    `;
}

function calculateTotalTokens(tokenUsage, type) {
    return Object.values(tokenUsage).reduce((acc, usage) => acc + usage[type], 0);
}

function initializeHourChart(insights) {
    const canvas = document.getElementById('hour-chart');
    if (!canvas || !window.Chart) return;

    // Destroy existing chart if it exists
    if (hourChartInstance) {
        hourChartInstance.destroy();
    }

    const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
    const data = labels.map((_, i) => insights.activeHours[i] || 0);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    hourChartInstance = new Chart(ctx, {
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
}

function initializeHeatmap(insights) {
    const heatmapContainer = document.getElementById('heatmap');
    if (!heatmapContainer) return;

    // Create a simple SVG heatmap
    const svg = createHeatmapSVG(insights.heatmap);
    heatmapContainer.innerHTML = svg;
}

function createHeatmapSVG(heatmapData) {
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

    // Calculate max value for color scaling
    const maxValue = Math.max(...Object.values(heatmapData));
    const colorLevels = [0, 2, 4, 10, 20];
    const colors = ['#e2e8f0', '#a5d8ff', '#74c0fc', '#339af0', '#1c7ed6'];

    function getColor(value) {
        if (value === 0) return colors[0];
        for (let i = colorLevels.length - 1; i >= 1; i--) {
            if (value >= colorLevels[i]) return colors[i];
        }
        return colors[1];
    }

    let svg = `<svg class="heatmap-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;

    // Calculate grid dimensions
    const weeksInYear = Math.ceil(dates.length / 7);
    const startX = 50;
    const startY = 20;

    dates.forEach((date, index) => {
        const week = Math.floor(index / 7);
        const day = index % 7;

        const x = startX + week * (cellSize + cellPadding);
        const y = startY + day * (cellSize + cellPadding);

        const dateKey = date.toISOString().split('T')[0];
        const value = heatmapData[dateKey] || 0;
        const color = getColor(value);

        svg += `<rect class="heatmap-day"
                     x="${x}" y="${y}"
                     width="${cellSize}" height="${cellSize}"
                     rx="2"
                     fill="${color}"
                     data-date="${dateKey}"
                     data-count="${value}">
                     <title>${dateKey}: ${value} activities</title>
                </rect>`;
    });

    // Add month labels
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let currentMonth = oneYearAgo.getMonth();
    let monthX = startX;

    for (let week = 0; week < weeksInYear; week++) {
        const weekDate = new Date(oneYearAgo);
        weekDate.setDate(weekDate.getDate() + week * 7);

        if (weekDate.getMonth() !== currentMonth) {
            currentMonth = weekDate.getMonth();
            svg += `<text x="${monthX}" y="15" font-size="12" fill="#64748b">${months[currentMonth]}</text>`;
            monthX = startX + week * (cellSize + cellPadding);
        }
    }

    // Add legend
    const legendY = height - 30;
    svg += '<text x="' + startX + '" y="' + (legendY - 10) + '" font-size="12" fill="#64748b">Less</text>';

    colors.forEach((color, index) => {
        const legendX = startX + 40 + index * (cellSize + 2);
        svg += `<rect x="${legendX}" y="${legendY}" width="10" height="10" rx="2" fill="${color}"></rect>`;
    });

    svg += '<text x="' + (startX + 40 + colors.length * (cellSize + 2) + 5) + '" y="' + (legendY + 9) + '" font-size="12" fill="#64748b">More</text>';

    svg += '</svg>';
    return svg;
}

// Export functionality
function handleExport() {
    const container = document.getElementById('container');
    const button = document.getElementById('export-btn');

    if (!container || !window.html2canvas) {
        alert('Export functionality is not available.');
        return;
    }

    button.style.display = 'none';

    html2canvas(container, {
        scale: 2,
        useCORS: true,
        logging: false,
    }).then(function(canvas) {
        const imgData = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.href = imgData;
        link.download = `qwen-insights-${new Date().toISOString().slice(0, 10)}.png`;
        link.click();

        button.style.display = 'block';
    }).catch(function(error) {
        console.error('Error capturing image:', error);
        alert('Failed to export image. Please try again.');
        button.style.display = 'block';
    });
}