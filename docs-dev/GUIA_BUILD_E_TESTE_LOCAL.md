# Guia Completo: Build e Teste Local da CLI Qwen-Code

## 📋 Pré-requisitos

Antes de começar, certifique-se de ter instalado:

- **Node.js 20+** (recomendado usar nvm)
- **npm** ou **pnpm** (o projeto usa npm workspaces)
- **Git** (para controle de versão)

Verifique as versões:

```bash
node --version  # Deve ser v20.x ou superior
npm --version   # Deve ser v9.x ou superior
```

---

## 🔨 Passo 1: Build do Projeto

### 1.1. Instalar Dependências

No diretório raiz do projeto:

```bash
# Instala todas as dependências (CLI + Core)
npm install
```

Isso vai instalar as dependências de todos os workspaces:

- `packages/cli` - Interface da linha de comando
- `packages/core` - Backend e lógica principal

### 1.2. Compilar o Core (TypeScript → JavaScript)

O módulo Core precisa ser compilado primeiro porque a CLI depende dele:

```bash
# Entrar no diretório do core
cd packages/core

# Compilar TypeScript para JavaScript
npm run build

# Voltar para a raiz
cd ../..
```

O comando `npm run build` vai:

- Compilar todos os arquivos `.ts` para `.js`
- Gerar os arquivos em `packages/core/dist/`
- Criar declaration files (`.d.ts`) para TypeScript

**Verificar se o build foi bem-sucedido**:

```bash
ls packages/core/dist/
# Deve listar: intelligence/, planning/, robustness/, autonomy/, agents/
```

### 1.3. Compilar a CLI

```bash
# Entrar no diretório da CLI
cd packages/cli

# Compilar a CLI
npm run build

# Voltar para a raiz
cd ../..
```

### 1.4. Build Completo (Alternativa Rápida)

Se o projeto tiver um script de build global, você pode fazer tudo de uma vez:

```bash
# Da raiz do projeto
npm run build --workspaces
```

---

## 🧪 Passo 2: Testar os Módulos Novos

Antes de testar a CLI completa, vamos verificar se os módulos novos estão funcionando:

### 2.1. Teste Rápido (Import Verification)

```bash
npx tsx tests-manual/test-simple.ts
```

**Resultado esperado**:

```
🧪 Teste Simples de Imports...

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
🎉 Todos os módulos OK!
```

### 2.2. Teste do Knowledge Graph

```bash
npx tsx tests-manual/test-knowledge-graph.ts
```

Este teste analisa o codebase e mostra:

- Número de arquivos analisados
- Arquitetura detectada
- Linguagens e frameworks
- Análise de impacto

### 2.3. Teste do Quality Monitor

```bash
npx tsx tests-manual/test-quality-monitor.ts
```

Este teste mostra:

- Dashboard visual no terminal
- Métricas de qualidade, segurança, performance
- Alertas ativos
- Tendências detectadas

---

## 🚀 Passo 3: Testar a CLI Localmente

### 3.1. Link Local (Desenvolvimento)

Para usar a CLI local sem publicar no npm:

```bash
# No diretório packages/cli
cd packages/cli

# Criar link simbólico global
npm link

# Voltar para a raiz
cd ../..
```

Agora você pode usar `qwen` de qualquer lugar:

```bash
qwen --version
qwen --help
```

### 3.2. Testar Comandos Básicos

```bash
# Ver ajuda
qwen --help

# Versão
qwen --version

# Modo interativo
qwen

# Executar um comando específico
qwen "Liste os arquivos TypeScript no projeto"

# Modo headless
qwen --headless "Analise o código"
```

### 3.3. Testar em um Projeto de Teste

Crie um projeto de teste separado:

