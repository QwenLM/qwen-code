---
name: auto-review
description: Автоматический code review для GitHub PR
author: AI Pair Programming Log
---

## Когда использовать

- После push в PR
- После получения уведомлений о review requests
- Когда пользователь просит "review PR #<number>"

## Что делает

1. Получает diff PR через GitHub API
2. Анализирует изменения на:
   - Баги и ошибки
   - Проблемы безопасности
   - Производительность
   - Стиль и best practices
3. Оставляет inline comments на проблемных строках
4. Генерирует summary review

## Как использовать

```
Примени skill: auto-review для PR #<number>
```

## Требования

- GitHub MCP с доступом к PR
- Токен с правами `read:org` и `public_repo`

## Алгоритм

### Шаг 1: Получение diff

```
GET /repos/{owner}/{repo}/pulls/{number}.diff
```

Или через MCP:

```
gh pr view <number> --json files
gh pr diff <number>
```

### Шаг 2: Анализ изменений

Для каждого изменённого файла:

1. **Баги и ошибки**
   - Null pointer / undefined access
   - Off-by-one errors
   - Race conditions
   - Resource leaks (file handles, connections)
   - Missing error handling

2. **Проблемы безопасности**
   - Hardcoded secrets/tokens
   - SQL injection vectors
   - XSS vulnerabilities
   - Insecure defaults
   - Missing input validation

3. **Производительность**
   - N+1 queries
   - Unnecessary allocations in loops
   - Missing indexes
   - Synchronous I/O в critical path
   - O(n²) или worse алгоритмы

4. **Стиль и best practices**
   - DRY violations
   - Magic numbers/strings
   - Missing type hints
   - Inconsistent naming
   - Overly complex functions (>50 lines)

### Шаг 3: Оставить review comments

Для каждой найденной проблемы:

```
POST /repos/{owner}/{repo}/pulls/{number}/comments
{
  "body": "**<severity>**: <description>\n\n**Рекомендация**: <как исправить>",
  "path": "<file_path>",
  "line": <line_number>,
  "side": "RIGHT"
}
```

Где `<severity>`: P0 (критично), P1 (высокий), P2 (средний), P3 (низкий)

### Шаг 4: Создать summary review

После всех inline comments создать summary:

```
POST /repos/{owner}/{repo}/issues/{number}/comments
```

Формат summary:

```markdown
# Code Review Summary

| Severity | Count |
| -------- | ----- |
| P0       | X     |
| P1       | X     |
| P2       | X     |
| P3       | X     |

## P0 (Критичные)

- `file.py:42`: Описание проблемы

## P1 (Высокие)

- `file.py:15`: Описание проблемы

## Рекомендации

- Общие замечания по архитектуре
- Предложения по улучшению

---

_Review выполнен автоматически через auto-review skill_
```

## Пример использования

```
Примени skill: auto-review для PR #42
```

Ожидаемый результат:

1. Получен diff PR #42
2. Проанализированы все изменённые файлы
3. Оставлены inline comments на проблемных строках
4. Создан summary comment с обзором всех замечаний

## Интеграция с протоколами

При анализе применять:

- **Self-Reflection**: После первичного анализа задать себе "Could you be wrong? Какие проблемы я пропустил?"
- **TRT**: Для сложных архитектурных решений — рассмотреть 3 варианта оценки
- **Salience Reminder**: Обрамлять ключевые критерии анализа в начале и конце промпта
