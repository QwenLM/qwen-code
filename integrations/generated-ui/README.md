# Generated UI

An optional private Qwen Code extension for complete, locally interactive views such as parameter simulations and weighted option comparisons. The model supplies HTML, CSS and JavaScript through `generated_ui_show`; the existing MCP Apps host displays the completed view. Each call creates an independent immutable card.

This is a restricted JavaScript environment with a small UI API. Layout is generated freely within the supported HTML/CSS subset; JavaScript executes in QuickJS in a dedicated Worker. Generated scripts never execute in the browser document. There is no browser DOM API, networking, imports, timers, filesystem access, MCP tool access, or message submission in generated code.

## Build and configure

Requires Node.js 22 or newer. From the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @qwen-code/generated-ui run build
```

Use Qwen Code's extension install/link command with this directory; check the installed CLI's `extensions --help`. The bundled stdio server needs no credentials, workspace cache or configuration environment variables. For another MCP host, configure `node /absolute/extension/dist/main.js`.

The package is private and is not automatically published. The packed extension includes the server, the fixed App HTML and its writer skill. Worker code and WASM are bundled as fixed compressed build data; the browser does not fetch a runtime or library from a CDN. The complete App HTML must fit the host's default 1 MiB resource limit.

## Document and UI API

Call `generated_ui_show` with exactly these five string fields:

| Field        | Meaning                                                    | Maximum characters |
| ------------ | ---------------------------------------------------------- | ------------------ |
| `title`      | A short visible title                                      | 120                |
| `summary`    | A useful standalone answer, initial result and assumptions | 2,000              |
| `html`       | HTML body content with stable element IDs                  | 12,000             |
| `css`        | Local styles                                               | 6,000              |
| `javascript` | Synchronous JavaScript using the API below                 | 12,000             |

The complete serialized tool result must also fit **24,000 characters and 24,000 UTF-8 bytes**, including JSON escaping, metadata and summaries. These are combined limits, not allowances to fill every field independently. Oversized documents are rejected without truncating their source.

HTML is sanitized before rendering and again for each HTML update. Use headings, paragraphs, lists, tables, labels, buttons, supported inputs and simple SVG. Give interactive elements unique IDs starting with an ASCII letter, followed only by letters, digits, underscores or hyphens, up to 64 characters. Supported controls are text/number/range/checkbox/radio inputs, selects and textareas. Keep scripts in `javascript` and styles in `css`. URLs, external resources, links, forms, embeds, event-handler attributes and active content are excluded. CSS cannot load external resources. The renderer bounds the document to 512 elements and 64 controls. Content renders in a frame that does not execute scripts.

| API                        | Behavior                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui.on(id, type, handler)` | Register an `input`, `change` or `click` handler for an existing element ID. The callback receives `{ id, type, value, checked }`, not a browser event. |
| `ui.input(id)`             | Read an input snapshot `{ value, checked }`. `value` is a string and `checked` is a boolean. Convert numbers explicitly.                                |
| `ui.text(id, text)`        | Replace an element's text with a string. Prefer this for values and user input.                                                                         |
| `ui.html(id, html)`        | Replace an element's inner HTML with a string, through the same sanitizer and document limits.                                                          |
| `ui.value(id, value)`      | Set an input's value to a string and update its value in the current input snapshot.                                                                    |

There is no `document`, `window`, `fetch`, `require`, module loader, timer or browser event object. Do not call `querySelector`, create script tags, use inline `onclick`, import a charting library, or assume `ui.html` can enable additional capabilities. Use local JavaScript calculations and render the resulting strings. Register handlers at initialization and calculate the initial display once.

Handlers run in order and read the currently displayed input values when dispatched. Rapid input events may be combined. An earlier `ui.value` response does not overwrite a newer queued user edit.

Each initialization or event has a 250 ms execution budget, a 32 MiB guest heap and a 256 KiB stack. A round can emit at most 64 patches. Input values have a 2,048-character limit; each complete input snapshot and patch batch must fit 16,000 characters and UTF-8 bytes. Register at most 192 distinct element/event pairs; registering the same pair replaces its handler. Startup and event watchdogs terminate an unresponsive Worker. These are guest execution limits; markup, CSS, input and output bounds separately limit renderer work. The Stop button ends the current activation. Errors preserve a readable summary and display the limitation.

## Complete examples

These values are illustrative assumptions, not measured system performance or product recommendations. Both objects are complete tool arguments and can be passed directly to `generated_ui_show`.

### Parameter simulation

Change arrivals, worker count or per-worker capacity. The calculation uses `capacity = workers × per-worker rate` and `utilization = arrivals / capacity`; it does not model queueing latency.

