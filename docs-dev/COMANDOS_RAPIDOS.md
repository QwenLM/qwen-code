# ⚡ Comandos Rápidos - Qwen-Code

Referência rápida dos comandos mais usados.

## 🏗️ Build e Teste

### Build Completo (Recomendado)

```bash
cd docs-dev && ./build-and-test.sh
```

### Apenas Build

```bash
cd docs-dev && ./build-and-test.sh build
```

### Apenas Testes

```bash
cd docs-dev && ./build-and-test.sh test
```

### Limpar e Rebuildar

```bash
cd docs-dev && ./build-and-test.sh clean build
```

---

## 🧪 Testar CLI Local

### Versão

```bash
cd docs-dev && ./qwen-dev.sh --version
```

### Ajuda

```bash
cd docs-dev && ./qwen-dev.sh --help
```

### Comando Exemplo

```bash
cd docs-dev && ./qwen-dev.sh 'Liste os arquivos TypeScript'
```

---

## 🔍 Verificação

### Verificar Instalação

```bash
cd docs-dev && ./build-and-test.sh verify
```

### Comparar Versões

```bash
# Versão instalada globalmente
qwen --version

# Versão em desenvolvimento
cd docs-dev && ./qwen-dev.sh --version
```

---

## 📚 Documentação

### Ver Índice Completo

```bash
cat docs-dev/README.md
```

### Ver Início Rápido

```bash
cat docs-dev/INICIO_RAPIDO.md
```

### Ver Guia de Build

```bash
cat docs-dev/QUICKSTART_BUILD.md
```

### Ver Como Testar

```bash
cat docs-dev/COMO_TESTAR_FEATURES.md
```

---

## 🛠️ Desenvolvimento

### Após Modificar Código

```bash
cd docs-dev
./build-and-test.sh build
./build-and-test.sh test
./qwen-dev.sh 'seu teste aqui'
```

### Ciclo Completo de Desenvolvimento

```bash
# 1. Modificar código
vim packages/core/src/...

# 2. Rebuild
cd docs-dev && ./build-and-test.sh build

# 3. Testar
cd docs-dev && ./build-and-test.sh test

# 4. Testar CLI
cd docs-dev && ./qwen-dev.sh 'teste'
```

---

## 🧹 Limpeza

### Limpar Build

```bash
cd docs-dev && ./build-and-test.sh clean
```

### Reinstalar Dependências

```bash
cd docs-dev
./build-and-test.sh clean
./build-and-test.sh install
```

---

## 📋 Opções do build-and-test.sh

```bash
./build-and-test.sh [opção]

Opções disponíveis:
  (vazio)     # Workflow completo (recomendado)
  full        # Mesmo que vazio
  clean       # Limpa builds anteriores
  install     # Instala dependências
  build       # Build completo (Core + CLI)
  core        # Build apenas do Core
  cli         # Build apenas da CLI
  test        # Roda testes dos módulos novos
  wrapper     # Cria wrapper ./qwen-dev.sh (seguro)
  link        # npm link (SOBRESCREVE qwen global!)
  verify      # Verifica instalação
  help        # Mostra ajuda
```

---

## 🎯 Comandos por Situação

### Primeira Vez Usando o Projeto

```bash
cd docs-dev
./build-and-test.sh              # Build completo
./qwen-dev.sh --version          # Testar
```

### Após Modificar Código

```bash
cd docs-dev
./build-and-test.sh build test
```

### Quando Algo Não Funciona

```bash
cd docs-dev
./build-and-test.sh clean
./build-and-test.sh
```

### Para Testar Features Específicas

```bash
cd docs-dev
./qwen-dev.sh 'comando específico'
```

---

## 💡 Dicas

1. **Sempre inicie com `cd docs-dev`** antes de executar comandos
2. **Use `./qwen-dev.sh`** para testar localmente (não afeta instalação global)
3. **Execute testes** após qualquer modificação
4. **Consulte `./build-and-test.sh help`** quando precisar

---

## 🆘 Solução de Problemas

### Erro: "CLI não compilada"

```bash
cd docs-dev && ./build-and-test.sh build
```

### Erro: "npm não encontrado"

```bash
# Instale Node.js 20+ primeiro
node --version  # Deve ser 20+
```

### Erro: Testes falhando

```bash
cd docs-dev
./build-and-test.sh clean
./build-and-test.sh
```

### Erro: Permission denied

```bash
chmod +x docs-dev/build-and-test.sh
chmod +x docs-dev/qwen-dev.sh
```

---

## 🔗 Atalhos de Uma Linha

```bash
# Build e teste rápido
cd docs-dev && ./build-and-test.sh && ./qwen-dev.sh --version

# Limpar e rebuildar tudo
cd docs-dev && ./build-and-test.sh clean && ./build-and-test.sh

# Testar comando específico rapidamente
cd docs-dev && ./build-and-test.sh build && ./qwen-dev.sh 'seu comando'
```

---

**Última atualização:** 2026-02-17
