# Blaze Runtime Local Stabilization Handoff

Этот документ является подробным промптом для следующего AI-агента.

Задача агента: стабилизировать и доказать локальный запуск `blaze-runtime serve`
на рабочем компьютере до перехода к sandbox. Не переходить к sandbox, пока
локальный запуск не доказан строго.

Модель-исполнитель может быть слабой, поэтому инструкция намеренно подробная.

## Контекст

В репозитории есть Blaze Runtime MVP:

```text
blaze-runtime serve
  -> HTTP daemon
      -> ACP bridge
          -> blaze-runtime --acp
              -> long-lived agent process
                  -> Nestor API
                      -> Qwen model
```

Цель Blaze Runtime MVP:

1. Убрать продуктовую зависимость Nessy Blaze от `nessy-cli`.
2. Иметь собственный runtime entrypoint: `blaze-runtime serve`.
3. Запускать один долгоживущий daemon на workspace.
4. Держать один долгоживущий ACP child, который не пересоздается на каждый prompt.
5. Ходить в Nestor/Qwen через `dp-auth`.
6. После стабильной локальной проверки перенести этот daemon в sandbox.

## Что сейчас не так с локальной проверкой

Локальный запуск мог быть фактически успешным, но текущий smoke-test отчет
доказывает не все, что он утверждает.

### Проблема 1. В отчет был вставлен реальный DP token

В smoke-test отчете нельзя хранить реальные значения:

```text
BLAZE_DP_TOKEN
DP_TOKEN
BLAZE_DP_JWT
NESSY_CLI_DP_AUTH_TOKEN
BLAZE_RUNTIME_TOKEN
```

Все секреты в документах и логах должны быть заменены на:

```text
<redacted>
<your-dp-token>
<runtime-token>
```

Если реальный токен уже попал в git, чат, CI logs или markdown-файл, его нужно
считать скомпрометированным и перевыпустить.

### Проблема 2. `POST /session/:id/prompt` не доказывает ответ модели

Актуальный код `packages/cli/src/serve/server.ts` возвращает из prompt route:

```json
{
  "promptId": "...",
  "lastEventId": 123
}
```

Это означает только:

```text
daemon принял prompt
daemon поставил prompt в очередь
daemon вернул id prompt-а
```

Это НЕ означает автоматически:

```text
prompt дошел до Nestor
Qwen ответил
agent loop завершился успешно
ответ был доставлен клиенту
контекст сохранился
```

Настоящее доказательство ответа модели нужно брать из SSE stream:

```text
GET /session/:id/events
```

Нужно увидеть реальные `session_update` events и/или текст ответа модели.

### Проблема 3. `lastEventId` был передан не тем способом

В текущей реализации server читает `Last-Event-ID` из HTTP header:

```text
Last-Event-ID: 0
```

Нельзя считать корректной проверкой вот такой URL:

```bash
/session/<sessionId>/events?lastEventId=0
```

Этот query-параметр не является источником `lastEventId` для текущего server
code. Если нужно replay с начала event ring, используй header:

```bash
curl -N -sS \
  -H "Authorization: Bearer $BLAZE_RUNTIME_TOKEN" \
  -H "X-Qwen-Client-Id: $CLIENT_ID" \
  -H "Last-Event-ID: 0" \
  "http://127.0.0.1:4170/session/$SESSION_ID/events?maxQueued=1024"
```

### Проблема 4. `retry: 3000` не доказывает agent loop

SSE stream всегда сначала пишет:

```text
retry: 3000
```

Это означает только, что SSE соединение открылось и server сообщил клиенту
reconnect delay. Это НЕ доказательство ответа модели.

Для доказательства нужны события вида:

```text
id: ...
event: session_update
data: ...
```

И в `data` нужно увидеть осмысленный ответ agent/model или хотя бы события,
которые показывают завершение turn-а без ошибки.

### Проблема 5. Рост `lastEventId` сам по себе не доказывает контекст

Если `lastEventId` вырос с 1 до 8, это говорит только о новых событиях в сессии.

Это слабое доказательство сохранения контекста.

Сильная проверка контекста:

1. Первый prompt просит модель запомнить кодовое слово.
2. Второй prompt в той же session спрашивает это кодовое слово.
3. В SSE response второго prompt есть правильное кодовое слово.
4. Daemon PID и ACP child PID не изменились между двумя prompt-ами.

## Что агент должен сделать

Агент должен воспроизвести локальную проверку заново и написать исправленный
отчет.

Не менять архитектуру.

Не начинать sandbox.

Не переписывать runtime.

Не переименовывать qwen internals.

