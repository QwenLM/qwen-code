# Quick Start: Advanced Features (Phase 1 & 2)

Get started with the new intelligence, planning, robustness, and autonomy features in 5 minutes.

## 🚀 Quick Install

The new features are already included in `@qwen-code/qwen-code-core`. No additional dependencies needed!

```bash
npm install @qwen-code/qwen-code-core
```

## 📚 Basic Usage

### 1. Analyze Your Codebase (30 seconds)

```typescript
import { createCodebaseAnalyzer } from '@qwen-code/qwen-code-core/intelligence';

const analyzer = createCodebaseAnalyzer();
const graph = await analyzer.buildGraph(process.cwd());

console.log('Architecture:', graph.metadata.architecture);
console.log('Languages:', graph.metadata.techStack.languages.join(', '));
console.log('Files:', graph.nodes.size);
```

**Output:**

```
Architecture: modular
Languages: TypeScript, JavaScript
Files: 247
```

### 2. Check Code Quality (30 seconds)

```typescript
import { createCodeIntelligence } from '@qwen-code/qwen-code-core/intelligence';

const intelligence = createCodeIntelligence();

// Analyze quality
const quality = await intelligence.analyzeQuality(['src/index.ts']);
console.log('Grade:', quality.summary.grade);
console.log('Maintainability:', quality.overall.maintainability);

// Scan security
const security = await intelligence.scanSecurity(['src/index.ts']);
console.log('Security Score:', security.score);
console.log('Vulnerabilities:', security.vulnerabilities.length);
```

**Output:**

```
Grade: B
Maintainability: 72.5
Security Score: 95
Vulnerabilities: 0
```

### 3. Plan a Task (1 minute)

```typescript
import { createPlanningEngine } from '@qwen-code/qwen-code-core/planning';

const planner = createPlanningEngine();
const plan = await planner.createPlan('Add authentication with JWT', {
  codebaseGraph: graph,
  projectMemory: memory.getMemory(),
  workingDirectory: process.cwd(),
});

console.log('Steps:', plan.steps.length);
console.log('Complexity:', plan.estimatedComplexity);

// Print plan
plan.steps.forEach((step, i) => {
  console.log(`${i + 1}. ${step.description}`);
});
```

**Output:**

```
Steps: 6
Complexity: medium
1. Analyze codebase and identify relevant files
2. Design changes and identify dependencies
3. Create backup of affected files
4. Implement changes
5. Run tests to verify changes
6. Review all changes for quality and correctness
```

### 4. Test-Driven Changes (1 minute)

```typescript
import { createTestDrivenWorkflow } from '@qwen-code/qwen-code-core/robustness';

const workflow = createTestDrivenWorkflow(process.cwd());

// Before changes
const baseline = await workflow.beforeCodeChange(['src/auth.ts']);
console.log('Tests before:', baseline.testResults.passed);

// Make your changes...

// After changes
const result = await workflow.afterCodeChange(['src/auth.ts'], baseline);
console.log('Tests after:', result.passed);
console.log('Regressions:', result.failed);
```

**Output:**

```
Tests before: 42
Tests after: 43
Regressions: 0
```

### 5. Self-Correction (1 minute)

```typescript
import { createSelfCorrectionEngine } from '@qwen-code/qwen-code-core/autonomy';

const corrector = createSelfCorrectionEngine();

// Validate code
const validation = await corrector.validateOutput(generatedCode, [
  { type: 'syntax' },
  { type: 'semantic' },
]);

if (!validation.valid) {
  // Get corrections
  const corrections = await corrector.correctErrors(validation.errors, context);

  console.log('Corrections:', corrections.length);
  corrections.forEach((c) => {
    console.log(`- ${c.description} (${c.confidence * 100}% confident)`);
  });
}
```

**Output:**

```
Corrections: 2
- Fix mismatched braces (90% confident)
- Add missing import (85% confident)
```

### 6. Project Memory (1 minute)

```typescript
import { createMemoryManager } from '@qwen-code/qwen-code-core/intelligence';

const memory = createMemoryManager(process.cwd());
await memory.load();

// Get learned conventions
const conventions = memory.getConventions('naming');
console.log('Naming conventions:', conventions.length);

// Get performance trends
const trends = memory.getPerformanceTrends();
console.log('Build time:', trends.buildTime.trend);

// Get suggestions
const suggestions = await memory.suggestImprovements();
suggestions.forEach((s) => {
  console.log(`${s.priority}: ${s.title}`);
});
```

**Output:**

```
Naming conventions: 5
Build time: stable
high: Add tests for frequently modified files
medium: Refactor 3 long method(s) into smaller functions
```

## 🎯 Common Workflows

### Workflow 1: Safe Code Changes

```typescript
// 1. Analyze impact
const impact = await analyzer.getImpactAnalysis(['src/critical.ts']);
if (impact.riskLevel === 'high') {
  console.warn('⚠️  High-risk change!');
}

// 2. Capture baseline
const baseline = await workflow.beforeCodeChange(['src/critical.ts']);

// 3. Make changes
// ... your code changes ...

// 4. Validate
const testResult = await workflow.afterCodeChange(
  ['src/critical.ts'],
  baseline,
);

// 5. Check quality
const quality = await intelligence.analyzeQuality(['src/critical.ts']);

if (testResult.failed === 0 && quality.summary.grade !== 'F') {
  console.log('✅ Changes safe to commit');
} else {
  console.log('❌ Issues found, review needed');
}
```

### Workflow 2: Proactive Security Audit