```bash
# Criar diretório de teste
mkdir ~/qwen-test-project
cd ~/qwen-test-project

# Inicializar projeto Node.js
npm init -y

# Criar alguns arquivos de exemplo
cat > index.js << 'EOF'
function hello(name) {
  if (name) {
    console.log("Hello, " + name);
  } else {
    console.log("Hello, World!");
  }
}

hello("Qwen");
EOF

# Agora use o qwen
qwen "Analise este código e sugira melhorias"
```

---

## 🔧 Passo 4: Testar as Novas Funcionalidades

### 4.1. Testar Knowledge Graph

```bash
# Em um projeto
qwen "Analise a arquitetura deste projeto e mostre as dependências"
```

Internamente, a CLI pode usar:

```typescript
import { createCodebaseAnalyzer } from '@qwen-code/core';

const analyzer = createCodebaseAnalyzer();
const graph = await analyzer.buildGraph(process.cwd());
console.log('Arquitetura:', graph.metadata.architecture);
```

### 4.2. Testar Project Memory

```bash
# O system vai aprender com suas interações
qwen "Refatore este código seguindo as convenções do projeto"

# Na próxima vez, o memory system vai lembrar dessas convenções
```

### 4.3. Testar Code Intelligence

```bash
qwen "Faça uma análise de qualidade do código"
qwen "Verifique se há vulnerabilidades de segurança"
qwen "Identifique bottlenecks de performance"
```

### 4.4. Testar Plan Mode

```bash
# Ao pedir uma tarefa complexa, o qwen deve mostrar um plano
qwen "Adicione autenticação JWT ao projeto"

# Deve mostrar:
# 1. Plano de implementação
# 2. Passos necessários
# 3. Arquivos que serão modificados
# 4. Pedir aprovação antes de executar
```

### 4.5. Testar Multi-Agent Collaboration

```bash
qwen "Implemente um novo recurso de API REST com testes e documentação"

# Internamente, o sistema deve:
# 1. Coordinator analisa a tarefa
# 2. Developer implementa o código
# 3. Tester cria os testes
# 4. Documentation Writer cria a documentação
# 5. Reviewer valida tudo
```

### 4.6. Testar Semantic Search

```bash
qwen "Encontre todas as funções que lidam com autenticação"
qwen "Mostre código similar a esta função"
qwen "Onde esta variável é usada?"
```

### 4.7. Testar Quality Monitoring

```bash
# Pedir para monitorar qualidade
qwen "Mostre o dashboard de qualidade do projeto"
qwen "Existe alguma regressão de qualidade recente?"
qwen "Quais são os alertas de segurança ativos?"
```

---

## 🐛 Passo 5: Troubleshooting

### Erro: "Cannot find module"

**Problema**: TypeScript não foi compilado

**Solução**:

```bash
cd packages/core
npm run build
cd ../..
```

### Erro: "command not found: qwen"

**Problema**: npm link não foi executado

**Solução**:

```bash
cd packages/cli
npm link
cd ../..
```

### Erro: "Module did not self-register"

**Problema**: Incompatibilidade de versão Node.js

**Solução**:

```bash
# Limpar e reinstalar
rm -rf node_modules package-lock.json
rm -rf packages/*/node_modules packages/*/package-lock.json
npm install
npm run build --workspaces
```

### Erro: TypeScript errors durante o build

**Problema**: Tipos incompatíveis ou faltando

**Solução**:

```bash
# Atualizar TypeScript
npm install -D typescript@latest

# Limpar e rebuildar
npm run clean  # se existir
npm run build
```

### Performance ruim / CLI lenta

**Causas possíveis**:

1. Muito logs de debug
2. Análise de codebase grande
3. Embeddings sendo calculados

**Soluções**:

```bash
# Desabilitar logs verbosos
export LOG_LEVEL=error

# Usar cache
export QWEN_CACHE_ENABLED=true

# Limitar análise
export QWEN_MAX_FILES=1000
```

---

## 📊 Passo 6: Verificar Integração

### 6.1. Verificar que os módulos novos estão disponíveis