Сначала только доказать локальный loop.

## Подготовка

Перейди в репозиторий:

```bash
cd /Users/s.salnikov/Documents/Developers/qwen-code
```

Проверь commit:

```bash
git rev-parse HEAD
git status --short --branch
```

Проверь версии:

```bash
node --version
npm --version
uname -a
```

Node должен быть `>=22`.

## Сборка

Выполни:

```bash
npm install
npm run build --workspace=packages/core
npm run build --workspace=packages/cli
npm run bundle
```

Проверь, что файл существует:

```bash
ls -la dist/blaze-runtime.js
```

## Чистый auth/cache test

`dp-auth` может читать cache:

```text
~/.blaze-runtime/dp_auth_creds.json
```

Legacy read-only fallback:

```text
~/.nessy/dp_auth_creds.json
```

Для чистой проверки желательно временно убрать cache, чтобы доказать, что
`BLAZE_DP_TOKEN` реально работает. Не удаляй бездумно. Сделай backup:

```bash
mkdir -p /tmp/blaze-runtime-local-run

if [ -f "$HOME/.blaze-runtime/dp_auth_creds.json" ]; then
  cp "$HOME/.blaze-runtime/dp_auth_creds.json" \
    "/tmp/blaze-runtime-local-run/dp_auth_creds.backup.json"
  mv "$HOME/.blaze-runtime/dp_auth_creds.json" \
    "$HOME/.blaze-runtime/dp_auth_creds.json.bak-local-smoke"
fi
```

Если после проверки нужно вернуть файл:

```bash
if [ -f "$HOME/.blaze-runtime/dp_auth_creds.json.bak-local-smoke" ]; then
  mv "$HOME/.blaze-runtime/dp_auth_creds.json.bak-local-smoke" \
    "$HOME/.blaze-runtime/dp_auth_creds.json"
fi
```

В отчете обязательно напиши, был ли cache очищен или проверка прошла на уже
существующем cache.

## Запуск daemon

Создай workspace и каталог для артефактов:

```bash
mkdir -p /tmp/blaze-runtime-workspace
mkdir -p /tmp/blaze-runtime-local-run
```

Задай переменные окружения:

```bash
export BLAZE_RUNTIME_TOKEN="local-dev-token"
export BLAZE_RUNTIME_ENTRY="$PWD/dist/blaze-runtime.js"
export BLAZE_DP_TOKEN="<your-dp-token>"
```

Не печатай реальный `BLAZE_DP_TOKEN`.

Запусти daemon:

```bash
node scripts/blaze-runtime-entry.js serve \
  --port 4170 \
  --hostname 127.0.0.1 \
  --workspace /tmp/blaze-runtime-workspace \
  --require-auth \
  2>&1 | tee /tmp/blaze-runtime-local-run/daemon.log
```

Этот процесс должен остаться живым.

В другом терминале выполняй проверки.

## Проверка health

Без токена:

```bash
curl -i http://127.0.0.1:4170/health
```

Ожидаемо:

```text
HTTP/1.1 401 Unauthorized
```

С токеном:

```bash
curl -i \
  -H "Authorization: Bearer local-dev-token" \
  http://127.0.0.1:4170/health
```

Ожидаемо:

```text
HTTP/1.1 200 OK
{"status":"ok"}
```

## Проверка preflight

```bash
curl -sS \
  -H "Authorization: Bearer local-dev-token" \
  http://127.0.0.1:4170/workspace/preflight \
  | tee /tmp/blaze-runtime-local-run/preflight.json \
  | jq .
```

Проверь:

```text
initialized = true
acpChannelLive = true
cli_entry.status = ok
cli_entry.detail.source = BLAZE_RUNTIME_ENTRY
auth.status = ok
auth.detail.source = dp-auth
auth.detail.presentVar = BLAZE_DP_TOKEN
```

Если `auth.status` не `ok`, не продолжай. Сначала разбери auth error.

## Создание session

```bash
CREATE_RESPONSE=$(
  curl -sS -X POST \
    -H "Authorization: Bearer local-dev-token" \
    -H "Content-Type: application/json" \
    -d '{}' \
    http://127.0.0.1:4170/session
)

echo "$CREATE_RESPONSE" \
  | tee /tmp/blaze-runtime-local-run/session-create.json \
  | jq .

export SESSION_ID=$(echo "$CREATE_RESPONSE" | jq -r '.sessionId')
export CLIENT_ID=$(echo "$CREATE_RESPONSE" | jq -r '.clientId')

echo "SESSION_ID=$SESSION_ID"
echo "CLIENT_ID=$CLIENT_ID"
```

