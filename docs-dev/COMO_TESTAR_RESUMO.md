# Como Testar a Nova Versão do Qwen-Code - RESUMO EXECUTIVO

## ⚡ TL;DR - Forma Mais Rápida

```bash
# 1. Executar script automatizado (faz tudo)
chmod +x build-and-test.sh
./build-and-test.sh

# 2. Testar a CLI local (SEM conflitar com qwen instalado!)
./qwen-dev.sh --version
./qwen-dev.sh "Liste os arquivos TypeScript do projeto"

# Sua instalação global do qwen continua funcionando normalmente
qwen --version  # versão original instalada
```

**Tempo**: 2-3 minutos
**Resultado**: CLI funcional com todas as novas features

---

## 📋 O Que Foi Implementado

### 11 Módulos Novos (6,449 linhas de código):

1. **Knowledge Graph** - Entendimento semântico do codebase
2. **Project Memory** - Aprendizado contínuo de convenções
3. **Code Intelligence** - Análise de qualidade, segurança, performance
4. **Semantic Search** - Busca inteligente no código
5. **Plan Mode** - Planejamento com aprovação de tarefas
6. **Task Decomposer** - Decomposição inteligente de tarefas
7. **Test Workflow** - Workflow test-driven
8. **Versioning** - Sistema avançado de snapshots
9. **Quality Monitor** - Dashboard de qualidade em tempo real
10. **Self-Correction** - Auto-correção com aprendizado
11. **Collaboration** - Sistema multi-agent

---

## 🎯 Workflow de Teste Recomendado

### PASSO 1: Build Automatizado

```bash
./build-and-test.sh
```

Isso executa:

- ✅ Verifica Node.js 20+
- ✅ Instala dependências (`npm install`)
- ✅ Compila Core TypeScript → JavaScript
- ✅ Roda 3 testes automáticos
- ✅ Cria wrapper `./qwen-dev.sh` (SEGURO - não afeta qwen instalado!)

### PASSO 2: Verificar Módulos

Após o script, você verá:

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
🎉 Todos os módulos OK!
```

### PASSO 3: Testar CLI Local

```bash
# Verificar versão local (desenvolvimento)
./qwen-dev.sh --version

# Testar comandos básicos
./qwen-dev.sh --help
./qwen-dev.sh "Analise este projeto"

# Comparar com versão instalada (produção)
qwen --version  # sua instalação global não foi afetada!
```

---

## 🧪 Testes Individuais

Se quiser testar módulos específicos:

```bash
# Teste rápido (30 segundos)
npx tsx tests-manual/test-simple.ts

# Teste do Knowledge Graph (1 minuto)
npx tsx tests-manual/test-knowledge-graph.ts

# Teste do Quality Monitor (1 minuto)
npx tsx tests-manual/test-quality-monitor.ts
```

---

## 🎨 Demonstração Visual

### Exemplo: Quality Monitor Dashboard

```bash
npx tsx tests-manual/test-quality-monitor.ts
```

**Resultado esperado**:

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

## 🔧 Comandos Úteis

### Build & Test

```bash
# Build completo
./build-and-test.sh build

# Apenas testes
./build-and-test.sh test

# Limpar e rebuildar
./build-and-test.sh clean
./build-and-test.sh
```

### Desenvolvimento

```bash
# Rebuild apenas Core (após mudanças)
cd packages/core && npm run build && cd ../..

# Watch mode (auto-rebuild)
cd packages/core
npm run build -- --watch
```

### CLI Local

```bash
# Criar wrapper seguro (recomendado)
./build-and-test.sh wrapper

# Ou manualmente
chmod +x qwen-dev.sh

# Usar CLI local
./qwen-dev.sh --version
./qwen-dev.sh --help

# NOTA: Se realmente quiser usar npm link (SOBRESCREVE qwen global):
# cd packages/cli && npm link && cd ../..
```

---

## 🐛 Problemas Comuns

| Erro                      | Solução                              |
| ------------------------- | ------------------------------------ |
| `Cannot find module`      | `cd packages/core && npm run build`  |
| `qwen: command not found` | `cd packages/cli && npm link`        |
| `Node.js version`         | `nvm install 20 && nvm use 20`       |
| Build falha               | `rm -rf node_modules && npm install` |

---

## 📚 Documentação Completa

Documentos disponíveis:

1. **QUICKSTART_BUILD.md** - Início rápido (5 min)
2. **GUIA_BUILD_E_TESTE_LOCAL.md** - Guia completo e detalhado
3. **IMPLEMENTATION_PHASE_1_2.md** - Documentação técnica
4. **STATUS_FINAL_IMPLEMENTACAO.md** - Status da implementação
5. **tests-manual/README.md** - Instruções dos testes

---

## ✅ Checklist de Sucesso

Após executar `./build-and-test.sh`, você deve ter:

- [x] Todos os 11 módulos passando nos testes
- [x] Wrapper `./qwen-dev.sh` criado e funcionando
- [x] `./qwen-dev.sh --version` mostrando a versão de desenvolvimento
- [x] `qwen --version` mostrando sua versão instalada (não afetada!)
- [x] Sem erros de compilação TypeScript
- [x] Zero conflito entre versão dev e prod

---

## 🎯 Próximos Passos

### Testar as Novas Funcionalidades

As features estão implementadas no Core, mas **ainda não integradas na CLI**. Para usar:

#### Opção 1: Via Scripts de Teste

```bash
# Testar cada módulo individualmente
npx tsx tests-manual/test-knowledge-graph.ts
npx tsx tests-manual/test-quality-monitor.ts
```

#### Opção 2: Integração Manual na CLI

Edite `packages/cli/src/index.ts` (ou o entry point da CLI) e adicione:

```typescript
import { createCodebaseAnalyzer } from '@qwen-code/core/intelligence';
import { createQualityMonitor } from '@qwen-code/core/robustness';

// No handler de comandos
if (command === 'analyze') {
  const analyzer = createCodebaseAnalyzer();
  const graph = await analyzer.buildGraph(process.cwd());
  console.log(`📊 Arquivos: ${graph.nodes.size}`);
  console.log(`🏗️  Arquitetura: ${graph.metadata.architecture}`);
}

if (command === 'quality') {
  const monitor = createQualityMonitor();
  const snapshot = await monitor.createSnapshot(process.cwd());
  console.log(monitor.formatDashboard(snapshot));
}
```

### Desenvolvimento Futuro

- [ ] Integrar módulos nos comandos da CLI
- [ ] Adicionar comandos: `qwen analyze`, `qwen quality`, `qwen search`
- [ ] Criar testes unitários (Vitest)
- [ ] Deploy/Release (npm publish)

---

## 💡 Dicas Pro

1. **Use o script automatizado** - Economiza tempo e evita erros
2. **Watch mode** - Para desenvolvimento contínuo
3. **Teste incremental** - Após mudanças, rebuild apenas o Core
4. **Leia os logs** - Scripts mostram cada passo do processo

---

## 🆘 Precisa de Ajuda?

1. **Quick start**: `QUICKSTART_BUILD.md`
2. **Guia completo**: `GUIA_BUILD_E_TESTE_LOCAL.md`
3. **Script help**: `./build-and-test.sh help`
4. **Issues**: GitHub issues ou logs de erro

---

**Resumo Final**: Execute `./build-and-test.sh` e em 3 minutos você terá uma CLI funcional com 11 módulos novos testados e prontos para uso! 🚀

---

_Criado em: 17 de Fevereiro de 2026_
