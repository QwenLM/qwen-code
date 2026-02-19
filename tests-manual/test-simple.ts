#!/usr/bin/env tsx
/**
 * Teste simples - apenas verifica imports
 */

console.log('🧪 Teste Simples de Imports...\n');

async function testImports() {
  const tests = [
    {
      name: 'Knowledge Graph',
      path: '../packages/core/src/intelligence/codebase-graph.js',
      export: 'createCodebaseAnalyzer',
    },
    {
      name: 'Project Memory',
      path: '../packages/core/src/intelligence/project-memory.js',
      export: 'createMemoryManager',
    },
    {
      name: 'Code Intelligence',
      path: '../packages/core/src/intelligence/code-analysis.js',
      export: 'createCodeIntelligence',
    },
    {
      name: 'Semantic Search',
      path: '../packages/core/src/intelligence/semantic-search.js',
      export: 'createSemanticSearchEngine',
    },
    {
      name: 'Plan Mode',
      path: '../packages/core/src/planning/plan-mode.js',
      export: 'createPlanningEngine',
    },
    {
      name: 'Task Decomposer',
      path: '../packages/core/src/planning/task-decomposition.js',
      export: 'createTaskDecomposer',
    },
    {
      name: 'Test Workflow',
      path: '../packages/core/src/robustness/test-workflow.js',
      export: 'createTestDrivenWorkflow',
    },
    {
      name: 'Versioning',
      path: '../packages/core/src/robustness/versioning.js',
      export: 'createVersioningSystem',
    },
    {
      name: 'Quality Monitor',
      path: '../packages/core/src/robustness/quality-monitoring.js',
      export: 'createQualityMonitor',
    },
    {
      name: 'Self-Correction',
      path: '../packages/core/src/autonomy/self-correction.js',
      export: 'createSelfCorrectionEngine',
    },
    {
      name: 'Collaboration',
      path: '../packages/core/src/agents/collaboration.js',
      export: 'createCollaborationEngine',
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const module = await import(test.path);
      if (typeof module[test.export] === 'function') {
        console.log(`✅ ${test.name}`);
        passed++;
      } else {
        console.log(`❌ ${test.name} - Export não encontrado`);
        failed++;
      }
    } catch (error) {
      console.log(`❌ ${test.name} - Erro: ${error}`);
      failed++;
    }
  }

  console.log(`\n📊 Resultado: ${passed} passou, ${failed} falhou`);
  console.log(
    failed === 0 ? '🎉 Todos os módulos OK!' : '⚠️  Alguns módulos falharam',
  );

  return failed === 0;
}

testImports()
  .then((success) => process.exit(success ? 0 : 1))
  .catch((error) => {
    console.error('❌ Erro fatal:', error);
    process.exit(1);
  });
