# 📊 Interactive Code Health Dashboard

A real-time, terminal-based dashboard that visualizes your code health metrics with beautiful live updates!

## Features

- **Live Metrics** - Real-time updates of code statistics
- **Interactive UI** - Navigate with keyboard shortcuts
- **Health Score** - Overall code health at a glance
- **Trend Charts** - Visual representation of changes over time
- **Quick Actions** - One-key commands for common tasks
- **Alert System** - Notifications for critical issues
- **Multi-Project** - Monitor multiple repositories
- **Customizable** - Configure metrics and layout

## Quick Start

```bash
# Launch dashboard for current project
qwen-code dashboard

# Monitor specific directory
qwen-code dashboard ./src

# Multi-project mode
qwen-code dashboard --projects ./proj1,./proj2,./proj3

# Compact mode (single screen)
qwen-code dashboard --compact

# Export snapshot
qwen-code dashboard --snapshot report.md
```

## Dashboard Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    🏥 Code Health Dashboard v1.0                        │
│                        Project: qwen-code                               │
│                    Last Updated: 2025-11-12 14:30:45                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Overall Health Score: 82/100  😊                                       │
│  ████████████████████████████████████████████████░░░░░░░░░░            │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │  Core Metrics                                              Live   │ │
│  ├───────────────────────────────────────────────────────────────────┤ │
│  │  📁 Total Files            1,234  ↑ +12  (today)                 │ │
│  │  📝 Lines of Code         45,678  ↑ +234 (today)                 │ │
│  │  🧪 Test Coverage            85%  → stable                        │ │
│  │  🔧 Avg Complexity           4.2  ↓ improved!                     │ │
│  │  📚 Documentation            78%  ↑ +5%                           │ │
│  │  🐛 Known Issues              12  ↓ -3                            │ │
│  │  ⚡ Build Time             2.3s  → stable                         │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │  Quality Trends (Last 7 Days)                                     │ │
│  ├───────────────────────────────────────────────────────────────────┤ │
│  │   100┤                                          ╭─●               │ │
│  │    90┤                                   ╭──────╯                 │ │
│  │    80┤                            ╭──────╯                        │ │
│  │    70┤                     ╭──────╯                               │ │
│  │    60┤              ╭──────╯                                      │ │
│  │    50┤       ╭──────╯                                             │ │
│  │    40┤●──────╯                                                    │ │
│  │      └┬────┬────┬────┬────┬────┬────┬────                        │ │
│  │       Mon  Tue  Wed  Thu  Fri  Sat  Sun                          │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │  🎯 Active Alerts                                                 │ │
│  ├───────────────────────────────────────────────────────────────────┤ │
│  │  🟡 src/utils/parser.ts - Complexity 15 (threshold: 10)          │ │
│  │  🟠 Test coverage dropped 5% in last 24h                          │ │
│  │  🟢 All critical issues resolved! Great work! ✨                  │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │  Quick Actions                                                    │ │
│  ├───────────────────────────────────────────────────────────────────┤ │
│  │  [r] Run Tests    [b] Build    [l] Lint    [m] Mood Check        │ │
│  │  [s] Snapshot     [e] Export   [c] Config  [q] Quit              │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  💡 Tip: Press 'h' for help, 'Tab' to cycle views                      │
└─────────────────────────────────────────────────────────────────────────┘
```

## Keyboard Controls

### Navigation
- **↑↓** - Scroll through alerts and metrics
- **Tab** - Cycle through dashboard views
- **PgUp/PgDn** - Page up/down
- **Home/End** - Jump to top/bottom

### Actions
- **r** - Run tests
- **b** - Build project
- **l** - Lint code
- **m** - Check code mood
- **s** - Save snapshot
- **e** - Export report
- **c** - Open configuration
- **h** - Show help
- **f** - Toggle fullscreen
- **p** - Pause/Resume updates
- **q** - Quit dashboard

### Views
- **1** - Overview (default)
- **2** - Detailed metrics
- **3** - Trend charts
- **4** - File explorer
- **5** - Dependency graph
- **6** - Git activity

## Dashboard Views

### 1. Overview
The main view showing key metrics, trends, and alerts.

### 2. Detailed Metrics
Expanded metrics with breakdowns:
- File statistics by type
- Complexity per module
- Test coverage by directory
- Performance metrics
- Dependency analysis

### 3. Trend Charts
Visual charts showing:
- Health score over time
- Code churn rate
- Issue resolution rate
- Test pass rate
- Build performance

### 4. File Explorer
Interactive file browser with:
- Color-coded health indicators
- Sort by complexity, coverage, age
- Quick actions on files

### 5. Dependency Graph
Visual dependency map with:
- Module connections
- Circular dependency detection
- Unused dependency highlighting

### 6. Git Activity
Recent activity including:
- Commit frequency
- Top contributors
- Hot spots (frequently changed files)
- Code review metrics

## Configuration

Create `.qwenhealthrc.json`:

```json
{
  "refreshInterval": 5000,
  "alertThresholds": {
    "complexity": 10,
    "testCoverage": 80,
    "buildTime": 5000,
    "fileSize": 500
  },
  "views": {
    "overview": true,
    "trends": true,
    "alerts": true,
    "quickActions": true
  },
  "notifications": {
    "sound": false,
    "desktop": true
  },
  "theme": {
    "style": "modern",
    "colors": true,
    "animations": true
  },
  "export": {
    "format": "markdown",
    "includeCharts": true,
    "schedule": "daily"
  }
}
```

## Alert Rules

Configure custom alerts:

```json
{
  "alerts": [
    {
      "name": "High Complexity",
      "condition": "complexity > 10",
      "severity": "warning",
      "action": "notify"
    },
    {
      "name": "Test Coverage Drop",
      "condition": "coverage_change < -5",
      "severity": "error",
      "action": "notify+block"
    },
    {
      "name": "Build Success",
      "condition": "build_status == 'pass'",
      "severity": "info",
      "action": "celebrate"
    }
  ]
}
```

## Export Formats

Export dashboard data in multiple formats:

### Markdown
```bash
qwen-code dashboard --export report.md
```

### JSON
```bash
qwen-code dashboard --export data.json --format json
```

### HTML
```bash
qwen-code dashboard --export dashboard.html --format html
```

### CSV
```bash
qwen-code dashboard --export metrics.csv --format csv
```

## Multi-Project Mode

Monitor multiple projects simultaneously:

```bash
# Configuration
{
  "projects": [
    {
      "name": "Frontend",
      "path": "./packages/client",
      "alerts": ["test-coverage", "complexity"]
    },
    {
      "name": "Backend",
      "path": "./packages/server",
      "alerts": ["performance", "security"]
    },
    {
      "name": "Mobile",
      "path": "./packages/mobile",
      "alerts": ["bundle-size", "dependencies"]
    }
  ]
}
```

## Integration

### CI/CD
```yaml
# .github/workflows/dashboard.yml
- name: Generate Dashboard
  run: qwen-code dashboard --snapshot --export dashboard.md

