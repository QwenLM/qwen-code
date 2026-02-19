#!/usr/bin/env tsx
/**
 * Teste do Quality Monitoring Dashboard
 */

import { createQualityMonitor } from '../packages/core/src/robustness/quality-monitoring.js';

async function test() {
  console.log('🧪 Testando Quality Monitoring Dashboard...\n');

  const monitor = createQualityMonitor({
    refreshInterval: 60,
    showTrends: true,
    thresholds: {
      minQualityScore: 70,
      maxComplexity: 10,
      minCoverage: 80,
      maxBuildTime: 60000,
      maxTechnicalDebt: 40,
    },
  });

  // Coletar métricas do projeto atual
  console.log('📊 Coletando métricas do projeto...');
  const metrics = await monitor.collectMetrics(process.cwd());

  console.log(`✅ Score geral: ${metrics.overallScore.toFixed(1)}/100`);
  console.log(
    `✅ Qualidade: ${metrics.codeQuality.maintainability.toFixed(1)}/100`,
  );
  console.log(
    `✅ Segurança: ${metrics.security.score.toFixed(1)}/100 (${metrics.security.vulnerabilities.length} vulnerabilidades)`,
  );
  console.log(`✅ Performance: ${metrics.performance.score.toFixed(1)}/100`);
  console.log(`✅ Coverage: ${metrics.coverage.overall.toFixed(1)}%\n`);

  // Criar snapshot do dashboard
  console.log('📈 Criando snapshot do dashboard...');
  const snapshot = await monitor.createSnapshot(process.cwd());

  console.log(`✅ Total de issues: ${snapshot.summary.totalIssues}`);
  console.log(`✅ Issues críticos: ${snapshot.summary.criticalIssues}`);
  console.log(`✅ Alertas ativos: ${snapshot.summary.openAlerts}\n`);

  // Mostrar dashboard formatado
  console.log('🎨 Dashboard Visual:\n');
  const dashboard = monitor.formatDashboard(snapshot);
  console.log(dashboard);

  // Mostrar alertas (se houver)
  if (snapshot.alerts.length > 0) {
    console.log('\n⚠️  Alertas Ativos:');
    for (const alert of snapshot.alerts.slice(0, 3)) {
      const emoji =
        alert.severity === 'critical'
          ? '🔴'
          : alert.severity === 'error'
            ? '🟠'
            : '🟡';
      console.log(`   ${emoji} [${alert.category}] ${alert.title}`);
      console.log(`      ${alert.message}`);
      if (alert.recommendation) {
        console.log(`      💡 ${alert.recommendation}`);
      }
    }
  }

  // Mostrar tendências (se houver)
  if (snapshot.trends.length > 0) {
    console.log('\n📊 Tendências Detectadas:');
    for (const trend of snapshot.trends) {
      const arrow =
        trend.direction === 'improving'
          ? '📈'
          : trend.direction === 'degrading'
            ? '📉'
            : '➡️';
      console.log(
        `   ${arrow} ${trend.metric}: ${trend.direction} (${trend.changeRate.toFixed(2)}/dia, confiança: ${(trend.confidence * 100).toFixed(0)}%)`,
      );
    }
  }

  // Mostrar regressões (se houver)
  if (snapshot.regressions.length > 0) {
    console.log('\n⚠️  Regressões Detectadas:');
    for (const regression of snapshot.regressions) {
      const emoji =
        regression.severity === 'critical'
          ? '🔴'
          : regression.severity === 'error'
            ? '🟠'
            : '🟡';
      console.log(
        `   ${emoji} ${regression.metric}: ${regression.previousValue.toFixed(1)} → ${regression.currentValue.toFixed(1)} (${regression.changePercent > 0 ? '+' : ''}${regression.changePercent.toFixed(1)}%)`,
      );
      console.log(`      ${regression.description}`);
    }
  }

  console.log('\n✨ Quality Monitoring Dashboard funcionando perfeitamente!\n');
}

test().catch((error) => {
  console.error('❌ Erro:', error);
  process.exit(1);
});
