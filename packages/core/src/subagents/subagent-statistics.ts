/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ToolUsageStats {
  name: string;
  count: number;
  success: number;
  failure: number;
  lastError?: string;
  totalDurationMs: number;
  averageDurationMs: number;
}

export interface SubagentStatsSummary {
  rounds: number;
  totalDurationMs: number;
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCost: number;
  toolUsage: ToolUsageStats[];
}

export class SubagentStatistics {
  private startTimeMs = 0;
  private rounds = 0;
  private totalToolCalls = 0;
  private successfulToolCalls = 0;
  private failedToolCalls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private thoughtTokens = 0;
  private cachedTokens = 0;
  private toolUsage = new Map<string, ToolUsageStats>();

  start(now = Date.now()) {
    this.startTimeMs = now;
  }

  setRounds(rounds: number) {
    this.rounds = rounds;
  }

  recordToolCall(
    name: string,
    success: boolean,
    durationMs: number,
    lastError?: string,
  ) {
    this.totalToolCalls += 1;
    if (success) this.successfulToolCalls += 1;
    else this.failedToolCalls += 1;

    const tu = this.toolUsage.get(name) || {
      name,
      count: 0,
      success: 0,
      failure: 0,
      lastError: undefined,
      totalDurationMs: 0,
      averageDurationMs: 0,
    };
    tu.count += 1;
    if (success) tu.success += 1;
    else tu.failure += 1;
    if (lastError) tu.lastError = lastError;
    tu.totalDurationMs += Math.max(0, durationMs || 0);
    tu.averageDurationMs = tu.count > 0 ? tu.totalDurationMs / tu.count : 0;
    this.toolUsage.set(name, tu);
  }

  recordTokens(
    input: number,
    output: number,
    thought: number = 0,
    cached: number = 0,
  ) {
    this.inputTokens += Math.max(0, input || 0);
    this.outputTokens += Math.max(0, output || 0);
    this.thoughtTokens += Math.max(0, thought || 0);
    this.cachedTokens += Math.max(0, cached || 0);
  }

  getSummary(now = Date.now()): SubagentStatsSummary {
    const totalDurationMs = this.startTimeMs ? now - this.startTimeMs : 0;
    const totalToolCalls = this.totalToolCalls;
    const successRate =
      totalToolCalls > 0
        ? (this.successfulToolCalls / totalToolCalls) * 100
        : 0;
    const totalTokens =
      this.inputTokens +
      this.outputTokens +
      this.thoughtTokens +
      this.cachedTokens;
    const estimatedCost = this.inputTokens * 3e-5 + this.outputTokens * 6e-5;
    return {
      rounds: this.rounds,
      totalDurationMs,
      totalToolCalls,
      successfulToolCalls: this.successfulToolCalls,
      failedToolCalls: this.failedToolCalls,
      successRate,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      thoughtTokens: this.thoughtTokens,
      cachedTokens: this.cachedTokens,
      totalTokens,
      estimatedCost,
      toolUsage: Array.from(this.toolUsage.values()),
    };
  }

  formatCompact(taskDesc: string, now = Date.now()): string {
    const stats = this.getSummary(now);
    const sr =
      stats.totalToolCalls > 0
        ? (stats.successRate ??
          (stats.successfulToolCalls / stats.totalToolCalls) * 100)
        : 0;
    const lines = [
      `📋 Task Completed: ${taskDesc}`,
      `🔧 Tool Usage: ${stats.totalToolCalls} calls${stats.totalToolCalls ? `, ${sr.toFixed(1)}% success` : ''}`,
      `⏱️ Duration: ${this.fmtDuration(stats.totalDurationMs)} | 🔁 Rounds: ${stats.rounds}`,
    ];
    if (typeof stats.totalTokens === 'number') {
      const parts = [
        `in ${stats.inputTokens ?? 0}`,
        `out ${stats.outputTokens ?? 0}`,
      ];
      lines.push(
        `🔢 Tokens: ${stats.totalTokens.toLocaleString()}${parts.length ? ` (${parts.join(', ')})` : ''}`,
      );
    }
    return lines.join('\n');
  }

