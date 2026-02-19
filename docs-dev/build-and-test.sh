#!/bin/bash
# Script automatizado para build e teste do Qwen-Code
# Uso: cd docs-dev && ./build-and-test.sh [opção]

# Removido 'set -e' para ter melhor controle de erros com verificações explícitas

# Cores para output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Guardar diretório do script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Função para print colorido
print_step() {
    echo -e "${BLUE}==>${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

# Banner
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║     QWEN-CODE BUILD & TEST AUTOMATION               ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Verificar Node.js version
print_step "Verificando Node.js version..."
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    print_error "Node.js 20+ é necessário. Versão atual: $(node -v)"
    exit 1
fi
print_success "Node.js $(node -v) OK"

# Verificar npm
print_step "Verificando npm..."
if ! command -v npm &> /dev/null; then
    print_error "npm não encontrado. Por favor instale Node.js com npm."
    exit 1
fi
print_success "npm $(npm -v) OK"

# Função para instalar dependências
install_deps() {
    print_step "Instalando dependências..."
    cd "$PROJECT_ROOT"

    if [ ! -f "package.json" ]; then
        print_error "package.json não encontrado no diretório raiz"
        return 1
    fi

    # Instalar dependências normalmente
    # Fix: ansi-regex override em package.json garante compatibilidade ESM/CJS
    if npm install; then
        print_success "Dependências instaladas"
    else
        print_error "Falha ao instalar dependências"
        return 1
    fi
}

# Função para build do Core
build_core() {
    local skip_typecheck="${1:-false}"

    if [ "$skip_typecheck" = "true" ]; then
        print_step "Compilando Core (TypeScript → JavaScript, pulando typecheck)..."
    else
        print_step "Compilando Core (TypeScript → JavaScript)..."
    fi

    cd "$PROJECT_ROOT/packages/core"

    if [ ! -f "package.json" ]; then
        print_error "package.json não encontrado em packages/core"
        return 1
    fi

    # Limpar dist anterior para garantir build limpo
    rm -rf dist

    # Se pular typecheck, usar tsc --noCheck diretamente
    if [ "$skip_typecheck" = "true" ]; then
        print_warning "Pulando verificação de tipos (use apenas para desenvolvimento rápido)"

        # Compilar sem verificação de tipos
        if npx tsc --noCheck; then
            # Copiar arquivos .md e .json
            node ../../scripts/copy_files.js 2>/dev/null || true
            # Criar marcador
            mkdir -p dist
            touch dist/.last_build

            print_success "Core compilado (sem typecheck)"

            # Verificar se o build gerou arquivos
            if [ -d "dist" ] && [ "$(ls -A dist 2>/dev/null)" ]; then
                print_success "Arquivos compilados em packages/core/dist/"
            else
                print_warning "Pasta dist criada mas pode estar vazia"
            fi
        else
            print_error "Falha ao compilar Core (mesmo sem typecheck)"
            return 1
        fi
    else
        # Build normal com typecheck
        if npm run build; then
            print_success "Core compilado"

            # Verificar se o build gerou arquivos
            if [ -d "dist" ] && [ "$(ls -A dist 2>/dev/null)" ]; then
                print_success "Arquivos compilados em packages/core/dist/"
            else
                print_warning "Pasta dist criada mas pode estar vazia"
            fi
        else
            print_error "Falha ao compilar Core"
            echo ""
            print_warning "Dica: Use './build-and-test.sh build-fast' para pular typecheck"
            return 1
        fi
    fi
}

# Função para build da CLI
build_cli() {
    local skip_typecheck="${1:-false}"

    if [ "$skip_typecheck" = "true" ]; then
        print_step "Compilando CLI (pulando typecheck)..."
    else
        print_step "Compilando CLI..."
    fi

    if [ ! -d "$PROJECT_ROOT/packages/cli" ]; then
        print_warning "Diretório packages/cli não encontrado, pulando..."
        return 0
    fi

    cd "$PROJECT_ROOT/packages/cli"

    if [ -f "package.json" ] && grep -q '"build"' package.json; then
        # Limpar dist anterior
        rm -rf dist

        # Se pular typecheck, usar tsc --noCheck diretamente
        if [ "$skip_typecheck" = "true" ]; then
            print_warning "Pulando verificação de tipos"

            # Build assets primeiro (se existir o script)
            if grep -q '"build:assets"' package.json; then
                npm run build:assets 2>/dev/null || true
            fi

            # Compilar sem verificação de tipos
            if npx tsc --noCheck; then
                # Copiar arquivos
                node ../../scripts/copy_files.js 2>/dev/null || true
                # Criar marcador
                mkdir -p dist
                touch dist/.last_build

                print_success "CLI compilada (sem typecheck)"
            else
                print_error "Falha ao compilar CLI"
                return 1
            fi
        else
            # Build normal
            if npm run build; then
                print_success "CLI compilada"
            else
                print_error "Falha ao compilar CLI"
                echo ""
                print_warning "Dica: Use './build-and-test.sh build-fast' para pular typecheck"
                return 1
            fi
        fi

        # Verificar se o build gerou arquivos
        if [ -d "dist" ] && [ -f "dist/index.js" ]; then
            print_success "CLI pronta em packages/cli/dist/index.js"
        else
            print_warning "Build completou mas dist/index.js não foi encontrado"
        fi
    else
        print_warning "CLI não tem script de build, pulando..."
    fi
}

# Função para rodar testes
run_tests() {
    print_step "Rodando testes dos módulos novos..."
    cd "$PROJECT_ROOT"

    # Verificar se tsx está disponível
    if ! command -v npx &> /dev/null; then
        print_error "npx não encontrado. Instale Node.js com npm."
        return 1
    fi

    # Verificar se o diretório de testes existe
    if [ ! -d "tests-manual" ]; then
        print_warning "Diretório tests-manual não encontrado. Pulando testes..."
        return 0
    fi

    # Verificar se o Core foi compilado
    if [ ! -d "packages/core/dist" ] || [ ! "$(ls -A packages/core/dist 2>/dev/null)" ]; then
        print_error "Core não foi compilado. Execute o build primeiro."
        return 1
    fi

    # Verificar se tsx está disponível localmente
    if ! npx tsx --version &> /dev/null; then
        print_warning "tsx não encontrado. Instalando..."
        npm install --no-save tsx
    fi

    local test_failed=0

    echo ""
    echo "📋 Teste 1/3: Import Verification"
    if [ -f "tests-manual/test-simple.ts" ]; then
        if npx tsx tests-manual/test-simple.ts; then
            print_success "Teste de imports passou"
        else
            print_error "Teste de imports falhou"
            test_failed=1
        fi
    else
        print_warning "Arquivo tests-manual/test-simple.ts não encontrado"
    fi

    echo ""
    echo "📋 Teste 2/3: Knowledge Graph"
    if [ -f "tests-manual/test-knowledge-graph.ts" ]; then
        if npx tsx tests-manual/test-knowledge-graph.ts; then
            print_success "Teste do Knowledge Graph passou"
        else
            print_error "Teste do Knowledge Graph falhou"
            test_failed=1
        fi
    else
        print_warning "Arquivo tests-manual/test-knowledge-graph.ts não encontrado"
    fi

    echo ""
    echo "📋 Teste 3/3: Quality Monitor"
    if [ -f "tests-manual/test-quality-monitor.ts" ]; then
        if npx tsx tests-manual/test-quality-monitor.ts; then
            print_success "Teste do Quality Monitor passou"
        else
            print_error "Teste do Quality Monitor falhou"
            test_failed=1
        fi
    else
        print_warning "Arquivo tests-manual/test-quality-monitor.ts não encontrado"
    fi

    if [ $test_failed -eq 1 ]; then
        print_error "Alguns testes falharam"
        return 1
    fi

    print_success "Todos os testes disponíveis passaram"
    return 0
}

# Função para criar wrapper seguro (sem npm link)
setup_safe_wrapper() {
    print_step "Criando wrapper seguro (sem conflitar com qwen instalado)..."
    cd "$SCRIPT_DIR"

    cat > qwen-dev.sh << 'EOF'
#!/bin/bash
# Wrapper para testar a CLI local sem conflitar com instalação global
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Verificar se a CLI foi compilada
if [ ! -f "packages/cli/dist/index.js" ]; then
    echo "❌ CLI não compilada!"
    echo "Execute: cd docs-dev && ./build-and-test.sh build"
    exit 1
fi

# Executar a CLI local
node packages/cli/dist/index.js "$@"
EOF

    chmod +x qwen-dev.sh

    print_success "Wrapper criado: ./docs-dev/qwen-dev.sh"
    echo ""
    echo "  ✅ Seu 'qwen' instalado NÃO foi afetado!"
    echo "  ✅ Use 'cd docs-dev && ./qwen-dev.sh' para testar a versão local"
    echo ""
}

# Função para setup local da CLI (OPCIONAL - requer confirmação)
setup_local_cli_link() {
    print_warning "⚠️  ATENÇÃO: npm link vai sobrescrever o comando 'qwen' global!"
    echo ""
    read -p "Tem certeza que quer fazer npm link? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        print_step "Configurando CLI local (npm link)..."
        cd "$PROJECT_ROOT/packages/cli"
        npm link
        print_success "CLI linkada globalmente. Use 'qwen' para testar."
        echo ""
        print_warning "Para reverter: cd packages/cli && npm unlink"
    else
        print_step "npm link cancelado. Usando wrapper ao invés..."
        setup_safe_wrapper
    fi
}

# Função para verificar saúde do build
check_build_health() {
    print_step "Verificando saúde do build..."

    local issues=0

    # Verificar node_modules
    if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
        print_error "node_modules não encontrado"
        issues=$((issues + 1))
    else
        print_success "node_modules presente"
    fi

    # Verificar Core build
    if [ -d "$PROJECT_ROOT/packages/core/dist" ] && [ "$(ls -A $PROJECT_ROOT/packages/core/dist 2>/dev/null)" ]; then
        print_success "Core compilado (packages/core/dist/)"
    else
        print_error "Core não compilado"
        issues=$((issues + 1))
    fi

    # Verificar CLI build
    if [ -f "$PROJECT_ROOT/packages/cli/dist/index.js" ]; then
        print_success "CLI compilada (packages/cli/dist/index.js)"
    else
        print_warning "CLI não compilada ou não encontrada"
    fi

    # Verificar arquivos de teste
    local test_files=("test-simple.ts" "test-knowledge-graph.ts" "test-quality-monitor.ts")
    local found_tests=0
    for test_file in "${test_files[@]}"; do
        if [ -f "$PROJECT_ROOT/tests-manual/$test_file" ]; then
            found_tests=$((found_tests + 1))
        fi
    done

    if [ $found_tests -eq 3 ]; then
        print_success "Todos os arquivos de teste encontrados"
    elif [ $found_tests -gt 0 ]; then
        print_warning "Apenas $found_tests/3 arquivos de teste encontrados"
    else
        print_warning "Nenhum arquivo de teste encontrado"
    fi

    if [ $issues -gt 0 ]; then
        echo ""
        print_error "$issues problema(s) detectado(s). Execute o build completo primeiro."
        return 1
    else
        echo ""
        print_success "Build saudável e pronto para testes!"
        return 0
    fi
}

# Função para verificar instalação
verify_installation() {
    print_step "Verificando instalação..."

    echo ""
    # Verificar wrapper local
    if [ -f "$SCRIPT_DIR/qwen-dev.sh" ]; then
        print_success "Wrapper local disponível: ./docs-dev/qwen-dev.sh"
        echo ""
        echo "Teste:"
        echo "  cd docs-dev && ./qwen-dev.sh --version"
    fi

    # Verificar qwen global (instalação original)
    if command -v qwen &> /dev/null; then
        echo ""
        print_success "CLI global (qwen) disponível"
        qwen --version
    else
        print_warning "Nenhum 'qwen' instalado globalmente"
    fi
}

# Função para limpar build
clean_build() {
    print_step "Limpando builds anteriores..."
    cd "$PROJECT_ROOT"
    rm -rf packages/core/dist
    rm -rf packages/cli/dist
    rm -rf node_modules
    rm -rf packages/*/node_modules
    print_success "Build limpo"
}

# Função para build completo
full_build() {
    local skip_typecheck="${1:-false}"

    if [ "$skip_typecheck" = "true" ]; then
        print_step "Iniciando build completo (modo rápido, sem typecheck)..."
    else
        print_step "Iniciando build completo..."
    fi

    if ! install_deps; then
        print_error "Erro ao instalar dependências"
        return 1
    fi

    if ! build_core "$skip_typecheck"; then
        print_error "Erro ao compilar Core"
        return 1
    fi

    if ! build_cli "$skip_typecheck"; then
        print_error "Erro ao compilar CLI"
        return 1
    fi

    if [ "$skip_typecheck" = "true" ]; then
        print_success "Build completo finalizado (sem typecheck)"
        print_warning "LEMBRE-SE: Este build pulou verificação de tipos! Use './build-and-test.sh build' para um build completo."
    else
        print_success "Build completo finalizado"
    fi
}

# Função para workflow completo
full_workflow() {
    print_step "Iniciando workflow completo (clean → install → build → test → setup)..."
    echo ""

    local start_time=$(date +%s)

    # Fase 1: Limpeza
    if ! clean_build; then
        print_error "Erro ao limpar build"
        return 1
    fi

    # Fase 2: Instalação
    if ! install_deps; then
        print_error "Erro ao instalar dependências"
        echo ""
        print_warning "Dica: Verifique sua conexão com a internet e tente novamente"
        return 1
    fi

    # Fase 3: Build Core
    if ! build_core; then
        print_error "Erro ao compilar Core"
        echo ""
        print_warning "Dica: Verifique se há erros de TypeScript no código"
        return 1
    fi

    # Fase 4: Build CLI
    if ! build_cli; then
        print_error "Erro ao compilar CLI"
        echo ""
        print_warning "Dica: Verifique se o Core foi compilado corretamente"
        return 1
    fi

    # Fase 5: Verificar saúde do build
    echo ""
    if ! check_build_health; then
        print_warning "Build completou mas há problemas detectados"
    fi

    # Fase 6: Testes (não param o workflow se falharem)
    echo ""
    local tests_passed=true
    if ! run_tests; then
        print_warning "Alguns testes falharam, mas continuando..."
        tests_passed=false
    fi

    # Fase 7: Setup
    echo ""
    setup_safe_wrapper
    verify_installation

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    echo ""
    echo "╔══════════════════════════════════════════════════════╗"
    echo "║           BUILD E TESTE CONCLUÍDOS                   ║"
    echo "╚══════════════════════════════════════════════════════╝"
    echo ""
    print_success "Qwen-Code está pronto para uso! (Tempo: ${duration}s)"
    echo ""

    if [ "$tests_passed" = false ]; then
        print_warning "⚠️  Alguns testes falharam. Revise os logs acima."
        echo ""
    fi

    echo "✅ Sua instalação global do 'qwen' NÃO foi afetada!"
    echo ""
    echo "Próximos passos:"
    echo "  1. Testar versão local: cd docs-dev && ./qwen-dev.sh --version"
    echo "  2. Ver ajuda: cd docs-dev && ./qwen-dev.sh --help"
    echo "  3. Testar: cd docs-dev && ./qwen-dev.sh 'Liste os arquivos TypeScript'"
    echo ""
    echo "  Comandos úteis:"
    echo "  • ./build-and-test.sh health     (verificar saúde do build)"
    echo "  • ./build-and-test.sh test       (apenas rodar testes)"
    echo "  • ./build-and-test.sh build      (apenas rebuildar)"
    echo ""
    echo "  Comparar com produção:"
    echo "  • qwen --version                           (versão instalada)"
    echo "  • cd docs-dev && ./qwen-dev.sh --version   (versão em desenvolvimento)"
    echo ""

    return 0
}

# Parse argumentos
case "$1" in
    "clean")
        clean_build
        ;;
    "install")
        install_deps
        ;;
    "build")
        full_build false
        ;;
    "build-fast"|"fast")
        print_warning "⚠️  Modo rápido: Pulando verificação de tipos"
        echo ""
        full_build true
        ;;
    "core")
        build_core false
        ;;
    "core-fast")
        build_core true
        ;;
    "cli")
        build_cli false
        ;;
    "cli-fast")
        build_cli true
        ;;
    "test")
        run_tests
        ;;
    "wrapper")
        setup_safe_wrapper
        verify_installation
        ;;
    "link")
        setup_local_cli_link  # Agora pede confirmação
        verify_installation
        ;;
    "health")
        check_build_health
        ;;
    "verify")
        verify_installation
        ;;
    "full"|"")
        full_workflow
        ;;
    "help"|"-h"|"--help")
        echo "Uso: cd docs-dev && ./build-and-test.sh [opção]"
        echo ""
        echo "Opções:"
        echo "  (vazio)      Executa workflow completo (recomendado)"
        echo "  full         Mesmo que vazio"
        echo "  clean        Limpa builds anteriores"
        echo "  install      Instala dependências"
        echo "  build        Build completo (Core + CLI) com typecheck"
        echo "  build-fast   Build completo SEM typecheck (mais rápido)"
        echo "  core         Build apenas do Core"
        echo "  core-fast    Build Core sem typecheck"
        echo "  cli          Build apenas da CLI"
        echo "  cli-fast     Build CLI sem typecheck"
        echo "  test         Roda testes dos módulos novos"
        echo "  wrapper      Cria wrapper ./qwen-dev.sh (seguro, recomendado)"
        echo "  link         Configura CLI local (npm link - SOBRESCREVE qwen global!)"
        echo "  health       Verifica saúde do build (recomendado antes de test)"
        echo "  verify       Verifica instalação"
        echo "  help         Mostra esta ajuda"
        echo ""
        echo "Exemplos:"
        echo "  cd docs-dev && ./build-and-test.sh              # Workflow completo"
        echo "  cd docs-dev && ./build-and-test.sh build-fast   # Build rápido (sem typecheck)"
        echo "  cd docs-dev && ./build-and-test.sh test         # Apenas testes"
        echo "  cd docs-dev && ./build-and-test.sh health       # Verificar estado do build"
        echo ""
        echo "NOTA: Por padrão, este script NÃO usa npm link para não"
        echo "      sobrescrever sua instalação global do qwen."
        echo "      Use 'cd docs-dev && ./qwen-dev.sh' para testar a versão local."
        echo ""
        ;;
    *)
        print_error "Opção inválida: $1"
        echo "Use './build-and-test.sh help' para ver opções disponíveis"
        exit 1
        ;;
esac
