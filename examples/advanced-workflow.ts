/**
 * Copyright (c) 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Example: Advanced workflow using Phase 1 & 2 features
 *
 * This example demonstrates how to use the new intelligence, planning,
 * robustness, and autonomy features together in a complete workflow.
 */

import {
  createCodebaseAnalyzer,
  createMemoryManager,
  createCodeIntelligence,
  createTestDrivenWorkflow,
  createPlanningEngine,
  createSelfCorrectionEngine,
} from '@qwen-code/qwen-code-core';

/**
 * Complete workflow: Analyze -> Plan -> Execute -> Validate -> Learn
 */
async function enhancedCodeChangeWorkflow(
  projectRoot: string,
  task: string,
  filesToModify: string[],
) {
  console.log('🚀 Starting enhanced workflow...\n');

  // ============================================
  // STEP 1: Analyze Codebase
  // ============================================
  console.log('📊 Step 1: Analyzing codebase...');

  const analyzer = createCodebaseAnalyzer();
  const graph = await analyzer.buildGraph(projectRoot);

  console.log(`  ✓ Architecture: ${graph.metadata.architecture}`);
  console.log(
    `  ✓ Languages: ${graph.metadata.techStack.languages.join(', ')}`,
  );
  console.log(`  ✓ Files analyzed: ${graph.nodes.size}`);

  // Get impact analysis
  const impact = await analyzer.getImpactAnalysis(filesToModify);
  console.log(`  ✓ Impact: ${impact.riskLevel} risk`);
  console.log(`  ✓ Affected files: ${impact.affectedFiles.length}`);

  if (impact.riskLevel === 'high' || impact.riskLevel === 'critical') {
    console.log('  ⚠️  High-risk change detected!');
    console.log(`     ${impact.recommendations.join('\n     ')}`);
  }

  // ============================================
  // STEP 2: Load Project Memory
  // ============================================
  console.log('\n🧠 Step 2: Loading project memory...');

  const memory = createMemoryManager(projectRoot);
  await memory.load();

  const conventions = memory.getConventions();
  const decisions = memory.getDecisions('accepted');
  const trends = memory.getPerformanceTrends();

  console.log(`  ✓ Learned conventions: ${conventions.length}`);
  console.log(`  ✓ Architecture decisions: ${decisions.length}`);
  console.log(`  ✓ Build time trend: ${trends.buildTime.trend}`);

  // ============================================
  // STEP 3: Check Current Code Quality
  // ============================================
  console.log('\n🔍 Step 3: Analyzing current code quality...');

  const intelligence = createCodeIntelligence();

  // Quality analysis
  const qualityReport = await intelligence.analyzeQuality(filesToModify);
  console.log(`  ✓ Quality Grade: ${qualityReport.summary.grade}`);
  console.log(
    `  ✓ Maintainability: ${qualityReport.overall.maintainability.toFixed(1)}`,
  );
  console.log(`  ✓ Code Smells: ${qualityReport.overall.codeSmells.length}`);

  // Security analysis
  const securityReport = await intelligence.scanSecurity(filesToModify);
  console.log(`  ✓ Security Score: ${securityReport.score}`);
  console.log(
    `  ✓ Vulnerabilities: ${securityReport.vulnerabilities.length} (${securityReport.summary.criticalCount} critical)`,
  );

  if (securityReport.vulnerabilities.length > 0) {
    console.log('  ⚠️  Security issues found:');
    securityReport.vulnerabilities.slice(0, 3).forEach((vuln) => {
      console.log(
        `     - ${vuln.type} (${vuln.severity}): ${vuln.description}`,
      );
    });
  }

  // Performance analysis
  const perfReport = await intelligence.profilePerformance(filesToModify);
  console.log(`  ✓ Performance Bottlenecks: ${perfReport.bottlenecks.length}`);
  console.log(`  ✓ I/O Operations: ${perfReport.metrics.ioOperations}`);

  // ============================================
  // STEP 4: Create Execution Plan
  // ============================================
  console.log('\n📋 Step 4: Creating execution plan...');

  const planner = createPlanningEngine();
  const plan = await planner.createPlan(task, {
    codebaseGraph: graph,
    projectMemory: memory.getMemory(),
    workingDirectory: projectRoot,
  });

  console.log(`  ✓ Complexity: ${plan.estimatedComplexity}`);
  console.log(`  ✓ Steps: ${plan.steps.length}`);
  console.log(`  ✓ Approvals needed: ${plan.requiredApprovals.length}`);
  console.log(`  ✓ Rollback strategy: ${plan.rollbackStrategy.length} steps`);

  console.log('\n  Plan steps:');
  plan.steps.forEach((step, idx) => {
    console.log(`    ${idx + 1}. ${step.description}`);
    console.log(`       Risk: ${step.estimatedImpact.riskLevel}`);
    console.log(`       Tools: ${step.tools.join(', ')}`);
  });

  // ============================================
  // STEP 5: Capture Test Baseline
  // ============================================
  console.log('\n🧪 Step 5: Capturing test baseline...');

  const testWorkflow = createTestDrivenWorkflow(projectRoot);
  const baseline = await testWorkflow.beforeCodeChange(filesToModify);

  console.log(`  ✓ Related tests: ${baseline.relatedTests.length}`);
  console.log(`  ✓ Tests passing: ${baseline.testResults.passed}`);
  console.log(
    `  ✓ Coverage: ${baseline.coverage.overall.lines.percentage.toFixed(1)}%`,
  );

  // ============================================
  // STEP 6: Execute Plan with Self-Correction
  // ============================================
  console.log('\n⚙️  Step 6: Executing plan with self-correction...');

  const corrector = createSelfCorrectionEngine((maxAttempts = 3));
  await corrector.loadLearning();

  const startTime = Date.now();
  const executionResult = await planner.executePlanWithFeedback(
    plan,
    async (step) => {
      console.log(`\n  Executing: ${step.description}...`);

      try {
        // Simulate step execution
        // In real implementation, this would use actual tools (Edit, Write, Bash, etc.)
        const output = await simulateStepExecution(step);

        // Validate output
        const validation = await corrector.validateOutput(
          output,
          step.validation,
        );

        if (!validation.valid) {
          console.log('  ❌ Validation failed!');

          // Try to auto-correct
          const corrections = await corrector.correctErrors(validation.errors, {
            task,
            files: filesToModify,
            previousAttempts: 0,
            maxAttempts: 3,
            originalIntent: task,
          });

          if (corrections.length > 0) {
            console.log(
              `  🔧 Applying correction: ${corrections[0].description}`,
            );
            console.log(
              `     Confidence: ${(corrections[0].confidence * 100).toFixed(1)}%`,
            );

            // Apply correction
            await simulateCorrection();

            // Learn from this
            await corrector.learnFromMistake(
              {
                type: 'logic',
                error: validation.errors[0].message,
                context: {
                  task,
                  files: filesToModify,
                  previousAttempts: 0,
                  maxAttempts: 3,
                  originalIntent: task,
                },
                timestamp: new Date(),
              },
              corrections[0],
            );

            console.log('  ✓ Correction applied successfully');
            return true;
          }

          console.log('  ❌ No corrections available');
          return false;
        }

        console.log('  ✓ Step completed successfully');
        return true;
      } catch (error) {
        console.log(
          `  ❌ Error: ${error instanceof Error ? error.message : error}`,
        );

        // Learn from failure
        await corrector.learnFromMistake({
          type: 'runtime',
          error: error instanceof Error ? error : new Error(String(error)),
          context: {
            task,
            files: filesToModify,
            previousAttempts: 0,
            maxAttempts: 3,
            originalIntent: task,
          },
          timestamp: new Date(),
        });

        return false;
      }
    },
  );

  const duration = Date.now() - startTime;

  // ============================================
  // STEP 7: Validate Results
  // ============================================
  console.log('\n✅ Step 7: Validating results...');

  if (executionResult.success) {
    console.log('  ✓ All steps completed successfully!');

    // Run tests
    const testResults = await testWorkflow.afterCodeChange(
      filesToModify,
      baseline,
    );

    console.log(
      `  ✓ Tests: ${testResults.passed} passed, ${testResults.failed} failed`,
    );

    if (testResults.failed > 0) {
      console.log('  ⚠️  Some tests failed!');
      testResults.failures.forEach((failure) => {
        console.log(`     - ${failure.testName}: ${failure.error}`);
      });
    }

    // Check quality improvements
    const qualityAfter = await intelligence.analyzeQuality(filesToModify);
    const qualityDelta =
      qualityAfter.overall.maintainability -
      qualityReport.overall.maintainability;

    console.log(
      `  ✓ Maintainability change: ${qualityDelta > 0 ? '+' : ''}${qualityDelta.toFixed(1)}`,
    );

    // Check security improvements
    const securityAfter = await intelligence.scanSecurity(filesToModify);
    const securityDelta = securityAfter.score - securityReport.score;

    console.log(
      `  ✓ Security score change: ${securityDelta > 0 ? '+' : ''}${securityDelta.toFixed(1)}`,
    );
  } else {
    console.log('  ❌ Execution failed!');
    console.log(`     Failed at: ${executionResult.failedStep?.description}`);
    console.log(`     Error: ${executionResult.error}`);

    // Suggest rollback
    console.log('\n  🔄 Rollback available');
    console.log(`     ${plan.rollbackStrategy.length} rollback steps prepared`);
  }

  // ============================================
  // STEP 8: Learn from Interaction
  // ============================================
  console.log('\n🎓 Step 8: Learning from interaction...');

  await memory.learnFromInteraction({
    id: Date.now().toString(),
    timestamp: new Date(),
    task,
    filesModified: filesToModify,
    commandsExecuted: plan.steps.map((s) => s.description),
    success: executionResult.success,
    duration,
  });

  // Record performance baseline
  await memory.recordPerformanceBaseline({
    buildTime: duration,
    testTime: 0,
    bundleSize: 0,
    startupTime: 0,
    memoryUsage: 0,
    timestamp: new Date(),
  });

  const suggestions = await memory.suggestImprovements();
  console.log(`  ✓ Memory updated`);
  console.log(`  ✓ New suggestions: ${suggestions.length}`);

  // Get learning stats
  const learningStats = corrector.getLearningStats();
  console.log(
    `  ✓ Correction patterns learned: ${learningStats.totalPatterns}`,
  );
  console.log(
    `  ✓ Auto-correction success rate: ${(learningStats.successRate * 100).toFixed(1)}%`,
  );

  // ============================================
  // Summary
  // ============================================
  console.log('\n' + '='.repeat(60));
  console.log('📊 WORKFLOW SUMMARY');
  console.log('='.repeat(60));
  console.log(
    `Status: ${executionResult.success ? '✅ Success' : '❌ Failed'}`,
  );
  console.log(`Duration: ${(duration / 1000).toFixed(2)}s`);
  console.log(
    `Steps completed: ${executionResult.completedSteps}/${plan.steps.length}`,
  );
  console.log(`Risk level: ${impact.riskLevel}`);
  console.log(`Quality grade: ${qualityReport.summary.grade}`);
  console.log(`Security score: ${securityReport.score}/100`);
  console.log('='.repeat(60) + '\n');

  return {
    success: executionResult.success,
    duration,
    qualityReport,
    securityReport,
    perfReport,
    testResults: executionResult,
  };
}

/**
 * Simulate step execution (placeholder)
 */
async function simulateStepExecution(step: unknown): Promise<string> {
  // In real implementation, this would use actual qwen-code tools
  await new Promise((resolve) => setTimeout(resolve, 100));
  return `Executed: ${(step as { description: string }).description}`;
}

/**
 * Simulate correction (placeholder)
 */
async function simulateCorrection(): Promise<void> {
  // In real implementation, this would apply the correction
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Example usage
 */
async function main() {
  const projectRoot = process.cwd();
  const task = 'Refactor authentication to use JWT tokens';
  const filesToModify = ['src/auth/authentication.ts', 'src/auth/tokens.ts'];

  try {
    const result = await enhancedCodeChangeWorkflow(
      projectRoot,
      task,
      filesToModify,
    );

    if (result.success) {
      console.log('✨ Workflow completed successfully!');
      process.exit(0);
    } else {
      console.log('❌ Workflow failed');
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { enhancedCodeChangeWorkflow };
