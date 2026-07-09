# Protocol Tag Leak Tmux Mock Test

This scenario verifies that a streamed assistant response split across top-level protocol wrappers:

```text
<analysis>internal scratchpad that must not render</analysis><summary>VISIBLE_TMUX_SUMMARY_DONE</summary>
```

renders in the interactive TUI as only:

```text
VISIBLE_TMUX_SUMMARY_DONE
```

and never displays `<analysis>`, `</analysis>`, `<summary>`, `</summary>`, or the scratchpad text.

## Automated Regression

The checked-in automated coverage is:

```bash
npm run build && npm run bundle
cd integration-tests
npx vitest run fake-openai-server.test.ts --test-name-pattern "streams content chunks separately"
npx vitest run interactive/protocol-tags-interactive.test.ts --retry 0
cd ../packages/core
npx vitest run src/core/turn.test.ts --test-name-pattern "drops buffered protocol text"
```

The interactive test runs the built `dist/cli.js` through a PTY, points it at a fake OpenAI-compatible server, sends a real user prompt, waits for `VISIBLE_TMUX_SUMMARY_DONE`, and asserts that the rendered TUI output does not contain protocol tags or scratchpad text.

The focused `Turn` unit test simulates a retry event after the first attempt has buffered an `<analysis>` prefix, then verifies only the successful retry's unwrapped summary is emitted.

## Latest Tmux Evidence

The latest manual tmux replay report with screenshots is tracked in:

- [2026-07-09-protocol-tag-leak-tmux-report.md](./2026-07-09-protocol-tag-leak-tmux-report.md)

## Manual Tmux Recheck

Use this when a reviewer wants a readable tmux transcript attached to a PR review.

### 1. Build the local bundle

```bash
npm run build && npm run bundle
```

### 2. Start a deterministic fake OpenAI server

```bash
node <<'EOF' > /tmp/qwen-protocol-tags-server.log 2>&1 &
const http = require('node:http');
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404);
    res.end('not found');
    return;
  }

  req.resume();
  req.on('end', () => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const chunk = (delta, finish_reason = null, usage) => ({
      id: 'chatcmpl-protocol-tags-mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'fake-model',
      choices: [{ index: 0, delta, finish_reason }],
      ...(usage ? { usage } : {}),
    });
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send(chunk({ role: 'assistant' }));
    send(chunk({ content: '<analysis>internal scratchpad that must not render' }));
    send(chunk({ content: '</analysis><summary>VISIBLE_TMUX_SUMMARY_DONE' }));
    send(chunk({ content: '</summary>' }));
    send(chunk({}, 'stop', { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`BASE_URL=http://127.0.0.1:${port}/v1`);
});
EOF
FAKE_SERVER_PID=$!

FAKE_BASE_URL=""
for _ in $(seq 1 50); do
  FAKE_BASE_URL="$(sed -n 's/^BASE_URL=//p' /tmp/qwen-protocol-tags-server.log | tail -1)"
  [ -n "$FAKE_BASE_URL" ] && break
  sleep 0.1
done
test -n "$FAKE_BASE_URL"
echo "$FAKE_BASE_URL"
```

### 3. Start the TUI in tmux with readable snapshots

```bash
HELPER=.qwen/skills/tmux-real-user-testing/scripts/tmux-real-user-log.sh

eval "$(bash "$HELPER" start protocol-tags-mock . \
  node dist/cli.js \
    --no-chat-recording \
    --approval-mode yolo \
    --auth-type openai \
    --openai-api-key fake-key \
    --openai-base-url "$FAKE_BASE_URL" \
    --model fake-model)"

bash "$HELPER" wait-for "$SESSION" "$OUTDIR" "YOLO 模式|Type your message"
bash "$HELPER" snapshot "$SESSION" "$OUTDIR" "01 ready"

bash "$HELPER" type-submit "$SESSION" "Return the deterministic mock response."
bash "$HELPER" wait-for "$SESSION" "$OUTDIR" "VISIBLE_TMUX_SUMMARY_DONE"
bash "$HELPER" snapshot "$SESSION" "$OUTDIR" "02 visible summary"

bash "$HELPER" finish "$SESSION" "$OUTDIR"
```

### 4. Assert the captured TUI transcript

```bash
LOG="$OUTDIR/tmux-readable-full.log"
grep -q "VISIBLE_TMUX_SUMMARY_DONE" "$LOG"
! grep -E "</?analysis|</?summary|internal scratchpad" "$LOG"
```

Expected result:

- `tmux-readable-full.log` contains `VISIBLE_TMUX_SUMMARY_DONE`.
- `tmux-readable-full.log` does not contain protocol tags.
- `tmux-readable-full.log` does not contain `internal scratchpad`.

### 5. Retry variant

For retry evidence, replace the server in step 2 with this variant. It returns HTTP 500 for request #1 and streams the tagged chunks for request #2, so the server log proves an HTTP-level retry occurred.

```bash
node <<'EOF' > /tmp/qwen-protocol-tags-retry-server.log 2>&1 &
const http = require('node:http');
let requestCount = 0;
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404);
    res.end('not found');
    return;
  }

  const requestId = ++requestCount;
  console.log(`REQUEST #${requestId}`);
  req.resume();
  req.on('end', () => {
    if (requestId === 1) {
      console.log('RESPONSE #1 HTTP 500');
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'retry me' } }));
      return;
    }

    console.log('RESPONSE #2 HTTP 200 SSE');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const chunk = (delta, finish_reason = null, usage) => ({
      id: 'chatcmpl-protocol-tags-retry-mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'fake-model',
      choices: [{ index: 0, delta, finish_reason }],
      ...(usage ? { usage } : {}),
    });
    const send = (payload) => {
      console.log(JSON.stringify(payload));
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    send(chunk({ role: 'assistant' }));
    send(chunk({ content: '<analysis>internal scratchpad that must not render' }));
    send(chunk({ content: '</analysis><summary>VISIBLE_TMUX_SUMMARY_DONE' }));
    send(chunk({ content: '</summary>' }));
    send(chunk({}, 'stop', { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`BASE_URL=http://127.0.0.1:${port}/v1`);
});
EOF
FAKE_SERVER_PID=$!
```

Run the same tmux steps and additionally assert:

```bash
grep -q "RESPONSE #1 HTTP 500" /tmp/qwen-protocol-tags-retry-server.log
grep -q "REQUEST #2" /tmp/qwen-protocol-tags-retry-server.log
```

### 6. Cleanup

```bash
kill "$FAKE_SERVER_PID"
```

Keep the generated `tmp/protocol-tags-mock-tmux-*/tmux-readable-full.log` when attaching evidence to a PR review. It is the primary readable artifact; `tmux-final-capture.log` contains only the last frame.