- name: Upload Report
  uses: actions/upload-artifact@v2
  with:
    name: code-health-report
    path: dashboard.md
```

### Pre-commit Hook
```bash
#!/bin/bash
# .git/hooks/pre-commit

# Quick health check
qwen-code dashboard --quick --threshold 70 || {
  echo "❌ Code health below threshold!"
  exit 1
}
```

### VS Code Integration
```json
{
  "tasks": [
    {
      "label": "Code Health Dashboard",
      "type": "shell",
      "command": "qwen-code dashboard",
      "presentation": {
        "reveal": "always",
        "panel": "dedicated"
      }
    }
  ]
}
```

## API Usage

```typescript
import { CodeHealthDashboard } from '@qwen-code/code-health-dashboard';

const dashboard = new CodeHealthDashboard({
  path: './src',
  refreshInterval: 5000,
  theme: 'modern'
});

// Start dashboard
await dashboard.start();

// Get current metrics
const metrics = await dashboard.getMetrics();
console.log(metrics.healthScore);

// Subscribe to updates
dashboard.on('update', (data) => {
  console.log('Health score:', data.healthScore);
});

// Export snapshot
await dashboard.exportSnapshot('report.md');

// Stop dashboard
await dashboard.stop();
```

## Performance

The dashboard is optimized for:
- **Low CPU usage** - Efficient file watching
- **Minimal memory** - Streaming metrics
- **Fast startup** - Lazy loading views
- **Responsive UI** - 60 FPS animations

## Tips & Tricks

1. **Custom Alerts** - Set project-specific thresholds
2. **Team Dashboards** - Share on large screens in office
3. **Continuous Monitoring** - Run in tmux/screen for 24/7 monitoring
4. **Automated Reports** - Schedule daily exports
5. **Integration** - Connect with Slack, Discord, or email

## Troubleshooting

### Dashboard not updating?
```bash
# Check file watcher limits
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

### High CPU usage?
Increase refresh interval:
```json
{ "refreshInterval": 10000 }
```

### Missing metrics?
Ensure required tools are installed:
```bash
npm install --save-dev jest eslint prettier
```

## License

Apache 2.0
