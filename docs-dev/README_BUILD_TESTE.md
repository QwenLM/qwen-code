# 🚀 Como Buildar e Testar - Qwen-Code com Novas Features

## ⚡ TL;DR - Forma Mais Rápida

```bash
# 1. Executar script automatizado
./build-and-test.sh

# 2. Testar (SEM conflitar com qwen instalado!)
./qwen-dev.sh --version
./qwen-dev.sh "Liste arquivos TypeScript"
```

**✅ Sua instalação global do `qwen` NÃO será afetada!**

---

## 📚 Guias Disponíveis

Escolha o guia conforme sua necessidade:

### 1. [COMO_TESTAR_RESUMO.md](./COMO_TESTAR_RESUMO.md) ⭐ **COMECE AQUI**

- **Para**: Iniciantes ou quem quer começar rápido
- **Tempo**: 5 minutos de leitura
- **Conteúdo**: Resumo executivo com TL;DR, workflow em 3 passos, comandos essenciais
- **Quando usar**: Primeira vez fazendo build ou quer uma visão geral

### 2. [QUICKSTART_BUILD.md](./QUICKSTART_BUILD.md) ⚡ **INÍCIO RÁPIDO**

- **Para**: Desenvolvedores que querem action rápida
- **Tempo**: 5 minutos
- **Conteúdo**: 3 opções de build (automatizado/manual/apenas testes), troubleshooting
- **Quando usar**: Quer fazer build e rodar sem ler muito

### 3. [GUIA_BUILD_E_TESTE_LOCAL.md](./GUIA_BUILD_E_TESTE_LOCAL.md) 📖 **COMPLETO**

- **Para**: Desenvolvedores que querem entender tudo
- **Tempo**: 20-30 minutos de leitura
- **Conteúdo**: 9 seções detalhadas, todos os passos, troubleshooting extensivo
- **Quando usar**: Quer dominar o processo, integrar na CLI, ou resolver problemas complexos

### 4. [GUIA_TESTE_SEM_CONFLITO.md](./GUIA_TESTE_SEM_CONFLITO.md) 🔒 **SEM CONFLITO**

- **Para**: Quem já tem qwen instalado e não quer sobrescrever
- **Tempo**: 10 minutos
- **Conteúdo**: 5 opções para testar sem npm link, comparação, recomendações
- **Quando usar**: Preocupado com conflitos entre versões dev e prod

---

## 🎯 Qual Guia Usar?

```
Tenho qwen instalado e quero testar sem afetar?
  → GUIA_TESTE_SEM_CONFLITO.md

Primeira vez fazendo build?
  → COMO_TESTAR_RESUMO.md

Quero só fazer build rápido?
  → QUICKSTART_BUILD.md

Quero entender tudo em detalhes?
  → GUIA_BUILD_E_TESTE_LOCAL.md

Tenho problema específico?
  → GUIA_BUILD_E_TESTE_LOCAL.md (seção Troubleshooting)
```

---

## 🛠️ Ferramentas Disponíveis

### Scripts

- **`./build-and-test.sh`** - Script automatizado completo (recomendado)
- **`./qwen-dev.sh`** - Wrapper para testar CLI local sem conflito

### Testes Manuais

- **`tests-manual/test-simple.ts`** - Verifica 11 módulos (30 seg)
- **`tests-manual/test-knowledge-graph.ts`** - Testa Knowledge Graph (1 min)
- **`tests-manual/test-quality-monitor.ts`** - Testa Dashboard de Qualidade (1 min)

---

## 📊 O Que Foi Implementado

- ✅ **11 módulos novos** (6,449 linhas de código)
- ✅ **4 fases completas** (67% do plano total)
- ✅ **Zero breaking changes** (100% compatível)

### Módulos:

