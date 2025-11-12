/**
 * Interactive Code Health Dashboard
 * Real-time terminal dashboard for code metrics
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { EventEmitter } from 'events';

export interface DashboardConfig {
  path?: string;
  refreshInterval?: number;
  theme?: 'modern' | 'classic' | 'minimal';
  views?: {
    overview?: boolean;
    trends?: boolean;
    alerts?: boolean;
    quickActions?: boolean;
  };
  alertThresholds?: {
    complexity?: number;
    testCoverage?: number;
    buildTime?: number;
    fileSize?: number;
  };
}

export interface HealthMetrics {
  healthScore: number;
  totalFiles: number;
  linesOfCode: number;
  testCoverage: number;
  avgComplexity: number;
  documentation: number;
  knownIssues: number;
  buildTime: number;
  timestamp: Date;
}

export interface Alert {
  severity: 'info' | 'warning' | 'error';
  message: string;
  file?: string;
  timestamp: Date;
}

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m'
};

const BOX = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  tee: '├',
  teeRight: '┤',
  cross: '┼'
};

export class CodeHealthDashboard extends EventEmitter {
  private config: Required<DashboardConfig>;
  private metrics: HealthMetrics | null = null;
  private alerts: Alert[] = [];
  private running = false;
  private updateInterval: NodeJS.Timeout | null = null;

  constructor(config: DashboardConfig = {}) {
    super();
    this.config = {
      path: config.path || '.',
      refreshInterval: config.refreshInterval || 5000,
      theme: config.theme || 'modern',
      views: {
        overview: true,
        trends: true,
        alerts: true,
        quickActions: true,
        ...config.views
      },
      alertThresholds: {
        complexity: 10,
        testCoverage: 80,
        buildTime: 5000,
        fileSize: 500,
        ...config.alertThresholds
      }
    };
  }

  /**
   * Start the dashboard
   */
  async start(): Promise<void> {
    this.running = true;
    await this.update();

    // Set up periodic updates
    this.updateInterval = setInterval(() => {
      this.update().catch(console.error);
    }, this.config.refreshInterval);

    // Render initial dashboard
    this.render();
  }

  /**
   * Stop the dashboard
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Update metrics
   */
  private async update(): Promise<void> {
    // In a real implementation, this would gather actual metrics
    // For now, generate sample data
    this.metrics = {
      healthScore: 82,
      totalFiles: 1234,
      linesOfCode: 45678,
      testCoverage: 85,
      avgComplexity: 4.2,
      documentation: 78,
      knownIssues: 12,
      buildTime: 2.3,
      timestamp: new Date()
    };

    // Check for alerts
    this.checkAlerts();

    // Emit update event
    this.emit('update', this.metrics);
  }

  /**
   * Check for alerts based on thresholds
   */
  private checkAlerts(): void {
    if (!this.metrics) return;

    this.alerts = [];

    // Complexity alert
    if (this.metrics.avgComplexity > this.config.alertThresholds.complexity) {
      this.alerts.push({
        severity: 'warning',
        message: `Average complexity ${this.metrics.avgComplexity.toFixed(1)} exceeds threshold ${this.config.alertThresholds.complexity}`,
        timestamp: new Date()
      });
    }

    // Test coverage alert
    if (this.metrics.testCoverage < this.config.alertThresholds.testCoverage) {
      this.alerts.push({
        severity: 'warning',
        message: `Test coverage ${this.metrics.testCoverage}% below threshold ${this.config.alertThresholds.testCoverage}%`,
        timestamp: new Date()
      });
    }

    // Success message
    if (this.alerts.length === 0) {
      this.alerts.push({
        severity: 'info',
        message: 'All metrics within healthy ranges! Great work! ✨',
        timestamp: new Date()
      });
    }
  }

  /**
   * Render dashboard
   */
  private render(): void {
    if (!this.metrics) return;

    // Clear screen
    console.clear();

    const width = 75;
    let output = '';

    // Header
    output += this.renderHeader(width);
    output += '\n';

    // Overall Health Score
    output += this.renderHealthScore(width);
    output += '\n';

    // Core Metrics
    if (this.config.views.overview) {
      output += this.renderCoreMetrics(width);
      output += '\n';
    }

    // Trends
    if (this.config.views.trends) {
      output += this.renderTrends(width);
      output += '\n';
    }

    // Alerts
    if (this.config.views.alerts) {
      output += this.renderAlerts(width);
      output += '\n';
    }

    // Quick Actions
    if (this.config.views.quickActions) {
      output += this.renderQuickActions(width);
      output += '\n';
    }

    // Footer
    output += this.renderFooter(width);

    console.log(output);
  }

  /**
   * Render header
   */
  private renderHeader(width: number): string {
    const title = '🏥 Code Health Dashboard v1.0';
    const project = `Project: qwen-code`;
    const timestamp = `Last Updated: ${this.metrics!.timestamp.toLocaleString()}`;

    let output = BOX.topLeft + BOX.horizontal.repeat(width - 2) + BOX.topRight + '\n';
    output += BOX.vertical + this.centerText(title, width - 2) + BOX.vertical + '\n';
    output += BOX.vertical + this.centerText(project, width - 2) + BOX.vertical + '\n';
    output += BOX.vertical + this.centerText(timestamp, width - 2) + BOX.vertical + '\n';
    output += BOX.tee + BOX.horizontal.repeat(width - 2) + BOX.teeRight + '\n';

    return output;
  }

  /**
   * Render health score
   */
  private renderHealthScore(width: number): string {
    const score = this.metrics!.healthScore;
    const emoji = score >= 80 ? '😊' : score >= 60 ? '🙂' : score >= 40 ? '😐' : '😟';
    const barLength = width - 6;
    const filled = Math.round((score / 100) * barLength);
    const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);

    let output = BOX.vertical + ' '.repeat(width - 2) + BOX.vertical + '\n';
    output += BOX.vertical + `  Overall Health Score: ${score}/100  ${emoji}` + ' '.repeat(width - 40) + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + bar + '  ' + BOX.vertical + '\n';
    output += BOX.vertical + ' '.repeat(width - 2) + BOX.vertical + '\n';

    return output;
  }

  /**
   * Render core metrics
   */
  private renderCoreMetrics(width: number): string {
    let output = BOX.vertical + '  ' + BOX.topLeft + BOX.horizontal.repeat(width - 6) + BOX.topRight + ' ' + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + BOX.vertical + '  Core Metrics' + ' '.repeat(width - 21) + 'Live   ' + BOX.vertical + ' ' + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + BOX.tee + BOX.horizontal.repeat(width - 6) + BOX.teeRight + ' ' + BOX.vertical + '\n';

    const metrics = [
      { label: '📁 Total Files', value: this.metrics!.totalFiles.toLocaleString(), change: '↑ +12  (today)' },
      { label: '📝 Lines of Code', value: this.metrics!.linesOfCode.toLocaleString(), change: '↑ +234 (today)' },
      { label: '🧪 Test Coverage', value: `${this.metrics!.testCoverage}%`, change: '→ stable' },
      { label: '🔧 Avg Complexity', value: this.metrics!.avgComplexity.toFixed(1), change: '↓ improved!' },
      { label: '📚 Documentation', value: `${this.metrics!.documentation}%`, change: '↑ +5%' },
      { label: '🐛 Known Issues', value: this.metrics!.knownIssues.toString(), change: '↓ -3' },
      { label: '⚡ Build Time', value: `${this.metrics!.buildTime}s`, change: '→ stable' }
    ];

    metrics.forEach(m => {
      const line = `${m.label.padEnd(22)} ${m.value.padEnd(7)} ${m.change}`;
      output += BOX.vertical + '  ' + BOX.vertical + '  ' + line.padEnd(width - 8) + BOX.vertical + ' ' + BOX.vertical + '\n';
    });

    output += BOX.vertical + '  ' + BOX.bottomLeft + BOX.horizontal.repeat(width - 6) + BOX.bottomRight + ' ' + BOX.vertical + '\n';

    return output;
  }

  /**
   * Render trends chart
   */
  private renderTrends(width: number): string {
    let output = BOX.vertical + ' '.repeat(width - 2) + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + BOX.topLeft + BOX.horizontal.repeat(width - 6) + BOX.topRight + ' ' + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + BOX.vertical + '  Quality Trends (Last 7 Days)' + ' '.repeat(width - 35) + BOX.vertical + ' ' + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + BOX.tee + BOX.horizontal.repeat(width - 6) + BOX.teeRight + ' ' + BOX.vertical + '\n';

    // Simple ASCII chart
    const chart = [
      '   100┤                                          ╭─●',
      '    90┤                                   ╭──────╯',
      '    80┤                            ╭──────╯',
      '    70┤                     ╭──────╯',
      '    60┤              ╭──────╯',
      '    50┤       ╭──────╯',
      '    40┤●──────╯',
      '      └┬────┬────┬────┬────┬────┬────┬────',
      '       Mon  Tue  Wed  Thu  Fri  Sat  Sun'
    ];

    chart.forEach(line => {
      output += BOX.vertical + '  ' + BOX.vertical + '  ' + line.padEnd(width - 8) + BOX.vertical + ' ' + BOX.vertical + '\n';
    });

    output += BOX.vertical + '  ' + BOX.bottomLeft + BOX.horizontal.repeat(width - 6) + BOX.bottomRight + ' ' + BOX.vertical + '\n';

    return output;
  }

  /**
   * Render alerts
   */
  private renderAlerts(width: number): string {
    let output = BOX.vertical + ' '.repeat(width - 2) + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + BOX.topLeft + BOX.horizontal.repeat(width - 6) + BOX.topRight + ' ' + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + BOX.vertical + '  🎯 Active Alerts' + ' '.repeat(width - 23) + BOX.vertical + ' ' + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + BOX.tee + BOX.horizontal.repeat(width - 6) + BOX.teeRight + ' ' + BOX.vertical + '\n';

    this.alerts.forEach(alert => {
      const icon = alert.severity === 'error' ? '🔴' : alert.severity === 'warning' ? '🟡' : '🟢';
      const line = `${icon} ${alert.message}`;
      // Truncate if too long
      const truncated = line.length > width - 10 ? line.substring(0, width - 13) + '...' : line;
      output += BOX.vertical + '  ' + BOX.vertical + '  ' + truncated.padEnd(width - 8) + BOX.vertical + ' ' + BOX.vertical + '\n';
    });

    output += BOX.vertical + '  ' + BOX.bottomLeft + BOX.horizontal.repeat(width - 6) + BOX.bottomRight + ' ' + BOX.vertical + '\n';

    return output;
  }

  /**
   * Render quick actions
   */
  private renderQuickActions(width: number): string {
    let output = BOX.vertical + ' '.repeat(width - 2) + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + BOX.topLeft + BOX.horizontal.repeat(width - 6) + BOX.topRight + ' ' + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + BOX.vertical + '  Quick Actions' + ' '.repeat(width - 21) + BOX.vertical + ' ' + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + BOX.tee + BOX.horizontal.repeat(width - 6) + BOX.teeRight + ' ' + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + BOX.vertical + '  [r] Run Tests    [b] Build    [l] Lint    [m] Mood Check' + ' '.repeat(width - 67) + BOX.vertical + ' ' + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + BOX.vertical + '  [s] Snapshot     [e] Export   [c] Config  [q] Quit' + ' '.repeat(width - 59) + BOX.vertical + ' ' + BOX.vertical + '\n';
    output += BOX.vertical + '  ' + BOX.bottomLeft + BOX.horizontal.repeat(width - 6) + BOX.bottomRight + ' ' + BOX.vertical + '\n';

    return output;
  }

  /**
   * Render footer
   */
  private renderFooter(width: number): string {
    let output = BOX.vertical + ' '.repeat(width - 2) + BOX.vertical + '\n';
    output += BOX.vertical + "  💡 Tip: Press 'h' for help, 'Tab' to cycle views" + ' '.repeat(width - 55) + BOX.vertical + '\n';
    output += BOX.bottomLeft + BOX.horizontal.repeat(width - 2) + BOX.bottomRight + '\n';

    return output;
  }

  /**
   * Center text in a given width
   */
  private centerText(text: string, width: number): string {
    const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, '');
    const visibleLength = stripAnsi(text).length;
    const padding = Math.max(0, Math.floor((width - visibleLength) / 2));
    return ' '.repeat(padding) + text + ' '.repeat(width - padding - visibleLength);
  }

  /**
   * Get current metrics
   */
  getMetrics(): HealthMetrics | null {
    return this.metrics;
  }

  /**
   * Export snapshot
   */
  async exportSnapshot(filename: string): Promise<void> {
    if (!this.metrics) {
      throw new Error('No metrics available');
    }

    const report = this.generateMarkdownReport();
    const fs = await import('fs/promises');
    await fs.writeFile(filename, report, 'utf-8');
  }

  /**
   * Generate markdown report
   */
  private generateMarkdownReport(): string {
    const m = this.metrics!;
    let report = '# Code Health Dashboard Report\n\n';
    report += `Generated: ${m.timestamp.toLocaleString()}\n\n`;
    report += `## Overall Health Score: ${m.healthScore}/100\n\n`;
    report += '## Core Metrics\n\n';
    report += `- **Total Files:** ${m.totalFiles.toLocaleString()}\n`;
    report += `- **Lines of Code:** ${m.linesOfCode.toLocaleString()}\n`;
    report += `- **Test Coverage:** ${m.testCoverage}%\n`;
    report += `- **Avg Complexity:** ${m.avgComplexity.toFixed(1)}\n`;
    report += `- **Documentation:** ${m.documentation}%\n`;
    report += `- **Known Issues:** ${m.knownIssues}\n`;
    report += `- **Build Time:** ${m.buildTime}s\n\n`;

    if (this.alerts.length > 0) {
      report += '## Alerts\n\n';
      this.alerts.forEach(alert => {
        const icon = alert.severity === 'error' ? '❌' : alert.severity === 'warning' ? '⚠️' : '✅';
        report += `${icon} ${alert.message}\n`;
      });
    }

    return report;
  }
}

// CLI interface
export async function main(args: string[]): Promise<void> {
  const dashboard = new CodeHealthDashboard({
    path: args[0] || '.',
    refreshInterval: 5000
  });

  console.log('🏥 Starting Code Health Dashboard...\n');
  console.log('Press Ctrl+C to exit\n');

  await dashboard.start();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\n👋 Shutting down dashboard...');
    await dashboard.stop();
    process.exit(0);
  });
}

export default CodeHealthDashboard;
