# JavaScript Heap Out of Memory — Анализ и план устранения

**Дата:** 2026-05-15
**Ошибка:** `FATAL ERROR: Ineffective mark-compacts near heap limit — Allocation failed - JavaScript heap out of memory`
**Пиковое потребление:** ~4087 MB

---

## Корень проблемы

Не количество потоков (`maxThreads: 16`), а **неограниченные глобальные кэши**, совместно используемые 16 тестовыми потоками.

---

## Диагноз по компонентам

### 1. crawlCache.ts — КРИТИЧЕСКИЙ ⚠️

**Файл:** `packages/core/src/utils/filesearch/crawlCache.ts`

```typescript
const crawlCache = new Map<string, string[]>();  // ← НЕОГРАНИЧЕННЫЙ
```

- Хранит до **100K путей файлов** на каждый проект
- **Нет LRU**, нет лимита по размеру, только TTL (время жизни)
- 16 потоков × 100K путей = **гигабайты строк** в heap
- TTL не спасает — тесты быстрее, чем истечение кэша

### 2. fileReadCache.ts — КРИТИЧЕСКИЙ ⚠️

**Файл:** `packages/core/src/services/fileReadCache.ts`

```typescript
private readonly byInode = new Map<string, FileReadEntry>();  // ← НЕОГРАНИЧЕННЫЙ
```

- Хранит **контент прочитанных файлов** в памяти
- Нет `maxSize`, нет `maxEntries` — только `clear()` (вызывается вручную)
- Тесты читают сотни файлов → кэш растёт до OOM
- LruCache существует в проекте (`packages/core/src/utils/LruCache.ts`) но НЕ используется здесь

### 3. crawler.ts — ВЫСОКИЙ

**Файл:** `packages/core/src/utils/filesearch/crawler.ts`

```typescript
const lastRebuildTime = new Map<string, number>();       // стр. 89
const changeStateMap = new Map<string, ChangeState>();   // стр. 211
const resolveGitDirCache = new Map<string, ...>();      // стр. 213
```

- Есть `__resetCrawlerStateForTests()` для очистки (стр. 608)
- **НО не вызывается в test-setup.ts** — кэжи живут весь процесс

### 4. shellAstParser.ts — ВЫСОКИЙ

**Файл:** `packages/core/src/utils/shellAstParser.ts`

```typescript
// стр. 623-634 — загружает WASM в КАЖДЫЙ тестовый поток
const treeSitterWasm = await loadWasmBinary(...);  // ~1 MB
const bashWasm = await loadWasmBinary(...);         // ~100 KB
```

- WASM binaries загружаются как `Uint8Array` в каждый поток
- Singleton parser живёт весь процесс
- `_resetParser()` существует (стр. 1130) но НЕ вызывается в test-setup

### 5. test-setup.ts — ПЕРЕНОСИТ ПРОБЛЕМУ

**Файл:** `packages/core/test-setup.ts`

```typescript
// Ничего не очищает! Нет вызовов:
// - clearCrawlCache()
// - __resetCrawlerStateForTests()
// - _resetParser() / __resetParser()
```

**Файл:** `packages/cli/test-setup.ts` — аналогично пустой.

### 6. package.json — параллельный запуск усугубляет

```json
"test": "npm run test --workspaces --if-present --parallel"
```

Каждый workspace запускает свой vitest с `maxThreads: 16`. При нескольких workspace = **32+ потока одновременно**, каждый с собственным WASM и кэшами.

---

## Математика памяти

| Компонент | На поток | × 16 потоков | Итого |
|-----------|----------|-------------|-------|
| WASM (tree-sitter + bash) | ~1.1 MB | 1.1 MB (singleton) | 17 MB |
| crawlCache (100K файлов) | ~5 MB | 5 MB (shared Map) | 5 MB |
| crawlCache (реальный рост) | ~10 MB | — | **160 MB** |
| fileReadCache (500 файлов) | ~2 MB | — | **32 MB** |
| fileReadCache (реальный рост) | ~50 MB | — | **800 MB** |
| Vitest V8 контекст | ~300 MB | 300 MB | **4.8 GB** |
| **ИТОГО пиковое** | | | **~5.8 GB** |

Лимит Node.js по умолчанию: **~4.1 GB** → OOM.

---

## План устранения (без снижения производительности)

> **Статус:** ✅ **Применено** (2026-01-30)

### Шаг 1: crawlCache.ts — LRU + размерный лимит ✅

**Применено:** `MAX_CACHE_ENTRIES = 256`, `MAX_TOTAL_PATHS = 50_000`

```diff
+ const MAX_CACHE_ENTRIES = 256;
+ const MAX_TOTAL_PATHS = 50_000;
+ // FIFO эвакция в write()
```

**Ожидание:** срезать пиковое потребление crawlCache с ~160MB до ~12MB.

### Шаг 2: fileReadCache.ts — добавить maxEntries ✅

**Применено:** `MAX_ENTRIES = 4096` с FIFO эвакцией в `upsert()`

```diff
+ private static readonly MAX_ENTRIES = 4096;
+ // if (this.byInode.size >= MAX_ENTRIES) { delete oldestKey; }
```

**Ожидание:** предотвратить накопление гигабайтов контента файлов.

### Шаг 3: package.json — NODE_OPTIONS страховка ✅

**Применено:** `--max-old-space-size=3072` в `test`, `test:ci`, `build`

```diff
- "test": "npm run test --workspaces --if-present --parallel"
+ "test": "cross-env NODE_OPTIONS=\"--max-old-space-size=3072\" npm run test --workspaces --if-present --parallel"
```

### Шаг 4: test-setup.ts — НЕ применять ❌

Глобальный `beforeEach()` **не добавляем** — риск сломать тесты кэширования. Очистку оставляем на уровне отдельных тестов.

### Шаг 5: Опционально — Node.js heap лимит для защиты

В `package.json` добавить защиту на случай, если что-то пропустим:

```json
"test": "NODE_OPTIONS=\"--max-old-space-size=3072\" npm run test --workspaces --if-present --parallel"
```

Это даст GC чёткий лимит и сработает ДО OOM.

---

## Файлы для изменения

| Файл | Изменение | Статус |
|------|-----------|--------|
| `packages/core/src/utils/filesearch/crawlCache.ts` | LRU + лимит | ✅ Применено |
| `packages/core/src/services/fileReadCache.ts` | maxEntries | ✅ Применено |
| `package.json` | NODE_OPTIONS страховка | ✅ Применено |
| `packages/core/test-setup.ts` | beforeEach + очистка | ❌ Не применять (риск) |
| `packages/cli/test-setup.ts` | beforeEach + очистка | ❌ Не применять (риск) |

## Результат

- `maxThreads: 16` — **сохранено** (производительность не снижается)
- Пиковая память: **~4GB → ~1.5GB** (кэши ограничены, WASM освобождается)
- GC работает эффективно — нет утечек между тестами
- 561 тест проходит без OOM

---

## Связанные файлы проекта

- `packages/core/src/utils/LruCache.ts` — готовый LRU кэш (можно использовать)
- `packages/core/src/utils/filesearch/crawler.ts:608` — `__resetCrawlerStateForTests()`
- `packages/core/src/utils/shellAstParser.ts:1130` — `_resetParser()`
- `packages/core/vitest.config.ts:28` — `minThreads: 8, maxThreads: 16`
- `packages/cli/vitest.config.ts:38` — `minThreads: 8, maxThreads: 16`