1. **Knowledge Graph** - Entendimento semântico do codebase
2. **Project Memory** - Aprendizado contínuo
3. **Code Intelligence** - Análise de qualidade/segurança/performance
4. **Semantic Search** - Busca inteligente
5. **Plan Mode** - Planejamento com aprovação
6. **Task Decomposer** - Decomposição inteligente
7. **Test Workflow** - Workflow test-driven
8. **Versioning** - Snapshots e rollback
9. **Quality Monitor** - Dashboard de qualidade
10. **Self-Correction** - Auto-correção com aprendizado
11. **Collaboration** - Sistema multi-agent

---

## ⚡ Quick Commands

```bash
# Build completo
./build-and-test.sh

# Apenas build
./build-and-test.sh build

# Apenas testes
./build-and-test.sh test

# Criar wrapper
./build-and-test.sh wrapper

# Limpar e rebuildar
./build-and-test.sh clean
./build-and-test.sh

# Ver ajuda
./build-and-test.sh help

# Testar CLI local
./qwen-dev.sh --version
./qwen-dev.sh --help

# Comparar versões
qwen --version           # produção
./qwen-dev.sh --version  # desenvolvimento
```

---

## 🆘 Problemas Comuns

| Problema                    | Solução Rápida                         | Guia Detalhado                              |
| --------------------------- | -------------------------------------- | ------------------------------------------- |
| Cannot find module          | `cd packages/core && npm run build`    | GUIA_BUILD_E_TESTE_LOCAL.md#troubleshooting |
| qwen-dev.sh não funciona    | `chmod +x qwen-dev.sh`                 | QUICKSTART_BUILD.md#troubleshooting         |
| Node.js version             | `nvm install 20 && nvm use 20`         | GUIA_BUILD_E_TESTE_LOCAL.md#pre-requisitos  |
| Conflito com qwen instalado | Use `./qwen-dev.sh` ao invés de `qwen` | GUIA_TESTE_SEM_CONFLITO.md                  |

---

## 🎓 Documentação Técnica

Além dos guias de build/teste, há documentação técnica completa:

- **STATUS_FINAL_IMPLEMENTACAO.md** - Status completo da implementação
- **IMPLEMENTATION_PHASE_1_2.md** - Documentação técnica detalhada
- **IMPLEMENTATION_SUMMARY.md** - Resumo executivo
- **QUICKSTART_ADVANCED_FEATURES.md** - Como usar as novas features

---

## ✅ Workflow Recomendado

### Primeira Vez

```bash
# 1. Ler guia inicial (5 min)
cat COMO_TESTAR_RESUMO.md

# 2. Executar build (2-3 min)
./build-and-test.sh

# 3. Testar
./qwen-dev.sh --version
npx tsx tests-manual/test-simple.ts
```

### Desenvolvimento Contínuo

```bash
# Após mudanças no código
cd packages/core && npm run build && cd ../..

# Testar mudanças
npx tsx tests-manual/test-simple.ts
./qwen-dev.sh "seu teste"

# Comparar com prod
qwen "mesmo teste"
./qwen-dev.sh "mesmo teste"
```

---

## 🎯 Próximos Passos

Após testar com sucesso:

1. **Explorar**: Rodar todos os testes em `tests-manual/`
2. **Integrar**: Adicionar módulos novos aos comandos da CLI
3. **Desenvolver**: Implementar Phases 5-6 (opcionais)
4. **Deploy**: Preparar para publicação no npm

---

## 💡 Dicas

- ✅ Use `./qwen-dev.sh` para desenvolvimento (seguro)
- ✅ Mantenha `qwen` original para produção
- ✅ Compare comportamentos entre dev e prod
- ✅ Leia `build-and-test.sh help` para todas as opções
- ✅ Scripts de teste em `tests-manual/` funcionam standalone

---

**Última atualização**: 17 de Fevereiro de 2026

**Criado com**: 11 módulos novos, 6,449 linhas de código, 0 breaking changes

**Pronto para começar?** → [COMO_TESTAR_RESUMO.md](./COMO_TESTAR_RESUMO.md) ⭐
