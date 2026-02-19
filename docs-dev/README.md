# Documentação de Desenvolvimento - Qwen-Code

Esta pasta contém toda a documentação e scripts de desenvolvimento criados durante a implementação das features avançadas.

## 📚 Índice da Documentação

### 🚀 Quickstart

- **[QUICKSTART_BUILD.md](QUICKSTART_BUILD.md)** - Guia rápido para build e teste
- **[QUICKSTART_ADVANCED_FEATURES.md](QUICKSTART_ADVANCED_FEATURES.md)** - Guia de uso das features avançadas

### 🔧 Guias de Build e Teste

- **[GUIA_BUILD_E_TESTE_LOCAL.md](GUIA_BUILD_E_TESTE_LOCAL.md)** - Guia completo de build e teste local
- **[GUIA_DE_TESTES.md](GUIA_DE_TESTES.md)** - Guia detalhado de testes
- **[GUIA_TESTE_SEM_CONFLITO.md](GUIA_TESTE_SEM_CONFLITO.md)** - Como testar sem conflitar com instalação global
- **[README_BUILD_TESTE.md](README_BUILD_TESTE.md)** - README de build e teste

### 🧪 Como Testar

- **[COMO_TESTAR_FEATURES.md](COMO_TESTAR_FEATURES.md)** - Como testar as features implementadas
- **[COMO_TESTAR_RESUMO.md](COMO_TESTAR_RESUMO.md)** - Resumo dos testes

### 📝 Implementação

- **[IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md)** - Resumo da implementação
- **[IMPLEMENTATION_PHASE_1_2.md](IMPLEMENTATION_PHASE_1_2.md)** - Fases 1 e 2 da implementação
- **[IMPLEMENTATION_FILES.md](IMPLEMENTATION_FILES.md)** - Arquivos implementados
- **[REGISTRO_COMPLETO_IMPLEMENTACAO.md](REGISTRO_COMPLETO_IMPLEMENTACAO.md)** - Registro completo
- **[STATUS_FINAL_IMPLEMENTACAO.md](STATUS_FINAL_IMPLEMENTACAO.md)** - Status final

### ✅ Checklists e Comparações

- **[INTEGRATION_CHECKLIST.md](INTEGRATION_CHECKLIST.md)** - Checklist de integração
- **[BEFORE_AFTER_COMPARISON.md](BEFORE_AFTER_COMPARISON.md)** - Comparação antes/depois
- **[PROGRESS_UPDATE.md](PROGRESS_UPDATE.md)** - Atualização de progresso

### ⚠️ Notas Importantes

- **[NOTA_IMPORTANTE_NPM_LINK.md](NOTA_IMPORTANTE_NPM_LINK.md)** - Sobre npm link e instalação

## 🛠️ Scripts Automatizados

### build-and-test.sh

Script principal para build e teste do projeto.

**Uso:**

```bash
cd docs-dev
./build-and-test.sh [opção]
```

**Opções:**

- `(vazio)` ou `full` - Workflow completo (clean → build → test → setup)
- `clean` - Limpa builds anteriores
- `install` - Instala dependências
- `build` - Build completo (Core + CLI)
- `core` - Build apenas do Core
- `cli` - Build apenas da CLI
- `test` - Roda testes dos módulos novos
- `wrapper` - Cria wrapper ./qwen-dev.sh (seguro, recomendado)
- `link` - Configura CLI local (npm link - **sobrescreve qwen global!**)
- `verify` - Verifica instalação
- `help` - Mostra ajuda

**Exemplos:**

```bash
./build-and-test.sh              # Workflow completo (seguro)
./build-and-test.sh clean build  # Limpa e rebuilda
./build-and-test.sh test         # Apenas testes
./build-and-test.sh wrapper      # Cria wrapper sem afetar qwen global
```

### qwen-dev.sh

Wrapper seguro para testar a CLI local sem conflitar com instalação global.

**Uso:**

```bash
cd docs-dev
./qwen-dev.sh --version
./qwen-dev.sh --help
./qwen-dev.sh 'Liste os arquivos TypeScript'
```

## 🎯 Fluxo de Trabalho Recomendado

1. **Build inicial:**

   ```bash
   cd docs-dev
   ./build-and-test.sh
   ```

2. **Testar features:**

   ```bash
   ./qwen-dev.sh --version
   ```

3. **Após modificações:**

   ```bash
   ./build-and-test.sh build
   ./build-and-test.sh test
   ```

4. **Verificar instalação:**
   ```bash
   ./build-and-test.sh verify
   ```

## 📦 Estrutura do Projeto

```
qwen-code/
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── agents/          # Sistema de agentes
│   │       ├── autonomy/        # Capacidades autônomas
│   │       ├── intelligence/    # Recursos de inteligência
│   │       ├── planning/        # Sistema de planejamento
│   │       └── robustness/      # Controle de qualidade
│   └── cli/
├── tests-manual/                # Testes manuais
├── examples/                    # Exemplos de uso
└── docs-dev/                    # Esta pasta - Documentação de desenvolvimento
    ├── README.md                # Este arquivo
    ├── build-and-test.sh        # Script de build e teste
    ├── qwen-dev.sh              # Wrapper seguro da CLI
    └── [demais arquivos .md]    # Documentação detalhada
```

## ⚡ Features Implementadas

- **Knowledge Graph** - Grafo de conhecimento do codebase
- **Project Memory** - Memória persistente do projeto
- **Code Intelligence** - Análise inteligente de código
- **Semantic Search** - Busca semântica avançada
- **Plan Mode** - Modo de planejamento
- **Task Decomposer** - Decomposição de tarefas
- **Test Workflow** - Workflow de testes
- **Versioning** - Sistema de versionamento
- **Quality Monitor** - Monitoramento de qualidade
- **Self-Correction** - Auto-correção
- **Collaboration** - Ferramentas de colaboração

## 🔗 Links Úteis

- [CHANGELOG.md](../CHANGELOG.md) - Log de mudanças
- [CONTRIBUTING.md](../CONTRIBUTING.md) - Como contribuir
- [README.md](../README.md) - README principal do projeto

## ⚠️ Importante

Esta pasta (`docs-dev/`) contém apenas a documentação e scripts criados durante o desenvolvimento das features avançadas. Os arquivos da aplicação original estão em suas pastas originais e não devem ser movidos, pois o repositório mantém sincronização com o repo original do Qwen-Code.
