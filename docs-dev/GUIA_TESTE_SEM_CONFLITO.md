# 🔒 Como Testar Sem Conflitar com Instalação Existente

## ⚠️ Problema

Se você já tem `qwen-code` instalado globalmente, usar `npm link` vai sobrescrever temporariamente o comando `qwen`, podendo causar conflitos.

## ✅ Soluções Seguras

---

## Opção 1: Alias Diferente (Recomendado) 🎯

Modifique o `package.json` da CLI para usar um comando diferente:

### 1.1. Editar package.json

```bash
# Abrir o arquivo
vim packages/cli/package.json

# Ou usar editor
code packages/cli/package.json
```

### 1.2. Alterar o bin name

Encontre a seção `"bin"` e mude para `qwen-dev`:

```json
{
  "name": "@qwen-code/cli",
  "bin": {
    "qwen-dev": "./dist/index.js"
  }
}
```

### 1.3. Link e usar

```bash
cd packages/cli
npm link
cd ../..

# Agora use qwen-dev (não conflita com qwen)
qwen-dev --version
qwen-dev "teste"

# Seu qwen original continua funcionando
qwen --version
```

### 1.4. Remover depois

```bash
cd packages/cli
npm unlink
cd ../..
```

---

## Opção 2: npx Direto (Mais Simples) ⚡

Use `npx` para executar sem instalar globalmente:

### 2.1. Build primeiro

```bash
# Instalar deps e compilar
npm install
cd packages/core && npm run build && cd ../..
cd packages/cli && npm run build && cd ../..
```

### 2.2. Usar com npx

```bash
# Da raiz do projeto
npx -w packages/cli qwen-code --version
npx -w packages/cli qwen-code "Liste arquivos"

# Ou do diretório da CLI
cd packages/cli
npx . --version
npx . "seu comando"
```

**Vantagem**: Zero instalação, zero conflito!

---

## Opção 3: Script de Desenvolvimento 🔧

Crie um script wrapper que chama a CLI local:

### 3.1. Criar script

```bash
cat > qwen-dev.sh << 'EOF'
#!/bin/bash
# Wrapper para testar CLI local sem conflitar
cd "$(dirname "$0")"
node packages/cli/dist/index.js "$@"
EOF

chmod +x qwen-dev.sh
```

### 3.2. Usar o script

```bash
./qwen-dev.sh --version
./qwen-dev.sh "Liste arquivos TypeScript"
./qwen-dev.sh --help
```

**Vantagem**: Simples e direto, sem modificar nada!

---

## Opção 4: Instalar em Diretório Separado 📁

Teste em um ambiente completamente isolado:

### 4.1. Criar ambiente de teste

```bash
# Criar diretório isolado
mkdir ~/qwen-test-env
cd ~/qwen-test-env

# Instalar sua versão local
npm install /Users/davipeterlini/projects-personal/qwen-code/packages/cli

# Ou via npm pack
cd /Users/davipeterlini/projects-personal/qwen-code/packages/cli
npm pack
cd ~/qwen-test-env
npm install /Users/davipeterlini/projects-personal/qwen-code/packages/cli/qwen-code-cli-*.tgz
```

### 4.2. Usar localmente

```bash
cd ~/qwen-test-env
npx qwen-code --version
npx qwen-code "teste"
```

**Vantagem**: Ambiente completamente isolado!

---

## Opção 5: Docker (Isolamento Total) 🐳

Para isolamento máximo, use Docker:

### 5.1. Criar Dockerfile

```bash
cat > Dockerfile.dev << 'EOF'
FROM node:20-alpine

WORKDIR /app

# Copiar projeto
COPY . .

# Instalar e buildar
RUN npm install
RUN cd packages/core && npm run build
RUN cd packages/cli && npm run build

# Entry point
ENTRYPOINT ["node", "packages/cli/dist/index.js"]
EOF
```

### 5.2. Build e usar

```bash
# Build da imagem
docker build -f Dockerfile.dev -t qwen-dev .

# Usar
docker run --rm -v $(pwd):/workspace qwen-dev --version
docker run --rm -v $(pwd):/workspace qwen-dev "teste"
```

**Vantagem**: Zero impacto no sistema host!

---

## 🎯 Comparação das Opções

| Opção            | Facilidade | Isolamento | Velocidade | Recomendado Para         |
| ---------------- | ---------- | ---------- | ---------- | ------------------------ |
| Alias (qwen-dev) | ⭐⭐⭐⭐   | ⭐⭐⭐     | ⭐⭐⭐⭐⭐ | Desenvolvimento contínuo |
| npx direto       | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐   | ⭐⭐⭐⭐   | Testes rápidos           |
| Script wrapper   | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐   | ⭐⭐⭐⭐⭐ | Simplicidade máxima      |
| Dir separado     | ⭐⭐⭐     | ⭐⭐⭐⭐⭐ | ⭐⭐⭐     | Testes de integração     |
| Docker           | ⭐⭐       | ⭐⭐⭐⭐⭐ | ⭐⭐       | Ambientes CI/CD          |

---

## 🚀 Recomendação Por Caso de Uso

### Para Desenvolvimento Ativo

**Use: Script Wrapper (Opção 3)**