Crie um script de teste:

```typescript
// test-integration.ts
import {
  createCodebaseAnalyzer,
  createMemoryManager,
  createCodeIntelligence,
  createSemanticSearchEngine,
} from '@qwen-code/core/intelligence';

import {
  createPlanningEngine,
  createTaskDecomposer,
} from '@qwen-code/core/planning';

import {
  createTestDrivenWorkflow,
  createVersioningSystem,
  createQualityMonitor,
} from '@qwen-code/core/robustness';

import { createSelfCorrectionEngine } from '@qwen-code/core/autonomy';

import { createCollaborationEngine } from '@qwen-code/core/agents';

async function testIntegration() {
  console.log('✅ Todos os módulos importados com sucesso!');

  // Testar instanciação
  const analyzer = createCodebaseAnalyzer();
  const memory = createMemoryManager();
  const intelligence = createCodeIntelligence();
  const search = createSemanticSearchEngine();
  const planner = createPlanningEngine();
  const decomposer = createTaskDecomposer();
  const testWorkflow = createTestDrivenWorkflow();
  const versioning = createVersioningSystem();
  const monitor = createQualityMonitor();
  const selfCorrection = createSelfCorrectionEngine();
  const collaboration = createCollaborationEngine();

  console.log('✅ Todas as engines instanciadas com sucesso!');
}

testIntegration();
```

Execute:

```bash
npx tsx test-integration.ts
```

### 6.2. Verificar exports do Core

```bash
node -e "console.log(require('./packages/core/dist/index.js'))"
```

Deve mostrar todos os exports disponíveis.

---

## 🎯 Passo 7: Integração com a CLI

Para que a CLI use as novas funcionalidades, você precisa integrar no código da CLI:

### 7.1. Localizar o entry point da CLI

```bash
# Ver o entry point
cat packages/cli/package.json | grep '"main"'
cat packages/cli/package.json | grep '"bin"'
```

### 7.2. Adicionar as novas features

Edite o arquivo principal da CLI (provavelmente `packages/cli/src/index.ts` ou similar):

```typescript
// Importar os novos módulos
import { createCodebaseAnalyzer } from '@qwen-code/core/intelligence';
import { createPlanningEngine } from '@qwen-code/core/planning';
import { createQualityMonitor } from '@qwen-code/core/robustness';
// ... etc

// Integrar no loop principal da CLI
async function handleUserCommand(command: string) {
  // Usar Knowledge Graph para contexto
  const analyzer = createCodebaseAnalyzer();
  const graph = await analyzer.buildGraph(process.cwd());

  // Usar Plan Mode para tarefas complexas
  if (isComplexTask(command)) {
    const planner = createPlanningEngine();
    const plan = await planner.createPlan(command, {
      projectPath: process.cwd(),
      graph,
    });

    // Mostrar plano ao usuário
    console.log('📋 Plano de execução:');
    plan.steps.forEach((step, i) => {
      console.log(`${i + 1}. ${step.description}`);
    });

    // Pedir aprovação
    const approved = await askUserApproval();
    if (approved) {
      await planner.executePlanWithFeedback(plan, executor);
    }
  }

  // ... resto da lógica
}
```

### 7.3. Adicionar novos comandos

Adicione comandos específicos para as novas features:

```typescript
// Comando: qwen analyze
if (command.startsWith('analyze')) {
  const monitor = createQualityMonitor();
  const snapshot = await monitor.createSnapshot(process.cwd());
  const dashboard = monitor.formatDashboard(snapshot);
  console.log(dashboard);
}

// Comando: qwen graph
if (command.startsWith('graph')) {
  const analyzer = createCodebaseAnalyzer();
  const graph = await analyzer.buildGraph(process.cwd());
  console.log(`📊 Arquivos: ${graph.nodes.size}`);
  console.log(`🏗️  Arquitetura: ${graph.metadata.architecture}`);
}

// Comando: qwen search
if (command.startsWith('search')) {
  const searchEngine = createSemanticSearchEngine();
  const query = command.replace('search', '').trim();
  const results = await searchEngine.search(query, {
    mode: 'hybrid',
    maxResults: 10,
  });
  results.forEach((r) => {
    console.log(`📄 ${r.file} (score: ${r.score.toFixed(2)})`);
  });
}
```

