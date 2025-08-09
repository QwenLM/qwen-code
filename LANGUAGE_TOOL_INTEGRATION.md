# Integração do LanguageTool com Qwen-Code

Esta documentação explica como configurar e usar a integração do LanguageTool com o Qwen-Code para verificar e corrigir automaticamente a gramática dos inputs do usuário.

## Configuração

### 1. Instalar e executar o LanguageTool

Primeiro, você precisa ter o LanguageTool rodando localmente na porta 8081:

```bash
# Baixe o LanguageTool Server
wget https://languagetool.org/download/LanguageTool-6.0.zip
unzip LanguageTool-6.0.zip
cd LanguageTool-6.0

# Execute o servidor na porta 8081
java -cp languagetool-server.jar org.languagetool.server.HTTPServer --port 8081
```

O servidor estará disponível em `http://localhost:8081`.

### 2. Configurar variáveis de ambiente (opcional)

Você pode configurar o comportamento do LanguageTool através de variáveis de ambiente:

```bash
# Ativar a verificação automática (0 ou 1)
export LT_ENABLED=1

# Política de correção: off | confirm | auto-first | auto-best
export LT_POLICY=confirm

# URL do servidor LanguageTool
export LT_SERVER=http://localhost:8081

# Idioma padrão
export LT_LANG=pt-BR

# Idioma nativo (opcional)
export LT_MOTHER_TONGUE=pt-BR

# Regras a serem habilitadas (separadas por vírgula)
export LT_RULES_ON=

# Regras a serem desabilitadas (separadas por vírgula)
export LT_RULES_OFF=UPPERCASE_SENTENCE_START,MORFOLOGIK_RULE_PT_PT

# Nível de verificação: default | picky
export LT_LEVEL=default
```

## Uso

### 1. Verificação automática

Quando as variáveis de ambiente estão configuradas corretamente, o Qwen-Code verificará automaticamente todos os inputs do usuário e sugerirá correções de acordo com a política definida:

- `off`: Nenhuma verificação automática
- `confirm`: Verifica e pergunta ao usuário antes de aplicar correções
- `auto-first`: Verifica e aplica automaticamente a primeira sugestão de correção
- `auto-best`: Verifica e aplica automaticamente a melhor sugestão de correção (funcionalidade limitada)

### 2. Comando slash

Você também pode usar o comando `/lt` para verificar manualmente um texto:

```
/lt Este texto têm alguns erros de gramática.
```

### 3. Ferramenta para o modelo

O modelo de linguagem também pode usar automaticamente a ferramenta `language_tool_check` quando achar necessário verificar ou corrigir a gramática de um texto.

## Funcionalidades

### Correção automática de inputs

O Qwen-Code agora corrige automaticamente os inputs do usuário antes de enviá-los ao modelo de linguagem, de acordo com a política configurada.

### Detalhamento de erros

Quando erros são encontrados, o sistema mostra:

- O texto original e o corrigido
- Detalhes de cada erro encontrado
- Sugestões de correção
- Identificação da regra que foi violada

### Integração com o modelo

O modelo de linguagem pode chamar a ferramenta `language_tool_check` para verificar a gramática de textos gerados ou recebidos.

## Solução de problemas

### O LanguageTool não está respondendo

Verifique se o servidor está rodando:

```bash
curl http://localhost:8081/v2/check -d "text=Este é um teste." -d "language=pt-BR"
```

### As correções não estão sendo aplicadas

Verifique se a variável `LT_ENABLED` está definida como `1` e a política está configurada corretamente.

### Problemas com regras específicas

Você pode desabilitar regras específicas usando a variável `LT_RULES_OFF`, separando os IDs das regras por vírgula.
