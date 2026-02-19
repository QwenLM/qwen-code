# 🚀 Início Rápido - Qwen-Code Development

Esta é a pasta centralizada de documentação e ferramentas de desenvolvimento do Qwen-Code.

## 📋 Primeiros Passos

### 1. Build e Teste (Recomendado)

Execute o workflow completo para garantir que tudo está funcionando:

```bash
cd docs-dev
./build-and-test.sh
```

Isso vai:

- ✅ Limpar builds anteriores
- ✅ Instalar dependências
- ✅ Compilar Core e CLI
- ✅ Rodar testes
- ✅ Criar wrapper seguro (sem afetar qwen global)

### 2. Testar a CLI Local

Após o build, teste a versão local sem conflitar com o qwen instalado:

```bash
cd docs-dev
./qwen-dev.sh --version
./qwen-dev.sh --help
./qwen-dev.sh 'Liste os arquivos TypeScript'
```

### 3. Comandos Rápidos

```bash
cd docs-dev

# Workflow completo (clean + build + test + setup)
./build-and-test.sh

# Apenas build
./build-and-test.sh build

# Apenas testes
./build-and-test.sh test

# Verificar instalação
./build-and-test.sh verify

# Ver todas as opções
./build-and-test.sh help
```

## 📚 Documentação Essencial

### Para começar:

1. **[README.md](README.md)** - Índice completo da documentação
2. **[QUICKSTART_BUILD.md](QUICKSTART_BUILD.md)** - Guia rápido de build

### Para testar:

3. **[COMO_TESTAR_FEATURES.md](COMO_TESTAR_FEATURES.md)** - Como testar as features
4. **[GUIA_TESTE_SEM_CONFLITO.md](GUIA_TESTE_SEM_CONFLITO.md)** - Testar sem conflitar com instalação global

### Para entender o projeto:

5. **[IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md)** - Resumo da implementação
6. **[QUICKSTART_ADVANCED_FEATURES.md](QUICKSTART_ADVANCED_FEATURES.md)** - Features avançadas

## ⚠️ Importante

### Arquivos da Aplicação

Os arquivos da aplicação original **NÃO** foram movidos para esta pasta e devem permanecer em suas localizações originais:

- `packages/` - Código fonte
- `tests-manual/` - Testes manuais
- `examples/` - Exemplos

**Motivo:** O repositório mantém sincronização com o repo original do Qwen-Code.

### Esta Pasta (docs-dev/)

Contém **apenas**:

- ✅ Documentação de desenvolvimento
- ✅ Scripts de build e teste
- ✅ Guias e tutoriais
- ✅ Registros de implementação

## 🎯 Estrutura do Projeto

```
qwen-code/
├── packages/
│   ├── core/src/
│   │   ├── agents/          # Sistema de agentes (NOVO)
│   │   ├── autonomy/        # Capacidades autônomas (NOVO)
│   │   ├── intelligence/    # Recursos de inteligência (NOVO)
│   │   ├── planning/        # Sistema de planejamento (NOVO)
│   │   └── robustness/      # Controle de qualidade (NOVO)
│   └── cli/
├── tests-manual/            # Testes manuais (NOVO)
├── examples/                # Exemplos de uso (NOVO)
└── docs-dev/                # Documentação e scripts (ESTA PASTA)
    ├── README.md
    ├── INICIO_RAPIDO.md     # Este arquivo
    ├── build-and-test.sh    # Script principal
    └── [demais .md files]
```

## 🛠️ Workflow de Desenvolvimento

```bash
# 1. Fazer modificações no código
vim packages/core/src/...

# 2. Rebuild
cd docs-dev
./build-and-test.sh build

# 3. Testar
./build-and-test.sh test

# 4. Testar CLI local
./qwen-dev.sh 'seu comando aqui'

# 5. Comparar com versão instalada
qwen --version                    # Versão instalada (não afetada)
./qwen-dev.sh --version           # Versão em desenvolvimento
```

## 🔄 Comparação de Versões

```bash
# Versão instalada globalmente (não afetada)
qwen --version
qwen 'Liste arquivos'

# Versão em desenvolvimento (local)
cd docs-dev
./qwen-dev.sh --version
./qwen-dev.sh 'Liste arquivos'
```

## 💡 Dicas

1. **Sempre use o wrapper** `qwen-dev.sh` para testar a versão local
2. **Não use npm link** a menos que seja absolutamente necessário
3. **Execute os testes** após qualquer modificação
4. **Consulte a documentação** na pasta docs-dev quando precisar

## 🆘 Problemas Comuns

### CLI não compilada

```bash
cd docs-dev
./build-and-test.sh build
```

### Testes falhando

```bash
cd docs-dev
./build-and-test.sh clean
./build-and-test.sh
```

### Dependências desatualizadas

```bash
cd docs-dev
./build-and-test.sh clean
./build-and-test.sh install
```

## 📞 Ajuda

Para mais informações, consulte:

- [README.md](README.md) - Índice completo
- [GUIA_BUILD_E_TESTE_LOCAL.md](GUIA_BUILD_E_TESTE_LOCAL.md) - Guia detalhado
- [NOTA_IMPORTANTE_NPM_LINK.md](NOTA_IMPORTANTE_NPM_LINK.md) - Sobre npm link

---

**Última atualização:** 2026-02-17
