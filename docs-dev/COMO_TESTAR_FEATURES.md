# 🧪 Como Testar As Novas Funcionalidades

## ⚠️ Status Atual

Os **11 módulos novos estão implementados e funcionando**, mas ainda **NÃO foram integrados na CLI**.

**O que funciona**:

- ✅ Todos os módulos compilados e testados
- ✅ Podem ser usados via scripts TypeScript
- ✅ Podem ser importados programaticamente

**O que NÃO funciona ainda**:

- ❌ Comandos CLI como `qwen-dev analyze`, `qwen-dev quality`, etc.
- ❌ Integração automática na conversa do qwen-dev

---

## 🎯 Opções Para Testar

### Opção 1: Scripts de Teste Prontos (Mais Fácil) ⭐

Os módulos já têm testes funcionais que você pode executar:

#### Teste Rápido - Todos os Módulos (30 segundos)

```bash
npx tsx tests-manual/test-simple.ts
```

**Output esperado**:

```
✅ Knowledge Graph
✅ Project Memory
✅ Code Intelligence
✅ Semantic Search
✅ Plan Mode
✅ Task Decomposer
✅ Test Workflow
✅ Versioning
✅ Quality Monitor
✅ Self-Correction
✅ Collaboration

📊 Resultado: 11 passou, 0 falhou
```

#### Teste do Knowledge Graph (1 minuto)

```bash
npx tsx tests-manual/test-knowledge-graph.ts
```

**O que faz**:

- Analisa todo o codebase
- Detecta arquitetura (MVC, Microservices, etc.)
- Identifica linguagens e frameworks
- Faz análise de impacto de mudanças

**Output esperado**:

```
📊 Construindo grafo do codebase...
✅ Arquivos analisados: 14399
✅ Arquitetura detectada: MVC
✅ Linguagens: TypeScript, JavaScript, Python
✅ Frameworks: React

📈 Analisando impacto...
✅ Nível de risco: medium
✅ Arquivos afetados: 150
```

#### Teste do Quality Monitor (1 minuto)

```bash
npx tsx tests-manual/test-quality-monitor.ts
```

**O que faz**:

- Coleta métricas de qualidade do código
- Analisa segurança (vulnerabilidades OWASP)
- Verifica performance
- Calcula coverage
- Mostra dashboard visual no terminal

**Output esperado**:

```
╔══════════════════════════════════════════════════════════════╗
║           QWEN-CODE QUALITY DASHBOARD                        ║
╠══════════════════════════════════════════════════════════════╣
║ Overall Health: 🟢 85.3/100 [████████████████░░░░]          ║
╠══════════════════════════════════════════════════════════════╣
║ 📊 Total Issues: 15                                          ║
║ ⚠️  Critical Issues: 2                                       ║
║ 🔔 Open Alerts: 3                                            ║
╠══════════════════════════════════════════════════════════════╣
║ METRICS                                                      ║
╠══════════════════════════════════════════════════════════════╣
║ Quality: 78.5/100 | Complexity: 8.2 | Smells: 12            ║
║ Security: 🟢 92.0/100 | Vulnerabilities: 2                   ║
║ Coverage: 75.5% [███████████████░░░░░]                       ║
║ Build: 12.3s | Tests: 8.5s | Size: 2.5 MB                   ║
╚══════════════════════════════════════════════════════════════╝
```

---

### Opção 2: Scripts Personalizados

Você pode criar seus próprios testes para explorar as funcionalidades:

#### Exemplo 1: Testar Knowledge Graph

```typescript
// test-graph.ts
import { createCodebaseAnalyzer } from './packages/core/dist/intelligence/codebase-graph.js';

async function test() {
  const analyzer = createCodebaseAnalyzer();

  // Construir grafo
  console.log('📊 Construindo grafo...');
  const graph = await analyzer.buildGraph(process.cwd());

  console.log(`✅ Arquivos: ${graph.nodes.size}`);
  console.log(`✅ Arquitetura: ${graph.metadata.architecture}`);
  console.log(`✅ Tech Stack:`, graph.metadata.techStack);

  // Análise de impacto
  const files = ['packages/core/src/intelligence/codebase-graph.ts'];
  const impact = await analyzer.getImpactAnalysis(files);

  console.log(`\n📈 Impacto de mudanças:`);
  console.log(`   Risco: ${impact.riskLevel}`);
  console.log(`   Arquivos afetados: ${impact.affectedFiles.length}`);
  console.log(`   Recomendações:`, impact.recommendations);
}

test();
```