---

## 📝 Passo 8: Workflow Recomendado de Desenvolvimento

Para continuar desenvolvendo e testando:

```bash
# 1. Fazer mudanças no código
vim packages/core/src/intelligence/codebase-graph.ts

# 2. Recompilar o Core
cd packages/core && npm run build && cd ../..

# 3. Testar o módulo específico
npx tsx tests-manual/test-knowledge-graph.ts

# 4. Se OK, testar na CLI
qwen "seu comando aqui"

# 5. Fazer commit
git add .
git commit -m "feat: adiciona funcionalidade X"
```

### Usar watch mode para desenvolvimento contínuo

```bash
# Em um terminal
cd packages/core
npm run build -- --watch

# Em outro terminal
cd packages/cli
npm run dev  # se tiver script de dev
```

---

## 🚢 Passo 9: Preparar para Deploy

### 9.1. Build de Produção

```bash
# Limpar tudo
npm run clean  # ou manualmente:
rm -rf packages/*/dist packages/*/node_modules

# Instalar fresh
npm install

# Build otimizado
NODE_ENV=production npm run build --workspaces
```

### 9.2. Testar o build de produção

```bash
# Instalar localmente
npm pack packages/cli
npm install -g qwen-code-*.tgz

# Testar
qwen --version
qwen --help
```

### 9.3. Publicar no npm (quando pronto)

```bash
# Login no npm
npm login

# Publicar o Core
cd packages/core
npm publish

# Publicar a CLI
cd ../cli
npm publish
```

---

## ✅ Checklist Final

Antes de considerar completo:

- [ ] `npm install` roda sem erros
- [ ] `npm run build` compila Core e CLI
- [ ] `npx tsx tests-manual/test-simple.ts` passa todos os 11 testes
- [ ] `npm link` funciona e `qwen --version` mostra a versão correta
- [ ] CLI responde a comandos básicos
- [ ] Testes manuais dos módulos novos funcionam
- [ ] Integração com os módulos novos está implementada na CLI
- [ ] Documentação está atualizada

---

## 🎓 Recursos Adicionais

### Documentação dos Módulos

- `IMPLEMENTATION_PHASE_1_2.md` - Documentação técnica completa
- `QUICKSTART_ADVANCED_FEATURES.md` - Guia rápido de uso
- `STATUS_FINAL_IMPLEMENTACAO.md` - Status da implementação

### Arquitetura

- `packages/core/src/intelligence/` - Módulos de inteligência
- `packages/core/src/planning/` - Módulos de planejamento
- `packages/core/src/robustness/` - Módulos de robustez
- `packages/core/src/autonomy/` - Módulos de autonomia
- `packages/core/src/agents/` - Sistema de agentes

### Scripts Úteis

```bash
# Ver estrutura do projeto
tree -L 3 packages/

# Ver dependências
npm list --depth=0

# Verificar tipos TypeScript
cd packages/core && npx tsc --noEmit

# Rodar linter
npm run lint  # se configurado
```

---

## 🆘 Suporte

Se encontrar problemas:

1. **Verifique os logs**: `qwen --verbose`
2. **Limpe e reinstale**: `rm -rf node_modules && npm install`
3. **Verifique versões**: Node 20+, npm 9+
4. **Consulte os testes**: `tests-manual/` tem exemplos funcionais
5. **Leia a documentação**: Todos os `.md` na raiz do projeto

---

**Última atualização**: 17 de Fevereiro de 2026

Boa sorte com o build e teste! 🚀
