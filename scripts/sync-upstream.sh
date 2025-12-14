#!/bin/bash

# Скрипт для синхронизации с upstream репозиторием
# Использование: bash scripts/sync-upstream.sh

set -e

echo "🔄 Начинаем синхронизацию с upstream репозиторием..."
echo ""

# Цвета для вывода
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Проверяем чистоту рабочей директории
if ! git diff --quiet; then
    echo -e "${RED}❌ Ошибка: В рабочей директории есть несохранённые изменения${NC}"
    echo "Пожалуйста, закоммитьте или сбросьте изменения перед синхронизацией"
    exit 1
fi

echo -e "${YELLOW}📦 Сохраняем ваши локальные файлы...${NC}"
mkdir -p .backup-sync
cp -r README.md .backup-sync/ 2>/dev/null || true
cp -r docs/assets .backup-sync/ 2>/dev/null || true
echo -e "${GREEN}✓ Файлы сохранены${NC}"
echo ""

# Проверяем наличие upstream
if ! git remote get-url upstream > /dev/null 2>&1; then
    echo -e "${YELLOW}🔗 Добавляем upstream репозиторий...${NC}"
    git remote add upstream https://github.com/QwenLM/qwen-code.git
else
    echo -e "${GREEN}✓ Upstream уже добавлен${NC}"
fi
echo ""

echo -e "${YELLOW}⬇️  Получаем обновления из upstream...${NC}"
git fetch upstream main
echo -e "${GREEN}✓ Обновления получены${NC}"
echo ""

# Проверяем наличие различий
echo -e "${YELLOW}🔍 Проверяем различия...${NC}"
DIFF_COUNT=$(git diff --name-only main upstream/main 2>/dev/null | wc -l)

if [ "$DIFF_COUNT" -eq 0 ]; then
    echo -e "${GREEN}✓ Нет новых обновлений${NC}"
    echo "Ваш репозиторий синхронизирован с upstream"
    rm -rf .backup-sync
    exit 0
fi

echo -e "${YELLOW}📝 Найдено $DIFF_COUNT изменённых файлов${NC}"
git diff --name-only main upstream/main | head -20
if [ "$DIFF_COUNT" -gt 20 ]; then
    echo "... и ещё $((DIFF_COUNT - 20)) файлов"
fi
echo ""

# Запрашиваем подтверждение
echo -e "${YELLOW}❓ Продолжить синхронизацию?${NC}"
echo "  Будут сохранены: README.md, docs/assets/"
echo "  Остальные файлы будут обновлены из upstream"
read -p "Продолжить? (y/n) " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}❌ Синхронизация отменена${NC}"
    rm -rf .backup-sync
    exit 1
fi
echo ""

# Создаём ветку для слияния
echo -e "${YELLOW}🌿 Создаём временную ветку...${NC}"
if git rev-parse --verify sync-upstream > /dev/null 2>&1; then
    git branch -D sync-upstream
fi
git checkout -b sync-upstream
echo -e "${GREEN}✓ Ветка создана${NC}"
echo ""

# Сливаем с upstream
echo -e "${YELLOW}🔀 Сливаемся с upstream/main...${NC}"
if git merge -X theirs upstream/main --allow-unrelated-histories --no-commit 2>/dev/null || true; then
    echo -e "${GREEN}✓ Слияние выполнено${NC}"
else
    echo -e "${YELLOW}⚠️  Возможны конфликты слияния${NC}"
fi
echo ""

# Восстанавливаем локальные файлы
echo -e "${YELLOW}📁 Восстанавливаем локальные файлы...${NC}"
if [ -f ".backup-sync/README.md" ]; then
    cp .backup-sync/README.md README.md
    git add README.md
    echo -e "${GREEN}✓ README.md восстановлен${NC}"
fi

if [ -d ".backup-sync/assets" ]; then
    mkdir -p docs
    cp -r .backup-sync/assets docs/
    git add docs/assets/
    echo -e "${GREEN}✓ docs/assets/ восстановлены${NC}"
fi
echo ""

# Коммитим изменения
echo -e "${YELLOW}💾 Коммитим изменения...${NC}"
if git diff --cached --quiet; then
    echo -e "${YELLOW}⚠️  Нет изменений для коммита${NC}"
    git checkout main
    git branch -D sync-upstream
    rm -rf .backup-sync
    exit 0
fi

git commit -m "chore: sync with upstream QwenLM/qwen-code

Основные обновления:
- Синхронизация с официальным репозиторием
- Сохранены локальные файлы: README.md, docs/assets/
- Автоматическое обновление всех остальных файлов

Upstream: https://github.com/QwenLM/qwen-code"

echo -e "${GREEN}✓ Изменения закоммичены${NC}"
echo ""

# Показываем итоговую информацию
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Синхронизация успешно завершена!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo "Текущее состояние:"
echo -e "  Ветка: ${GREEN}$(git rev-parse --abbrev-ref HEAD)${NC}"
echo -e "  Коммит: $(git rev-parse --short HEAD)"
echo ""
echo "Следующие шаги:"
echo "  1. Проверьте изменения: git diff main..HEAD"
echo "  2. Если всё в порядке, слейте в main: git checkout main && git merge sync-upstream"
echo "  3. Отправьте изменения: git push origin main"
echo ""

# Чистим резервные копии
rm -rf .backup-sync

exit 0