  formatDetailed(taskDesc: string, now = Date.now()): string {
    const stats = this.getSummary(now);
    const sr =
      stats.totalToolCalls > 0
        ? (stats.successRate ??
          (stats.successfulToolCalls / stats.totalToolCalls) * 100)
        : 0;
    const lines: string[] = [];
    lines.push(`📋 Task Completed: ${taskDesc}`);
    lines.push(
      `⏱️ Duration: ${this.fmtDuration(stats.totalDurationMs)} | 🔁 Rounds: ${stats.rounds}`,
    );
    // Quality indicator
    let quality = 'Poor execution';
    if (sr >= 95) quality = 'Excellent execution';
    else if (sr >= 85) quality = 'Good execution';
    else if (sr >= 70) quality = 'Fair execution';
    lines.push(`✅ Quality: ${quality} (${sr.toFixed(1)}% tool success)`);
    // Speed category
    const d = stats.totalDurationMs;
    let speed = 'Long execution - consider breaking down tasks';
    if (d < 10_000) speed = 'Fast completion - under 10 seconds';
    else if (d < 60_000) speed = 'Good speed - under a minute';
    else if (d < 300_000) speed = 'Moderate duration - a few minutes';
    lines.push(`🚀 Speed: ${speed}`);
    lines.push(
      `🔧 Tools: ${stats.totalToolCalls} calls, ${sr.toFixed(1)}% success (${stats.successfulToolCalls} ok, ${stats.failedToolCalls} failed)`,
    );
    if (typeof stats.totalTokens === 'number') {
      const parts = [
        `in ${stats.inputTokens ?? 0}`,
        `out ${stats.outputTokens ?? 0}`,
      ];
      lines.push(
        `🔢 Tokens: ${stats.totalTokens.toLocaleString()} (${parts.join(', ')})`,
      );
    }
    if (stats.toolUsage && stats.toolUsage.length) {
      const sorted = [...stats.toolUsage]
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      lines.push('\nTop tools:');
      for (const t of sorted) {
        const avg =
          typeof t.averageDurationMs === 'number'
            ? `, avg ${this.fmtDuration(Math.round(t.averageDurationMs))}`
            : '';
        lines.push(
          ` - ${t.name}: ${t.count} calls (${t.success} ok, ${t.failure} fail${avg}${t.lastError ? `, last error: ${t.lastError}` : ''})`,
        );
      }
    }
    const tips = this.generatePerformanceTips(stats);
    if (tips.length) {
      lines.push('\n💡 Performance Insights:');
      for (const tip of tips.slice(0, 3)) lines.push(` - ${tip}`);
    }
    return lines.join('\n');
  }

  private fmtDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) {
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      return `${m}m ${s}s`;
    }
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  }

  private generatePerformanceTips(stats: SubagentStatsSummary): string[] {
    const tips: string[] = [];
    const totalCalls = stats.totalToolCalls;
    const sr =
      stats.totalToolCalls > 0
        ? (stats.successRate ??
          (stats.successfulToolCalls / stats.totalToolCalls) * 100)
        : 0;

    // High failure rate
    if (sr < 80)
      tips.push('Low tool success rate - review inputs and error messages');

    // Long duration
    if (stats.totalDurationMs > 60_000)
      tips.push('Long execution time - consider breaking down complex tasks');

    // Token usage
    if (typeof stats.totalTokens === 'number' && stats.totalTokens > 100_000) {
      tips.push(
        'High token usage - consider optimizing prompts or narrowing scope',
      );
    }
    if (typeof stats.totalTokens === 'number' && totalCalls > 0) {
      const avgTokPerCall = stats.totalTokens / totalCalls;
      if (avgTokPerCall > 5_000)
        tips.push(
          `High token usage per tool call (~${Math.round(avgTokPerCall)} tokens/call)`,
        );
    }

    // Network failures
    const isNetworkTool = (name: string) => /web|fetch|search/i.test(name);
    const hadNetworkFailure = (stats.toolUsage || []).some(
      (t) =>
        isNetworkTool(t.name) &&
        t.lastError &&
        /timeout|network/i.test(t.lastError),
    );
    if (hadNetworkFailure)
      tips.push(
        'Network operations had failures - consider increasing timeout or checking connectivity',
      );

    // Slow tools
    const slow = (stats.toolUsage || [])
      .filter((t) => (t.averageDurationMs ?? 0) > 10_000)
      .sort((a, b) => (b.averageDurationMs ?? 0) - (a.averageDurationMs ?? 0));
    if (slow.length)
      tips.push(
        `Consider optimizing ${slow[0].name} operations (avg ${this.fmtDuration(Math.round(slow[0].averageDurationMs!))})`,
      );

    return tips;
  }
}
