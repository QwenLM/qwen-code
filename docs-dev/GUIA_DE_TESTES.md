# Guia de Testes - Funcionalidades Implementadas

## 🧪 Como Testar as Novas Funcionalidades

Este guia mostra como testar todas as funcionalidades implementadas nas Phases 1-4.

---

## 🚀 Setup Inicial

### 1. Instalar Dependências

```bash
cd /Users/davipeterlini/projects-personal/qwen-code
npm install
```

### 2. Compilar TypeScript

```bash
# Compilar o pacote core
cd packages/core
npm run build

# Ou compilar tudo
cd ../..
npm run build
```

---

## 📋 Testes por Módulo

### TESTE 1: Knowledge Graph System

**Arquivo**: `packages/core/src/intelligence/codebase-graph.ts`

**Script de Teste**:

```bash
# Criar arquivo de teste
cat > test-knowledge-graph.ts << 'EOF'
import { createCodebaseAnalyzer } from './packages/core/src/intelligence/codebase-graph.js';

async function test() {
  console.log('🧪 Testando Knowledge Graph System...\n');

  const analyzer = createCodebaseAnalyzer();

  // Construir grafo do projeto atual
  console.log('📊 Construindo grafo do codebase...');
  const graph = await analyzer.buildGraph(process.cwd());

  console.log(`✅ Arquivos analisados: ${graph.nodes.size}`);
  console.log(`✅ Arquitetura detectada: ${graph.metadata.architecture}`);
  console.log(`✅ Linguagens: ${graph.metadata.techStack.languages.join(', ')}`);
  console.log(`✅ Frameworks: ${graph.metadata.techStack.frameworks.join(', ')}\n`);

  // Testar análise de impacto
  if (graph.nodes.size > 0) {
    const firstFile = Array.from(graph.nodes.keys())[0];
    console.log(`📈 Analisando impacto de mudanças em: ${firstFile}`);

    const impact = await analyzer.getImpactAnalysis([firstFile]);
    console.log(`✅ Nível de risco: ${impact.riskLevel}`);
    console.log(`✅ Arquivos afetados: ${impact.affectedFiles.length}`);
    console.log(`✅ Linhas de código afetadas: ${impact.estimatedScope.linesOfCode}\n`);
  }

  console.log('✨ Knowledge Graph System funcionando!\n');
}

test().catch(console.error);
EOF

# Executar teste
npx tsx test-knowledge-graph.ts
```

**Resultado Esperado**:

```
🧪 Testando Knowledge Graph System...

📊 Construindo grafo do codebase...
✅ Arquivos analisados: 247
✅ Arquitetura detectada: modular
✅ Linguagens: TypeScript, JavaScript
✅ Frameworks: React

📈 Analisando impacto de mudanças em: src/index.ts
✅ Nível de risco: medium
✅ Arquivos afetados: 12
✅ Linhas de código afetadas: 450

✨ Knowledge Graph System funcionando!
```

---

### TESTE 2: Project Memory System

**Arquivo**: `packages/core/src/intelligence/project-memory.ts`

**Script de Teste**:

```typescript
// test-project-memory.ts
import { createMemoryManager } from './packages/core/src/intelligence/project-memory.js';

async function test() {
  console.log('🧪 Testando Project Memory System...\n');

  const memory = createMemoryManager(process.cwd());

  // Tentar carregar memória existente
  console.log('💾 Carregando memória do projeto...');
  await memory.load();

  // Registrar uma interação
  console.log('📝 Registrando nova interação...');
  await memory.learnFromInteraction({
    id: Date.now().toString(),
    timestamp: new Date(),
    task: 'Teste do sistema de memória',
    filesModified: ['test-project-memory.ts'],
    commandsExecuted: ['learn', 'suggest'],
    success: true,
    duration: 5000,
  });

  // Obter convenções aprendidas
  const conventions = memory.getConventions();
  console.log(`✅ Convenções aprendidas: ${conventions.length}`);

  // Obter sugestões
  console.log('\n💡 Gerando sugestões de melhorias...');
  const suggestions = await memory.suggestImprovements();
  console.log(`✅ Sugestões geradas: ${suggestions.length}`);

  suggestions.slice(0, 3).forEach((s, i) => {
    console.log(`   ${i + 1}. [${s.priority}] ${s.title}`);
  });

  // Salvar memória
  console.log('\n💾 Salvando memória...');
  await memory.save();

  console.log('\n✨ Project Memory System funcionando!\n');
}

test().catch(console.error);
```

**Executar**:

```bash
npx tsx test-project-memory.ts
```

---

### TESTE 3: Code Intelligence (Análise de Qualidade)

