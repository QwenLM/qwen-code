# ⚠️ NOTA IMPORTANTE: npm link e Conflitos

## 🚨 Aviso Crítico

**NÃO USE `npm link` se você já tem `qwen-code` instalado globalmente!**

### Por Quê?

`npm link` cria um link simbólico que **SOBRESCREVE** o comando `qwen` global temporariamente.

```bash
# ANTES do npm link
$ which qwen
/usr/local/bin/qwen  # Sua instalação global

# DEPOIS do npm link
$ which qwen
/usr/local/bin/qwen -> /Users/you/qwen-code/packages/cli/dist/index.js
                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                       AGORA aponta para sua versão local!
```

### Problemas que Isso Causa

1. **Perda temporária da CLI de produção**
   - Seus scripts e workflows que usam `qwen` agora usam a versão dev

2. **Comportamento inconsistente**
   - Pode ter bugs ou features incompletas
   - Logs e outputs podem ser diferentes

3. **Confusão em projetos**
   - Outros projetos usam a versão dev sem saber
   - Difícil debugar "por que não funciona?"

4. **Difícil de reverter**
   - Você precisa lembrar de fazer `npm unlink`
   - Pode esquecer e ficar com versão errada

---

## ✅ Solução: Use o Wrapper

Este repositório fornece `./qwen-dev.sh` que:

- ✅ **NÃO afeta** o `qwen` global
- ✅ **Fácil de usar**: `./qwen-dev.sh "comando"`
- ✅ **Óbvio**: Você sabe que está usando versão dev
- ✅ **Seguro**: Zero risco de conflito
- ✅ **Reversível**: É só deletar o arquivo

### Como Usar

```bash
# Desenvolvimento
./qwen-dev.sh --version        # versão local
./qwen-dev.sh "seu comando"

# Produção (não afetada!)
qwen --version                 # versão instalada
qwen "mesmo comando"

# Comparar comportamentos
diff <(qwen "teste") <(./qwen-dev.sh "teste")
```

---

## 🔧 Alternativas Seguras ao npm link

### 1. Script Wrapper (Recomendado) ⭐

```bash
# Já incluído no repo!
./qwen-dev.sh "comando"
```

**Vantagens**:

- Zero configuração
- Zero conflito
- Óbvio que é versão dev

### 2. npx Direto

```bash
npx -w packages/cli qwen-code "comando"
```

**Vantagens**:

- Sem instalação
- Sempre usa versão local

### 3. Alias Diferente

```json
// packages/cli/package.json
{
  "bin": {
    "qwen-dev": "./dist/index.js" // Mude de "qwen" para "qwen-dev"
  }
}
```

```bash
npm link
qwen-dev "comando"  # Não conflita!
qwen "comando"      # Original intacto!
```

**Vantagens**:

- Ambos disponíveis globalmente
- Nomes diferentes = zero confusão

### 4. Diretório Isolado

```bash
mkdir ~/test-env
cd ~/test-env
npm install /path/to/qwen-code/packages/cli
npx qwen-code "comando"
```

**Vantagens**:

- Completamente isolado
- Pode testar instalação real

### 5. Docker

```bash
docker run --rm -v $(pwd):/workspace qwen-dev "comando"
```

**Vantagens**:

- Zero impacto no host
- Reproduzível

---

## 📊 Comparação

| Método      | Segurança   | Facilidade | Velocidade | Global        |
| ----------- | ----------- | ---------- | ---------- | ------------- |
| npm link    | 🔴 Baixa    | ⭐⭐⭐⭐   | ⭐⭐⭐⭐⭐ | Sim (PERIGO!) |
| **Wrapper** | 🟢 **Alta** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Não           |
| npx         | 🟢 Alta     | ⭐⭐⭐⭐   | ⭐⭐⭐⭐   | Não           |
| Alias       | 🟡 Média    | ⭐⭐⭐     | ⭐⭐⭐⭐⭐ | Sim (OK)      |
| Dir isolado | 🟢 Alta     | ⭐⭐⭐     | ⭐⭐⭐     | Não           |
| Docker      | 🟢 Alta     | ⭐⭐       | ⭐⭐       | Não           |

---

## 🎯 Quando SERIA OK Usar npm link

Apenas use `npm link` se:

1. ✅ Você **NÃO** tem qwen instalado globalmente
2. ✅ Você entende os riscos
3. ✅ Você vai lembrar de fazer `npm unlink` depois
4. ✅ É um ambiente de desenvolvimento isolado
5. ✅ Nenhum outro projeto depende do `qwen` global

