# 🚀 Quick Start: Build e Teste em 5 Minutos

## ⚠️ IMPORTANTE: Sem Conflito com Instalação Existente

**Este guia usa `./qwen-dev.sh` (wrapper) ao invés de `npm link`.**

✅ Sua instalação global do `qwen` **NÃO** será afetada!
✅ Você pode testar a versão local sem remover/sobrescrever a versão instalada.
✅ Ambas as versões funcionam simultaneamente:

- `qwen` → versão instalada (produção)
- `./qwen-dev.sh` → versão local (desenvolvimento)

---

## Opção 1: Script Automatizado (Recomendado) ⚡

```bash
# Tornar executável (apenas primeira vez)
chmod +x build-and-test.sh

# Executar workflow completo
./build-and-test.sh
```

Isso vai:

1. ✅ Verificar Node.js 20+
2. ✅ Instalar dependências
3. ✅ Compilar Core (TypeScript → JavaScript)
4. ✅ Compilar CLI
5. ✅ Rodar 3 testes automáticos
6. ✅ Criar wrapper `./qwen-dev.sh` (SEGURO - não afeta qwen instalado!)
7. ✅ Verificar instalação

**Tempo estimado**: 2-3 minutos

---

## Opção 2: Manual (Passo a Passo) 🔧

### 1. Instalar Dependências

```bash
npm install
```

### 2. Compilar o Core

```bash
cd packages/core
npm run build
cd ../..
```

### 3. Testar os Módulos Novos

```bash
# Teste rápido (11 módulos)
npx tsx tests-manual/test-simple.ts

# Teste do Knowledge Graph
npx tsx tests-manual/test-knowledge-graph.ts

# Teste do Quality Monitor
npx tsx tests-manual/test-quality-monitor.ts
```

### 4. Criar Wrapper Local (Seguro)

```bash
# Criar wrapper
chmod +x qwen-dev.sh

# Ou usar o script
./build-and-test.sh wrapper
```

### 5. Testar a CLI Local

```bash
# Testar versão de desenvolvimento
./qwen-dev.sh --version
./qwen-dev.sh --help
./qwen-dev.sh "Liste os arquivos do projeto"

# Comparar com produção
qwen --version  # versão instalada (não afetada)
```

**Tempo estimado**: 5 minutos

---

## Opção 3: Apenas Testar Módulos (Sem CLI) 🧪

Se você só quer verificar que os módulos novos funcionam:

```bash
# 1. Instalar
npm install

# 2. Compilar Core
cd packages/core && npm run build && cd ../..

# 3. Testar
npx tsx tests-manual/test-simple.ts
```

**Tempo estimado**: 1-2 minutos

---

## Troubleshooting Rápido 🔍

### ❌ Erro: "Cannot find module"

```bash
# Solução: Recompilar o Core
cd packages/core
npm run build
cd ../..
```

### ❌ Erro: "./qwen-dev.sh: command not found"

```bash
# Solução: Tornar executável
chmod +x qwen-dev.sh

# Ou usar com bash
bash qwen-dev.sh --version
```

### ❌ Erro: Node.js version

```bash
# Solução: Atualizar Node.js
nvm install 20
nvm use 20
```

### ❌ Build falha com erros de tipo

```bash
# Solução: Limpar e reinstalar
rm -rf node_modules package-lock.json
rm -rf packages/*/node_modules
npm install
cd packages/core && npm run build && cd ../..
```

---

## Resultado Esperado ✅

Após o build e setup, você deve ver:

```bash
$ npx tsx tests-manual/test-simple.ts
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

```bash
$ ./qwen-dev.sh --version
qwen-code version 0.10.x (with advanced features - DEV)

$ qwen --version
qwen-code version 0.10.x (PRODUCTION - installed version)
```

---

## Próximos Passos 🎯

1. **Testar funcionalidades**: Veja `GUIA_BUILD_E_TESTE_LOCAL.md` para exemplos
2. **Integrar na CLI**: Adicione os módulos novos aos comandos da CLI
3. **Criar testes unitários**: Use Vitest para testes automatizados
4. **Deploy**: Prepare para publicação no npm

---

## Scripts Úteis 📝

### Build incremental (depois de mudanças)

```bash
# Apenas rebuild do Core
cd packages/core && npm run build && cd ../..

# Testar mudanças
npx tsx tests-manual/test-simple.ts
```

### Watch mode (desenvolvimento contínuo)

```bash
# Terminal 1: Watch Core
cd packages/core
npm run build -- --watch

# Terminal 2: Testar
npx tsx tests-manual/test-knowledge-graph.ts
```

### Limpar tudo e recomeçar

```bash
./build-and-test.sh clean
./build-and-test.sh
```

---

## Ajuda Adicional 📚

- **Guia completo**: `GUIA_BUILD_E_TESTE_LOCAL.md`
- **Documentação técnica**: `IMPLEMENTATION_PHASE_1_2.md`
- **Status da implementação**: `STATUS_FINAL_IMPLEMENTACAO.md`
- **Opções do script**: `./build-and-test.sh help`

---

**Última atualização**: 17 de Fevereiro de 2026

Qualquer dúvida, consulte `GUIA_BUILD_E_TESTE_LOCAL.md` para detalhes completos! 🚀