Execute: `npx tsx test-graph.ts`

#### Exemplo 2: Testar Project Memory

```typescript
// test-memory.ts
import { createMemoryManager } from './packages/core/dist/intelligence/project-memory.js';

async function test() {
  const memory = createMemoryManager(process.cwd());

  // Aprender com uma sessão simulada
  console.log('🧠 Aprendendo convenções...');

  const session = {
    timestamp: new Date(),
    commandsExecuted: ['add feature', 'run tests', 'commit'],
    filesModified: ['src/feature.ts'],
    duration: 300000,
    success: true,
    context: {
      task: 'add authentication',
      approach: 'JWT',
    },
  };

  await memory.learnFromInteraction(session);

  // Ver sugestões
  const suggestions = await memory.suggestImprovements();
  console.log('\n💡 Sugestões:', suggestions);
}

test();
```

Execute: `npx tsx test-memory.ts`

#### Exemplo 3: Testar Semantic Search

```typescript
// test-search.ts
import { createCodebaseAnalyzer } from './packages/core/dist/intelligence/codebase-graph.js';
import { createSemanticSearchEngine } from './packages/core/dist/intelligence/semantic-search.js';

async function test() {
  // Construir grafo primeiro
  const analyzer = createCodebaseAnalyzer();
  const graph = await analyzer.buildGraph(process.cwd());

  // Criar search engine
  const search = createSemanticSearchEngine();
  await search.buildIndex(graph);

  // Buscar
  console.log('🔍 Buscando "authentication"...');
  const results = await search.search('authentication', {
    mode: 'hybrid',
    maxResults: 5,
  });

  results.forEach((r) => {
    console.log(`\n📄 ${r.file}`);
    console.log(`   Score: ${r.score.toFixed(2)}`);
    console.log(`   Matches: ${r.matches.length}`);
  });
}

test();
```

Execute: `npx tsx test-search.ts`

#### Exemplo 4: Testar Plan Mode

```typescript
// test-plan.ts
import { createPlanningEngine } from './packages/core/dist/planning/plan-mode.js';

async function test() {
  const planner = createPlanningEngine();

  // Criar plano
  const plan = await planner.createPlan(
    'Adicionar autenticação JWT ao projeto',
    {
      projectPath: process.cwd(),
      userPreferences: {
        testingRequired: true,
        approvalWorkflow: 'manual',
      },
    },
  );

  console.log('📋 Plano criado:');
  console.log(`   Tipo: ${plan.strategy}`);
  console.log(`   Passos: ${plan.steps.length}`);
  console.log(`   Risco: ${plan.metadata.estimatedRisk}`);

  plan.steps.forEach((step, i) => {
    console.log(`\n${i + 1}. ${step.description}`);
    console.log(`   Tipo: ${step.type}`);
    console.log(`   Risco: ${step.risk}`);
  });
}

test();
```

Execute: `npx tsx test-plan.ts`

#### Exemplo 5: Testar Multi-Agent Collaboration

```typescript
// test-agents.ts
import { createCollaborationEngine } from './packages/core/dist/agents/collaboration.js';

async function test() {
  const engine = createCollaborationEngine();

  const task = {
    description: 'Implementar nova API REST com testes',
    complexity: 'high',
    requirements: [
      'Criar endpoints CRUD',
      'Adicionar testes unitários',
      'Documentar API',
      'Validação de segurança',
    ],
  };

  // Criar equipe
  const team = await engine.createTeam(task, 'high');
  console.log('👥 Equipe criada:');
  team.agents.forEach((agent) => {
    console.log(`   ${agent.role}: ${agent.capabilities.join(', ')}`);
  });

  // Delegar tarefa (simulado)
  console.log('\n📋 Delegando tarefa...');
  const result = await engine.delegateTask(task, team);

  console.log(`\n✅ Resultado:`);
  console.log(`   Status: ${result.status}`);
  console.log(`   Qualidade: ${result.qualityScore}/100`);
  console.log(`   Agentes usados: ${result.agentsInvolved.length}`);
}

test();
```