```bash
# Setup (uma vez)
cat > qwen-dev.sh << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
node packages/cli/dist/index.js "$@"
EOF
chmod +x qwen-dev.sh

# Usar sempre
./qwen-dev.sh "seu comando"
```

**Por quê?**

- ✅ Zero configuração complexa
- ✅ Zero conflito
- ✅ Rápido
- ✅ Fácil de compartilhar com time

### Para Testes Ocasionais

**Use: npx Direto (Opção 2)**

```bash
npx -w packages/cli qwen-code "teste"
```

**Por quê?**

- ✅ Nenhuma instalação
- ✅ Sempre usa versão local
- ✅ Uma linha apenas

### Para Desenvolvimento Longo Prazo

**Use: Alias (Opção 1)**

```json
// packages/cli/package.json
{
  "bin": {
    "qwen-dev": "./dist/index.js"
  }
}
```

```bash
npm link
qwen-dev "teste"
```

**Por quê?**

- ✅ Comportamento igual à CLI real
- ✅ Fácil alternar entre dev e prod
- ✅ Familiar

---

## 📝 Atualização do Script build-and-test.sh

Vou criar uma versão atualizada do script que **não faz link** por padrão:

### Versão Segura do Script

```bash
#!/bin/bash
# build-and-test-safe.sh
# Script que NÃO faz npm link, usando wrapper ao invés

set -e

# ... (código de cores e funções igual) ...

# Função modificada para NÃO fazer link
setup_safe_wrapper() {
    print_step "Criando wrapper seguro (sem npm link)..."

    cat > qwen-dev.sh << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
node packages/cli/dist/index.js "$@"
EOF

    chmod +x qwen-dev.sh

    print_success "Wrapper criado: ./qwen-dev.sh"
    echo ""
    echo "  Use: ./qwen-dev.sh --version"
    echo "  Use: ./qwen-dev.sh 'seu comando'"
    echo ""
}

# ... resto do script usando setup_safe_wrapper ao invés de npm link ...
```

---

## 🔄 Como Desfazer npm link (Se Já Fez)

Se você já executou `npm link` e quer reverter:

```bash
# Entrar na CLI
cd packages/cli

# Remover link global
npm unlink

# Opcional: Reinstalar qwen original
npm install -g qwen-code@latest

# Verificar
which qwen
qwen --version
```

---

## 🧪 Workflow Recomendado Seguro

### Setup Inicial (uma vez)

```bash
# 1. Instalar deps
npm install

# 2. Build Core
cd packages/core && npm run build && cd ../..

# 3. Build CLI (se necessário)
cd packages/cli && npm run build && cd ../..

# 4. Criar wrapper
cat > qwen-dev.sh << 'EOF'
#!/bin/bash
cd "$(dirname "$0")"
node packages/cli/dist/index.js "$@"
EOF
chmod +x qwen-dev.sh
```

### Desenvolvimento Diário

```bash
# Após mudanças no Core
cd packages/core && npm run build && cd ../..

# Testar módulos
npx tsx tests-manual/test-simple.ts

# Testar CLI (sem conflito!)
./qwen-dev.sh "seu teste"

# Comparar com produção
qwen "mesmo teste"  # usa versão instalada
./qwen-dev.sh "mesmo teste"  # usa versão dev
```

---

## ✅ Checklist de Segurança

Antes de testar, confirme:

- [ ] Não usei `npm link` (ou já executei `npm unlink`)
- [ ] Tenho um wrapper (`qwen-dev.sh`) ou uso `npx`
- [ ] Testei que `qwen` original ainda funciona
- [ ] Tenho backup da versão prod (se necessário)

---

## 💡 Dica Pro: Aliases no Shell

Adicione ao seu `~/.bashrc` ou `~/.zshrc`:

```bash
# Qwen aliases
alias qwen-prod='qwen'  # Versão instalada
alias qwen-dev='/Users/davipeterlini/projects-personal/qwen-code/qwen-dev.sh'

# Ou com diretório
alias qwen-dev='cd /Users/davipeterlini/projects-personal/qwen-code && ./qwen-dev.sh'
```

Depois:

```bash
qwen-prod --version     # Produção
qwen-dev --version      # Desenvolvimento
```

---

## 🎯 Script Atualizado Final

Vou criar um script completamente seguro:

```bash
#!/bin/bash
# build-and-test-safe.sh - Zero conflito garantido!

# ... código ...

# Nova opção: link (agora opcional)
case "$1" in
    "link")
        echo "⚠️  ATENÇÃO: Isso vai sobrescrever 'qwen' global!"
        read -p "Continuar? (y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            setup_local_cli
        fi
        ;;
    *)
        # Por padrão, cria wrapper seguro
        setup_safe_wrapper
        ;;
esac
```

---

## 📚 Resumo

**NUNCA use `npm link` se quiser manter qwen original funcionando!**

**Use ao invés:**

1. Script wrapper `qwen-dev.sh` (mais fácil)
2. `npx` direto (mais rápido)
3. Alias no package.json `qwen-dev` (mais profissional)

Todas as opções testam sua versão local **sem afetar** a instalação global! 🎉

---

_Criado em: 17 de Fevereiro de 2026_