```typescript
// Get all source files
const files = Array.from(graph.nodes.values())
  .filter((n) => n.type === 'file')
  .map((n) => n.path);

// Scan for vulnerabilities
const security = await intelligence.scanSecurity(files);

// Show critical issues
const critical = security.vulnerabilities.filter(
  (v) => v.severity === 'critical',
);
console.log(`🔒 Found ${critical.length} critical vulnerabilities:`);

critical.forEach((vuln) => {
  console.log(`  ${vuln.type} in ${vuln.location.file}:${vuln.location.line}`);
  console.log(`  → ${vuln.remediation}`);
});
```

### Workflow 3: Automated Refactoring

```typescript
// 1. Create plan
const plan = await planner.createPlan('Refactor user module', context);

// 2. Execute with self-correction
const result = await planner.executePlanWithFeedback(plan, async (step) => {
  const output = await executeStep(step);

  // Validate
  const validation = await corrector.validateOutput(output, step.validation);

  if (!validation.valid) {
    // Auto-correct
    const corrections = await corrector.correctErrors(
      validation.errors,
      context,
    );

    if (corrections[0]) {
      await applyCorrection(corrections[0]);
      return true;
    }
    return false;
  }

  return true;
});

console.log(
  result.success ? '✅ Refactoring complete' : '❌ Refactoring failed',
);
```

## 💡 Pro Tips

### Tip 1: Cache the Knowledge Graph

```typescript
// Build once, reuse many times
const graph = await analyzer.buildGraph(projectRoot);

// Use for multiple analyses
const impact1 = await analyzer.getImpactAnalysis(['file1.ts']);
const impact2 = await analyzer.getImpactAnalysis(['file2.ts']);
const dependencies = analyzer.getDependencies('file1.ts');
```

### Tip 2: Load Memory at Startup

```typescript
// Load memory once at app start
const memory = createMemoryManager(projectRoot);
await memory.load();

// Use throughout session
const conventions = memory.getConventions();
const suggestions = await memory.suggestImprovements();
```

### Tip 3: Batch Analysis

```typescript
// Analyze multiple aspects at once
const [quality, security, perf] = await Promise.all([
  intelligence.analyzeQuality(files),
  intelligence.scanSecurity(files),
  intelligence.profilePerformance(files),
]);
```

### Tip 4: Learning from Sessions

```typescript
// Always record sessions for learning
await memory.learnFromInteraction({
  id: Date.now().toString(),
  timestamp: new Date(),
  task: 'Refactor authentication',
  filesModified: ['src/auth.ts'],
  commandsExecuted: ['analyze', 'plan', 'execute', 'test'],
  success: true,
  duration: 120000,
});

// Save at the end
await memory.save();
```

### Tip 5: Progressive Validation

```typescript
// Start with fast validations
const fastValidation = await corrector.validateOutput(code, [
  { type: 'syntax' },
  { type: 'semantic' },
]);

if (fastValidation.valid) {
  // Then run slower ones
  const fullValidation = await corrector.validateOutput(code, [
    { type: 'tests', command: 'npm test' },
    { type: 'build', command: 'npm run build' },
  ]);
}
```

## 🎨 Integration Examples

### With Express API

```typescript
app.post('/api/analyze', async (req, res) => {
  const { files } = req.body;

  const intelligence = createCodeIntelligence();
  const quality = await intelligence.analyzeQuality(files);

  res.json({
    grade: quality.summary.grade,
    maintainability: quality.overall.maintainability,
    recommendations: quality.summary.recommendations,
  });
});
```

### With CLI Tool

```typescript
import { Command } from 'commander';

const program = new Command();

program
  .command('analyze <files...>')
  .description('Analyze code quality')
  .action(async (files) => {
    const intelligence = createCodeIntelligence();
    const quality = await intelligence.analyzeQuality(files);

    console.log(`Grade: ${quality.summary.grade}`);
    console.log(`Maintainability: ${quality.overall.maintainability}`);
  });

program.parse();
```

### With VS Code Extension

```typescript
vscode.commands.registerCommand('qwen.analyzeFile', async () => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const file = editor.document.uri.fsPath;
  const intelligence = createCodeIntelligence();

  const quality = await intelligence.analyzeQuality([file]);

  vscode.window.showInformationMessage(
    `Quality: ${quality.summary.grade} | Maintainability: ${quality.overall.maintainability}`,
  );
});
```

## 📖 More Resources

- **Full Documentation**: See `IMPLEMENTATION_PHASE_1_2.md`
- **Complete Example**: See `examples/advanced-workflow.ts`
- **API Reference**: TypeScript types in each module
- **Architecture**: See `IMPLEMENTATION_SUMMARY.md`

## 🆘 Troubleshooting

### Issue: "Cannot find module"

```typescript
// ❌ Wrong
import { createCodebaseAnalyzer } from '@qwen-code/qwen-code-core';

// ✅ Correct
import { createCodebaseAnalyzer } from '@qwen-code/qwen-code-core/intelligence';
```

### Issue: "Memory file not found"

```typescript
// Memory is opt-in, handle gracefully
try {
  await memory.load();
} catch (error) {
  console.log('No memory file found, starting fresh');
}
```

### Issue: "Analysis takes too long"

```typescript
// Analyze fewer files at once
const batchSize = 10;
for (let i = 0; i < files.length; i += batchSize) {
  const batch = files.slice(i, i + batchSize);
  await intelligence.analyzeQuality(batch);
}
```

## 🎉 You're Ready!

You now know how to use all Phase 1 & 2 features. Start with the simple examples above and gradually explore more advanced workflows.

**Happy coding with enhanced intelligence! 🚀**