Execute: `npx tsx test-agents.ts`

---

### Opção 3: Integrar na CLI (Avançado)

Para usar via `./qwen-dev.sh`, você precisa adicionar comandos customizados.

#### Passo 1: Localizar Entry Point

A CLI usa `packages/cli/dist/src/gemini.js` como entry point.

#### Passo 2: Adicionar Hook de Comando

Você pode interceptar comandos antes de enviar para a IA:

```typescript
// Em algum lugar antes do main() processar o input

// Importar módulos novos
import { createCodebaseAnalyzer } from '@qwen-code/qwen-code-core/intelligence';
import { createQualityMonitor } from '@qwen-code/qwen-code-core/robustness';

// Interceptar comandos especiais
if (userInput.startsWith('/analyze')) {
  const analyzer = createCodebaseAnalyzer();
  const graph = await analyzer.buildGraph(process.cwd());
  console.log(`Arquivos: ${graph.nodes.size}`);
  console.log(`Arquitetura: ${graph.metadata.architecture}`);
  return;
}

if (userInput.startsWith('/quality')) {
  const monitor = createQualityMonitor();
  const snapshot = await monitor.createSnapshot(process.cwd());
  console.log(monitor.formatDashboard(snapshot));
  return;
}

if (userInput.startsWith('/search ')) {
  const query = userInput.replace('/search ', '');
  // ... implementar busca
  return;
}
```

**NOTA**: Esta é uma modificação avançada que requer editar o código fonte da CLI.

---

## 📊 Comparação das Opções

| Opção                  | Facilidade | Completude | Integração CLI |
| ---------------------- | ---------- | ---------- | -------------- |
| Scripts prontos        | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐   | Não            |
| Scripts personalizados | ⭐⭐⭐⭐   | ⭐⭐⭐⭐⭐ | Não            |
| Integração CLI         | ⭐⭐       | ⭐⭐⭐⭐⭐ | Sim            |

---

## 🎯 Recomendação

**Para testar agora (sem modificar CLI)**:

```bash
# 1. Teste rápido - verificar que tudo funciona
npx tsx tests-manual/test-simple.ts

# 2. Explorar cada módulo
npx tsx tests-manual/test-knowledge-graph.ts
npx tsx tests-manual/test-quality-monitor.ts

# 3. Criar seus próprios testes
# (copie os exemplos acima e customize)
```

**Para usar na CLI `./qwen-dev.sh`**:

- Precisa integrar os módulos no código da CLI
- Adicionar comandos como `/analyze`, `/quality`, `/search`
- Ou modificar o prompt do sistema para usar os módulos automaticamente

---

## 🚀 Comandos CLI Planejados (Futuros)

Quando integrados, você poderá usar:

```bash
# Análise de arquitetura
./qwen-dev.sh analyze
./qwen-dev.sh analyze impact file.ts

# Dashboard de qualidade
./qwen-dev.sh quality
./qwen-dev.sh quality --watch

# Busca semântica
./qwen-dev.sh search "authentication"
./qwen-dev.sh search --mode=semantic "user login"

# Planejamento
./qwen-dev.sh plan "adicionar feature X"

# Ver memória do projeto
./qwen-dev.sh memory
./qwen-dev.sh memory conventions

# Multi-agent
./qwen-dev.sh agents create-team "tarefa complexa"
```

---

## ✅ TL;DR - Como Testar Agora

```bash
# Opção mais rápida
npx tsx tests-manual/test-simple.ts         # 30 seg
npx tsx tests-manual/test-knowledge-graph.ts # 1 min
npx tsx tests-manual/test-quality-monitor.ts # 1 min

# Todos funcionam sem modificar nada!
```

---

## 💡 Próximos Passos

1. ✅ **Testar módulos** com os scripts prontos
2. 🔧 **Criar testes personalizados** para seu use case
3. 🚀 **Integrar na CLI** (opcional, avançado)
4. 📦 **Publicar** quando estiver satisfeito

---

**Última atualização**: 17 de Fevereiro de 2026
