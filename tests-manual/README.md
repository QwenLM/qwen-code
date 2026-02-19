# Testes Manuais

Scripts para testar as funcionalidades implementadas.

## 🚀 Quick Start

### Opção 1: Script Automatizado (Recomendado)

```bash
# Da raiz do projeto
./build-and-test.sh
```

Este script vai compilar tudo e rodar todos os testes automaticamente!

### Opção 2: Manual

#### 1. Compilar primeiro

```bash
cd packages/core
npm run build
cd ../..
```

### 2. Rodar teste simples (recomendado começar aqui)

```bash
npx tsx tests-manual/test-simple.ts
```

Este teste apenas verifica se todos os módulos podem ser importados.

### 3. Rodar teste do Knowledge Graph

```bash
npx tsx tests-manual/test-knowledge-graph.ts
```

Este teste analisa o codebase atual e mostra informações.

### 4. Rodar teste do Quality Monitoring Dashboard

```bash
npx tsx tests-manual/test-quality-monitor.ts
```

Este teste mostra o dashboard de qualidade com métricas, alertas e tendências.

## Testes Disponíveis

- `test-simple.ts` - Verifica imports básicos (rápido)
- `test-knowledge-graph.ts` - Testa análise de codebase (completo)
- `test-quality-monitor.ts` - Testa dashboard de qualidade (completo)

## Troubleshooting

### Erro: "Cannot find module"

Compile o projeto primeiro:

```bash
npm run build
```

### Erro: "npx: command not found"

Instale o Node.js 20+:

```bash
nvm install 20
nvm use 20
```

### Erro de TypeScript

Verifique se está usando TypeScript 5+:

```bash
npm install -D typescript@latest
```