Проверь:

```text
SESSION_ID is not null
CLIENT_ID is not null
attached = false или true допустимо, но объясни в отчете
```

## Проверка model/context

```bash
curl -sS \
  -H "Authorization: Bearer local-dev-token" \
  -H "X-Qwen-Client-Id: $CLIENT_ID" \
  "http://127.0.0.1:4170/session/$SESSION_ID/context" \
  | tee /tmp/blaze-runtime-local-run/session-context.json \
  | jq .
```

Проверь:

```text
currentModelId contains dp-auth
```

Например:

```text
tgpt/qwen3-next-80b-a3b-instruct(dp-auth)
```

## Правильная SSE подписка

Открой SSE stream ДО отправки prompt:

```bash
curl -N -sS \
  -H "Authorization: Bearer local-dev-token" \
  -H "X-Qwen-Client-Id: $CLIENT_ID" \
  -H "Last-Event-ID: 0" \
  "http://127.0.0.1:4170/session/$SESSION_ID/events?maxQueued=1024" \
  > /tmp/blaze-runtime-local-run/events.log &

export SSE_PID=$!
echo "SSE_PID=$SSE_PID"
sleep 1
```

Проверь, что stream открыт:

```bash
head -20 /tmp/blaze-runtime-local-run/events.log
```

В начале может быть только:

```text
retry: 3000
```

Это нормально, но этого недостаточно для успеха.

## Prompt 1: semantic memory setup

Отправь первый prompt:

```bash
PROMPT1_RESPONSE=$(
  curl -sS -X POST \
    -H "Authorization: Bearer local-dev-token" \
    -H "Content-Type: application/json" \
    -H "X-Qwen-Client-Id: $CLIENT_ID" \
    -d '{"prompt":[{"type":"text","text":"Remember this exact code word for the next message: ORBIT-17. Reply with OK only."}]}' \
    "http://127.0.0.1:4170/session/$SESSION_ID/prompt"
)

echo "$PROMPT1_RESPONSE" \
  | tee /tmp/blaze-runtime-local-run/prompt1-response.json \
  | jq .
```

Ожидаемо:

```json
{
  "promptId": "...",
  "lastEventId": 0
}
```

`lastEventId` может быть не `0`. Это нормально.

Главное: это еще не proof of model response.

Подожди события:

```bash
sleep 20
tail -200 /tmp/blaze-runtime-local-run/events.log
```

Нужно увидеть `session_update` events и признаки ответа модели.

## Prompt 2: semantic memory proof

Отправь второй prompt в ту же session:

```bash
PROMPT2_RESPONSE=$(
  curl -sS -X POST \
    -H "Authorization: Bearer local-dev-token" \
    -H "Content-Type: application/json" \
    -H "X-Qwen-Client-Id: $CLIENT_ID" \
    -d '{"prompt":[{"type":"text","text":"What exact code word did I ask you to remember? Answer with the code word only."}]}' \
    "http://127.0.0.1:4170/session/$SESSION_ID/prompt"
)

echo "$PROMPT2_RESPONSE" \
  | tee /tmp/blaze-runtime-local-run/prompt2-response.json \
  | jq .
```

Подожди события:

```bash
sleep 30
tail -300 /tmp/blaze-runtime-local-run/events.log
```

Сильное доказательство:

```text
events.log contains ORBIT-17 in the model response after prompt 2
```

Проверь:

```bash
grep -n "ORBIT-17" /tmp/blaze-runtime-local-run/events.log || true
grep -n "session_update" /tmp/blaze-runtime-local-run/events.log | tail -20
```

Если `ORBIT-17` есть только в отправленном prompt-е, но не в ответе модели,
это не доказательство контекста. Нужно внимательно посмотреть `data:` frames.

## Проверка long-lived process model

Пока daemon работает, проверь процессы:

```bash
ps aux | grep blaze-runtime | grep -v grep \
  | tee /tmp/blaze-runtime-local-run/processes.txt
```

Нужно увидеть:

```text
node scripts/blaze-runtime-entry.js serve
node --expose-gc dist/blaze-runtime.js serve
node --expose-gc dist/blaze-runtime.js --acp
```

Критически важно:

```text
ACP child должен быть blaze-runtime.js --acp
ACP child не должен быть qwen binary
ACP child PID не должен меняться между prompt 1 и prompt 2
```

Проверь daemon status:

```bash
curl -sS \
  -H "Authorization: Bearer local-dev-token" \
  http://127.0.0.1:4170/daemon/status \
  | tee /tmp/blaze-runtime-local-run/daemon-status.json \
  | jq .
```