**Script de Teste**:

```typescript
// test-code-intelligence.ts
import { createCodeIntelligence } from './packages/core/src/intelligence/code-analysis.js';

async function test() {
  console.log('🧪 Testando Code Intelligence System...\n');

  const intelligence = createCodeIntelligence();

  // Arquivos para analisar
  const files = [
    'packages/core/src/intelligence/code-analysis.ts',
    'packages/core/src/intelligence/codebase-graph.ts',
  ];

  // 1. Análise de Qualidade
  console.log('📊 Analisando qualidade do código...');
  const quality = await intelligence.analyzeQuality(files);

  console.log(`✅ Grade de qualidade: ${quality.summary.grade}`);
  console.log(
    `✅ Maintainability: ${quality.overall.maintainability.toFixed(1)}/100`,
  );
  console.log(
    `✅ Complexidade média: ${quality.overall.complexity.toFixed(1)}`,
  );
  console.log(
    `✅ Code smells encontrados: ${quality.overall.codeSmells.length}`,
  );

  if (quality.overall.codeSmells.length > 0) {
    console.log('\n⚠️  Code Smells:');
    quality.overall.codeSmells.slice(0, 3).forEach((smell, i) => {
      console.log(`   ${i + 1}. [${smell.severity}] ${smell.description}`);
    });
  }

  // 2. Análise de Segurança
  console.log('\n🔒 Analisando segurança...');
  const security = await intelligence.scanSecurity(files);

  console.log(`✅ Score de segurança: ${security.score}/100`);
  console.log(`✅ Nível de risco: ${security.riskLevel}`);
  console.log(`✅ Vulnerabilidades: ${security.vulnerabilities.length}`);

  if (security.vulnerabilities.length > 0) {
    console.log('\n⚠️  Vulnerabilidades:');
    security.vulnerabilities.slice(0, 3).forEach((vuln, i) => {
      console.log(
        `   ${i + 1}. [${vuln.severity}] ${vuln.type}: ${vuln.description}`,
      );
    });
  }

  // 3. Análise de Performance
  console.log('\n⚡ Analisando performance...');
  const perf = await intelligence.profilePerformance(files);

  console.log(`✅ Bottlenecks encontrados: ${perf.bottlenecks.length}`);
  console.log(`✅ Operações I/O: ${perf.metrics.ioOperations}`);
  console.log(`✅ Complexidade estimada: ${perf.metrics.estimatedComplexity}`);

  if (perf.bottlenecks.length > 0) {
    console.log('\n⚠️  Bottlenecks:');
    perf.bottlenecks.slice(0, 3).forEach((bot, i) => {
      console.log(
        `   ${i + 1}. [${bot.severity}] ${bot.type}: ${bot.description}`,
      );
    });
  }

  console.log('\n✨ Code Intelligence System funcionando!\n');
}

test().catch(console.error);
```

**Executar**:

```bash
npx tsx test-code-intelligence.ts
```

---

### TESTE 4: Multi-Agent Collaboration

**Script de Teste**:

```typescript
// test-multi-agent.ts
import { createCollaborationEngine } from './packages/core/src/agents/collaboration.js';
import { createPlanningEngine } from './packages/core/src/planning/plan-mode.js';

async function test() {
  console.log('🧪 Testando Multi-Agent Collaboration...\n');

  const collab = createCollaborationEngine();
  const planner = createPlanningEngine();

  // 1. Criar equipe
  console.log('👥 Criando equipe de agentes...');
  const team = await collab.createTeam(
    'Implementar autenticação JWT',
    'complex',
  );

  console.log(`✅ Coordinator: ${team.coordinator.name}`);
  console.log(`✅ Specialists: ${team.specialists.length} agentes`);
  team.specialists.forEach((agent, i) => {
    console.log(`   ${i + 1}. ${agent.name} (${agent.role})`);
  });

  // 2. Criar plano
  console.log('\n📋 Criando plano de execução...');
  const plan = await planner.createPlan('Implementar autenticação JWT', {
    workingDirectory: process.cwd(),
  });

  console.log(`✅ Complexidade: ${plan.estimatedComplexity}`);
  console.log(`✅ Steps: ${plan.steps.length}`);

  // 3. Delegar para equipe
  console.log('\n⚙️  Delegando tarefa para equipe...');
  const result = await collab.delegateTask(plan, team);

  console.log(`✅ Sucesso: ${result.success ? 'Sim' : 'Não'}`);
  console.log(`✅ Duração: ${(result.totalDuration / 1000).toFixed(2)}s`);
  console.log(
    `✅ Paralelização: ${(result.metrics.parallelization * 100).toFixed(1)}%`,
  );
  console.log(
    `✅ Eficiência: ${(result.metrics.efficiency * 100).toFixed(1)}%`,
  );
  console.log(`✅ Qualidade: ${result.metrics.qualityScore}/100`);

  // 4. Performance da equipe
  console.log('\n📊 Performance da equipe:');
  const teamPerf = collab.getTeamPerformance(team);
  console.log(`✅ Total de tasks: ${teamPerf.totalTasks}`);
  console.log(`✅ Tasks completas: ${teamPerf.completedTasks}`);
  console.log(
    `✅ Success rate: ${(teamPerf.averageSuccessRate * 100).toFixed(1)}%`,
  );

  console.log('\n✨ Multi-Agent Collaboration funcionando!\n');
}

test().catch(console.error);
```