```json
{
  "title": "Queue capacity planner",
  "summary": "At the initial settings, 4 workers at 25 requests/s each provide an estimated 100 requests/s. With 80 arrivals/s, utilization is 80%. These are illustrative steady-state assumptions; queueing latency is not modeled.",
  "html": "<section><h2>Queue capacity</h2><p>Explore the supplied assumptions.</p><label for=\"arrivals\">Arrivals per second</label><input id=\"arrivals\" type=\"range\" min=\"0\" max=\"300\" value=\"80\"><label for=\"workers\">Workers</label><input id=\"workers\" type=\"number\" min=\"1\" max=\"20\" value=\"4\"><label for=\"rate\">Requests per second per worker</label><input id=\"rate\" type=\"number\" min=\"1\" max=\"100\" value=\"25\"><p id=\"capacity\"></p><p id=\"utilization\"></p><p id=\"balance\"></p><button id=\"recalculate\" type=\"button\">Recalculate</button></section>",
  "css": "section { padding: 16px; font-family: sans-serif; } label { display: block; margin-top: 12px; } input { max-width: 100%; } p { line-height: 1.5; }",
  "javascript": "function bounded(id,min,max){var value=Number(ui.input(id).value);return Number.isFinite(value)?Math.max(min,Math.min(max,value)):min;} function update(){var arrivals=bounded('arrivals',0,300);var capacity=bounded('workers',1,20)*bounded('rate',1,100);ui.text('capacity','Estimated capacity: '+capacity.toFixed(0)+' requests/s');ui.text('utilization','Estimated utilization: '+(100*arrivals/capacity).toFixed(1)+'%');ui.text('balance',arrivals<=capacity?'Estimated spare capacity: '+(capacity-arrivals).toFixed(0)+' requests/s':'Arrivals exceed capacity by '+(arrivals-capacity).toFixed(0)+' requests/s');} ['arrivals','workers','rate'].forEach(function(id){ui.on(id,'input',update);});ui.on('recalculate','click',update);update();"
}
```

### Weighted option comparison

Two fictional options are scored on responsiveness and operational simplicity, each on a 0–10 scale. Moving one weight keeps the combined weight at 100%. The ranking changes only with these explicit scores and weights.

```json
{
  "title": "Compare two operating plans",
  "summary": "Using illustrative scores and the initial 60% responsiveness / 40% simplicity weights, Plan A scores 7.0 and Plan B scores 7.2. Plan B ranks slightly higher under these assumptions. Change the weight to explore the tradeoff.",
  "html": "<section><h2>Operating plan comparison</h2><p>Illustrative scores; higher is better.</p><label for=\"weight\">Responsiveness weight</label><input id=\"weight\" type=\"range\" min=\"0\" max=\"100\" value=\"60\"><p id=\"weights\"></p><table><thead><tr><th>Plan</th><th>Responsiveness</th><th>Simplicity</th><th>Weighted score</th></tr></thead><tbody><tr><td>A</td><td>9</td><td>4</td><td id=\"score-a\"></td></tr><tr><td>B</td><td>6</td><td>9</td><td id=\"score-b\"></td></tr></tbody></table><p id=\"ranking\"></p></section>",
  "css": "section { padding: 16px; font-family: sans-serif; } table { border-collapse: collapse; width: 100%; } th,td { padding: 8px; text-align: left; border-bottom: 1px solid #999; } input { width: 100%; }",
  "javascript": "function update(){var raw=Number(ui.input('weight').value);var w=Number.isFinite(raw)?Math.max(0,Math.min(100,raw)):60;var a=(9*w+4*(100-w))/100;var b=(6*w+9*(100-w))/100;ui.text('weights','Responsiveness '+w+'%; simplicity '+(100-w)+'%');ui.text('score-a',a.toFixed(2));ui.text('score-b',b.toFixed(2));ui.html('ranking',a===b?'The plans are tied under these assumptions.':'<strong>Plan '+(a>b?'A':'B')+'</strong> ranks higher under these assumptions.');}ui.on('weight','input',update);update();"
}
```

## Replay and failure behavior

The server never executes the generated source or writes a document cache. It returns a versioned snapshot with a SHA-256 identity. Public text and structured output contain the title, summary and identity; source travels in the App-only result metadata. The readable fallback removes terminal control characters while preserving line breaks and tabs. Resource reads always return the fixed trusted bootstrap, independent of earlier show calls. The browser validates the complete snapshot and identity before execution.

Daemon/Web Shell history can replay the saved initial snapshot without fetching the generating MCP server again. Interaction state is local to one activation: refreshing or remounting starts from the saved initial values. Two cards remain independent, including two copies of the same document. A later show call does not update an earlier card. Stop remains terminal for the current activation, including if pressed before a result arrives; duplicate final notifications cannot restart it.

The existing host can degrade rich cards to their text fallback when history or delivery windows exceed their budgets. Terminal history does not retain interactive App payloads. A host without MCP Apps retains the readable summary. Missing Worker/WebAssembly/DecompressionStream support, invalid or dropped snapshot metadata, digest mismatch, invalid controls or exhausted runtime budgets produces a visible limitation instead of re-fetching or executing incomplete source. Unsupported markup is removed by the sanitizer. This extension does not promise streaming, saved interaction state or unlimited rich history.

## Verification

From this integration directory:

```sh
corepack pnpm run test
corepack pnpm run typecheck
```

The tests exercise producer bounds and identity, the actual bundled stdio server, fixed-resource behavior, independent snapshots, Unicode and escaping, and execution from a packed tarball outside the source tree. Browser/runtime and daemon acceptance must separately verify the displayed calculations, interaction, stop/timeout behavior and sandbox isolation. A valid document or a green protocol test does not establish that the generated model's assumptions or calculations are correct.