Проверь:

```text
status = ok
security.tokenConfigured = true
security.requireAuth = true
runtime.channel.live = true
runtime.sessions.active >= 1
```

## Проверка daemon logs

Посмотри log:

```bash
tail -300 /tmp/blaze-runtime-local-run/daemon.log
```

Не должно быть:

```text
prompt turn failed
auth error
401 from Nestor
403 from Nestor
ModelConfigError
channel closed
ACP child exited
```

Должны быть признаки:

```text
prompt enqueued
prompt turn completed
```

Если таких строк нет, не придумывай успех. Приложи весь log.

## Как завершить локальный daemon

После проверки:

```bash
kill "$SSE_PID" 2>/dev/null || true
```

Daemon останови вручную через `Ctrl+C` в терминале, где он запущен.

Потом проверь:

```bash
ps aux | grep blaze-runtime | grep -v grep || true
```

## Какой отчет нужно написать

Создай или обнови отчет:

```text
docs/developers/blaze-runtime-local-smoke-test.md
```

Отчет должен содержать:

1. Git commit SHA.
2. Node/npm версии.
3. Команды сборки.
4. Команду запуска daemon без секретов.
5. Health result: 401 без токена, 200 с токеном.
6. Полный sanitized `/workspace/preflight`.
7. Session create response.
8. Session context response с `currentModelId`.
9. SSE subscription command с `Last-Event-ID: 0` header.
10. Prompt 1 response.
11. Prompt 2 response.
12. Фрагменты SSE events, которые доказывают реальный ответ модели.
13. Доказательство, что ответ второго prompt содержит `ORBIT-17`.
14. Process list до и после двух prompt-ов.
15. Daemon status.
16. Вывод: какие критерии прошли, какие нет.

Запрещено писать "все работает", если нет SSE evidence с ответом модели.

## Критерии стабильного локального запуска

Локальный запуск считается стабильным только если все пункты true:

1. `blaze-runtime serve` стартует без crash.
2. `/health` возвращает 401 без token и 200 с token.
3. `/workspace/preflight` показывает `auth.source = dp-auth`.
4. `/session` создает или attached-ит session.
5. `/session/:id/context` показывает модель с `(dp-auth)`.
6. SSE stream открыт через `GET /session/:id/events`.
7. Prompt route возвращает `202` с `promptId`.
8. SSE stream содержит реальные `session_update` events после prompt.
9. Второй prompt получает правильный ответ `ORBIT-17`.
10. Daemon PID сохраняется между prompt-ами.
11. ACP child PID сохраняется между prompt-ами.
12. Daemon log не содержит prompt/model/auth failure.
13. В отчете нет реальных токенов.

Если хотя бы один пункт не выполнен, локальный запуск еще не стабилен.

## Что делать при ошибках

### Если `/health` не отвечает

Проверить:

```bash
lsof -i :4170 || true
ps aux | grep blaze-runtime | grep -v grep || true
tail -200 /tmp/blaze-runtime-local-run/daemon.log
```

### Если `/workspace/preflight` показывает auth error

Проверить:

```text
BLAZE_DP_TOKEN is set, but do not print value
BLAZE_DP_JWT is unset unless intentionally used
BLAZE_NESTOR_SERVER_URL / BLAZE_NESTOR_BASE_URL overrides are correct
~/.blaze-runtime/dp_auth_creds.json state
```

Собрать sanitized error из preflight.

### Если prompt accepted, но нет SSE ответа

Не считать это успехом.

Проверить:

```bash
tail -300 /tmp/blaze-runtime-local-run/events.log
tail -300 /tmp/blaze-runtime-local-run/daemon.log
curl -sS -H "Authorization: Bearer local-dev-token" \
  http://127.0.0.1:4170/daemon/status | jq .
```

Убедиться, что SSE подписка использует:

```text
Header: Last-Event-ID: 0
```

а не:

```text
Query: ?lastEventId=0
```

### Если второй prompt не помнит `ORBIT-17`

Проверить:

```text
SESSION_ID same for both prompts
CLIENT_ID same for both prompts
ACP child PID did not change
prompt 1 completed before prompt 2
events.log actually contains assistant/model response for prompt 1
```

Если prompt 1 еще не завершился, второй prompt может быть queued. Нужно ждать
реального завершения первого turn-а.

## Не переходить к sandbox

Не писать новый sandbox Dockerfile.

Не публиковать npm package.

Не собирать sandbox image.

Не создавать sandbox.

Переход к sandbox разрешен только после commit-а, где локальный smoke report
доказывает все критерии стабильного локального запуска.