**Executar**:

```bash
npx tsx test-multi-agent.ts
```

---

### TESTE 5: Semantic Search

**Script de Teste**:

```typescript
// test-semantic-search.ts
import { createCodebaseAnalyzer } from './packages/core/src/intelligence/codebase-graph.js';
import { createSemanticSearchEngine } from './packages/core/src/intelligence/semantic-search.js';

async function test() {
  console.log('🧪 Testando Semantic Search Engine...\n');

  // 1. Construir grafo
  console.log('📊 Construindo índice de busca...');
  const analyzer = createCodebaseAnalyzer();
  const graph = await analyzer.buildGraph(process.cwd());

  // 2. Criar search engine
  const search = createSemanticSearchEngine();
  await search.buildIndex(graph);

  const stats = search.getStats();
  console.log(`✅ Arquivos indexados: ${stats.filesIndexed}`);
  console.log(`✅ Termos indexados: ${stats.termsIndexed}`);

  // 3. Busca exata
  console.log('\n🔍 Teste 1: Busca exata por "createCodebaseAnalyzer"');
  const exactResults = await search.search('createCodebaseAnalyzer', {
    mode: 'exact',
    maxResults: 5,
  });
  console.log(`✅ Resultados encontrados: ${exactResults.length}`);
  exactResults.slice(0, 3).forEach((r, i) => {
    console.log(`   ${i + 1}. ${r.node.path} (score: ${r.score.toFixed(2)})`);
  });

  // 4. Busca fuzzy
  console.log('\n🔍 Teste 2: Busca fuzzy por "analize" (typo)');
  const fuzzyResults = await search.search('analize', {
    mode: 'fuzzy',
    maxResults: 5,
  });
  console.log(`✅ Resultados encontrados: ${fuzzyResults.length}`);

  // 5. Busca semântica
  console.log('\n🔍 Teste 3: Busca semântica por "code quality analysis"');
  const semanticResults = await search.search('code quality analysis', {
    mode: 'semantic',
    maxResults: 5,
  });
  console.log(`✅ Resultados encontrados: ${semanticResults.length}`);
  semanticResults.slice(0, 3).forEach((r, i) => {
    console.log(`   ${i + 1}. ${r.node.path} (score: ${r.score.toFixed(2)})`);
  });

  // 6. Busca híbrida
  console.log('\n🔍 Teste 4: Busca híbrida por "testing workflow"');
  const hybridResults = await search.search('testing workflow', {
    mode: 'hybrid',
    maxResults: 5,
  });
  console.log(`✅ Resultados encontrados: ${hybridResults.length}`);

  console.log('\n✨ Semantic Search funcionando!\n');
}

test().catch(console.error);
```

**Executar**:

```bash
npx tsx test-semantic-search.ts
```

---

### TESTE 6: Versioning System

**Script de Teste**:

```typescript
// test-versioning.ts
import { createVersioningSystem } from './packages/core/src/robustness/versioning.js';

async function test() {
  console.log('🧪 Testando Advanced Versioning System...\n');

  const versioning = createVersioningSystem(process.cwd());
  await versioning.init();

  // 1. Criar snapshot
  console.log('📸 Criando snapshot do projeto...');
  const snapshot = await versioning.createSnapshot('Teste inicial', [
    'test-versioning.ts',
    'GUIA_DE_TESTES.md',
  ]);

  console.log(`✅ Snapshot ID: ${snapshot.id}`);
  console.log(`✅ Arquivos capturados: ${snapshot.files.size}`);
  console.log(`✅ Label: ${snapshot.metadata.label}`);

  // 2. Listar snapshots
  console.log('\n📋 Listando snapshots...');
  const snapshots = versioning.listSnapshots();
  console.log(`✅ Total de snapshots: ${snapshots.length}`);

  snapshots.slice(0, 5).forEach((s, i) => {
    const date = s.timestamp.toLocaleString();
    console.log(`   ${i + 1}. ${s.metadata.label} (${date})`);
  });

  // 3. Criar auto-snapshot
  console.log('\n📸 Criando auto-snapshot...');
  const autoSnapshot = await versioning.createAutoSnapshot('refactor');
  console.log(`✅ Auto-snapshot criado: ${autoSnapshot.id}`);
  console.log(`✅ Tags: ${autoSnapshot.metadata.tags.join(', ')}`);

  // 4. Comparar snapshots
  if (snapshots.length >= 2) {
    console.log('\n🔍 Comparando últimos 2 snapshots...');
    const comparison = versioning.compareSnapshots(
      snapshots[0].id,
      snapshots[1].id,
    );
    console.log(`✅ Arquivos adicionados: ${comparison.added.length}`);
    console.log(`✅ Arquivos modificados: ${comparison.modified.length}`);
    console.log(`✅ Arquivos deletados: ${comparison.deleted.length}`);
  }

  console.log('\n✨ Versioning System funcionando!\n');
}

test().catch(console.error);
```

**Executar**:

```bash
npx tsx test-versioning.ts
```

---

## 🎯 Teste Integrado Completo

**Script que testa TUDO de uma vez**:

```typescript
// test-all-features.ts
import { createCodebaseAnalyzer } from './packages/core/src/intelligence/codebase-graph.js';
import { createMemoryManager } from './packages/core/src/intelligence/project-memory.js';
import { createCodeIntelligence } from './packages/core/src/intelligence/code-analysis.js';
import { createSemanticSearchEngine } from './packages/core/src/intelligence/semantic-search.js';
import { createPlanningEngine } from './packages/core/src/planning/plan-mode.js';
import { createTaskDecomposer } from './packages/core/src/planning/task-decomposition.js';
import { createTestDrivenWorkflow } from './packages/core/src/robustness/test-workflow.js';
import { createVersioningSystem } from './packages/core/src/robustness/versioning.js';
import { createSelfCorrectionEngine } from './packages/core/src/autonomy/self-correction.js';
import { createCollaborationEngine } from './packages/core/src/agents/collaboration.js';

async function testAll() {
  console.log('🚀 TESTE COMPLETO DE TODAS AS FUNCIONALIDADES\n');
  console.log('='.repeat(60));

  const results = {
    passed: 0,
    failed: 0,
    tests: [] as Array<{
      name: string;
      status: 'PASS' | 'FAIL';
      duration: number;
    }>,
  };

  async function runTest(name: string, testFn: () => Promise<void>) {
    const start = Date.now();
    try {
      await testFn();
      const duration = Date.now() - start;
      results.tests.push({ name, status: 'PASS', duration });
      results.passed++;
      console.log(`✅ ${name} - ${duration}ms\n`);
    } catch (error) {
      const duration = Date.now() - start;
      results.tests.push({ name, status: 'FAIL', duration });
      results.failed++;
      console.log(`❌ ${name} - FALHOU: ${error}\n`);
    }
  }

  // Test 1: Knowledge Graph
  await runTest('Knowledge Graph System', async () => {
    const analyzer = createCodebaseAnalyzer();
    const graph = await analyzer.buildGraph(process.cwd());
    if (graph.nodes.size === 0) throw new Error('Nenhum arquivo analisado');
  });

  // Test 2: Project Memory
  await runTest('Project Memory System', async () => {
    const memory = createMemoryManager(process.cwd());
    await memory.load();
    await memory.suggestImprovements();
  });

  // Test 3: Code Intelligence
  await runTest('Code Intelligence System', async () => {
    const intelligence = createCodeIntelligence();
    const quality = await intelligence.analyzeQuality(['GUIA_DE_TESTES.md']);
    if (!quality.summary.grade) throw new Error('Análise falhou');
  });

  // Test 4: Semantic Search
  await runTest('Semantic Search Engine', async () => {
    const analyzer = createCodebaseAnalyzer();
    const graph = await analyzer.buildGraph(process.cwd());
    const search = createSemanticSearchEngine();
    await search.buildIndex(graph);
    const results = await search.search('test', {
      mode: 'hybrid',
      maxResults: 5,
    });
  });

  // Test 5: Planning Engine
  await runTest('Planning Engine', async () => {
    const planner = createPlanningEngine();
    const plan = await planner.createPlan('Test task', {
      workingDirectory: process.cwd(),
    });
    if (plan.steps.length === 0) throw new Error('Nenhum step criado');
  });

  // Test 6: Task Decomposer
  await runTest('Task Decomposer', async () => {
    const decomposer = createTaskDecomposer();
    const result = await decomposer.decompose({
      task: 'Implementar feature X',
    });
    if (result.subtasks.length === 0) throw new Error('Nenhuma subtask criada');
  });

  // Test 7: Versioning System
  await runTest('Versioning System', async () => {
    const versioning = createVersioningSystem(process.cwd());
    await versioning.init();
    const snapshot = await versioning.createSnapshot('Test', [
      'GUIA_DE_TESTES.md',
    ]);
    if (!snapshot.id) throw new Error('Snapshot não criado');
  });

  // Test 8: Self-Correction
  await runTest('Self-Correction Engine', async () => {
    const corrector = createSelfCorrectionEngine();
    const validation = await corrector.validateOutput('const x = 1;', [
      { type: 'syntax' },
    ]);
  });

  // Test 9: Multi-Agent Collaboration
  await runTest('Multi-Agent Collaboration', async () => {
    const collab = createCollaborationEngine();
    const team = await collab.createTeam('Test task', 'simple');
    if (team.specialists.length === 0)
      throw new Error('Nenhum specialist criado');
  });

  // Resumo
  console.log('='.repeat(60));
  console.log('\n📊 RESUMO DOS TESTES\n');
  console.log(`✅ Passou: ${results.passed}`);
  console.log(`❌ Falhou: ${results.failed}`);
  console.log(
    `📈 Taxa de sucesso: ${((results.passed / (results.passed + results.failed)) * 100).toFixed(1)}%\n`,
  );

  console.log('Detalhes:');
  results.tests.forEach((test, i) => {
    const icon = test.status === 'PASS' ? '✅' : '❌';
    console.log(`${i + 1}. ${icon} ${test.name} (${test.duration}ms)`);
  });

  console.log('\n' + '='.repeat(60));
  console.log(
    results.failed === 0
      ? '🎉 TODOS OS TESTES PASSARAM!'
      : '⚠️  ALGUNS TESTES FALHARAM',
  );
  console.log('='.repeat(60) + '\n');
}

testAll().catch(console.error);
```