**Mesmo assim, o wrapper é mais seguro!**

---

## 🔄 Como Desfazer npm link

Se você já fez `npm link` e quer reverter:

```bash
# 1. Entrar no diretório da CLI
cd packages/cli

# 2. Desfazer link
npm unlink

# 3. Verificar que qwen global voltou
which qwen
qwen --version

# 4. Se qwen sumiu, reinstalar
npm install -g qwen-code@latest

# 5. Confirmar
qwen --version  # Deve ser a versão instalada
```

---

## 📋 Checklist de Segurança

Antes de começar desenvolvimento:

- [ ] Não vou usar `npm link`
- [ ] Vou usar `./qwen-dev.sh` ao invés
- [ ] Entendo que `qwen` e `./qwen-dev.sh` são diferentes
- [ ] Li este documento inteiro
- [ ] Configurei wrapper: `chmod +x qwen-dev.sh`

---

## 💡 Por Que Este Repo Mudou Para Wrapper?

**Versões anteriores** deste guia recomendavam `npm link`.

**Problema**: Usuários reportaram confusão e conflitos com instalação global.

**Solução**: A partir de agora, o script `./build-and-test.sh`:

- ✅ Cria `./qwen-dev.sh` por padrão
- ✅ NÃO faz `npm link` automaticamente
- ✅ Pede confirmação explícita se você realmente quer `npm link`

### Como Ficou

```bash
# ANTES (perigoso)
./build-and-test.sh
# → fazia npm link automaticamente 🔴

# AGORA (seguro)
./build-and-test.sh
# → cria ./qwen-dev.sh 🟢

# Se REALMENTE quiser npm link
./build-and-test.sh link
# → pede confirmação antes! ⚠️
```

---

## 🎓 Lições Aprendidas

### Problema Real: História de Usuário

```
Usuário: "Instalei qwen-code globalmente (npm install -g)
         e estava funcionando perfeitamente."

Usuário: "Clonei o repo para contribuir e executei npm link."

Usuário: "Agora o comando 'qwen' está quebrado em todos
         os meus projetos! O que aconteceu?"

Causa: npm link sobrescreveu o qwen global com versão dev
       incompleta que tinha bugs.

Solução: npm unlink + reinstalar qwen global

Prevenção: Usar wrapper ao invés de npm link!
```

### Por Que Wrapper é Melhor

1. **Explícito**: Você sabe que está usando versão dev
2. **Isolado**: Zero impacto em outros projetos
3. **Simples**: Apenas um script bash
4. **Reversível**: Deletar o arquivo = voltar ao normal
5. **Seguro**: Impossível afetar instalação global

---

## 🆘 Perguntas Frequentes

### P: Mas npm link é o padrão Node.js, não é?

**R**: Sim, mas é mais adequado para bibliotecas, não CLIs usadas globalmente. Para CLIs:

- Wrapper é mais seguro
- Menos confusão
- Mais óbvio o que está acontecendo

### P: E se eu quiser testar como se fosse instalação real?

**R**: Use npm pack + install em diretório separado:

```bash
cd packages/cli
npm pack
mkdir ~/test-install
cd ~/test-install
npm install /path/to/qwen-code/packages/cli/qwen-code-cli-0.10.0.tgz
npx qwen-code "teste"
```

### P: O wrapper é mais lento que npm link?

**R**: Não! Ambos executam `node dist/index.js`, mesma velocidade.

### P: Posso usar os dois (wrapper + npm link)?

**R**: Tecnicamente sim, mas NÃO recomendado. Escolha um:

- Desenvolvimento: wrapper
- Produção: instalação global

### P: E se eu já me acostumei com npm link?

**R**: Use alias no package.json para não conflitar:

```json
{
  "bin": {
    "qwen-dev": "./dist/index.js"
  }
}
```

Assim:

- `qwen-dev` → versão dev (npm link)
- `qwen` → versão prod (global)

---

## ✅ Resumo Final

**NÃO use npm link** se você quer evitar dores de cabeça!

**USE ao invés**:

1. `./qwen-dev.sh` (mais simples)
2. `npx` (mais direto)
3. Alias diferente (mais profissional)

**Todos os guias neste repo foram atualizados** para usar wrapper por padrão.

---

**Criado em**: 17 de Fevereiro de 2026

**Razão**: Prevenir conflitos reportados por usuários

**Recomendação**: Use `./qwen-dev.sh` sempre! 🚀