**Executar**:

```bash
npx tsx test-all-features.ts
```

---

## 🎨 Teste Visual (Opcional)

Se quiser ver os outputs formatados, crie este script:

```bash
# test-visual.sh
#!/bin/bash

echo "🎨 TESTE VISUAL DAS FUNCIONALIDADES"
echo "===================================="
echo ""

echo "1️⃣  Testando Knowledge Graph..."
npx tsx test-knowledge-graph.ts
echo ""

echo "2️⃣  Testando Code Intelligence..."
npx tsx test-code-intelligence.ts
echo ""

echo "3️⃣  Testando Multi-Agent..."
npx tsx test-multi-agent.ts
echo ""

echo "4️⃣  Testando Semantic Search..."
npx tsx test-semantic-search.ts
echo ""

echo "✨ TODOS OS TESTES CONCLUÍDOS!"
```

**Tornar executável e rodar**:

```bash
chmod +x test-visual.sh
./test-visual.sh
```

---

## ⚡ Quick Test (Mais Rápido)

Se quiser apenas verificar que está tudo compilando:

```bash
# Compilar e verificar
cd packages/core
npm run build

# Se compilar sem erros, está funcionando! ✅
```

---

## 📝 Checklist de Testes

- [ ] Knowledge Graph compila
- [ ] Project Memory compila
- [ ] Code Intelligence compila
- [ ] Semantic Search compila
- [ ] Planning Engine compila
- [ ] Task Decomposer compila
- [ ] Versioning compila
- [ ] Self-Correction compila
- [ ] Multi-Agent compila
- [ ] Todos os imports funcionam
- [ ] TypeScript sem erros
- [ ] Testes básicos passam

---

## 🆘 Troubleshooting

### Erro: "Cannot find module"

**Solução**: Compile primeiro

```bash
cd packages/core
npm run build
```

### Erro: "TypeScript errors"

**Solução**: Verificar versão do TypeScript

```bash
npm install -D typescript@latest
```

### Erro: "Permission denied"

**Solução**: Dar permissão aos scripts

```bash
chmod +x test-*.ts
```

---

## ✨ Próximos Passos Após os Testes

Depois de testar e verificar que tudo funciona:

1. **Integração CLI**: Adicionar comandos `qwen analyze`, `qwen search`, etc.
2. **Unit Tests**: Criar testes automatizados com Vitest
3. **E2E Tests**: Testar workflows completos
4. **Documentation**: Atualizar README com novos comandos
5. **Release**: Preparar para alpha release

---

**Boa sorte com os testes! 🚀**
