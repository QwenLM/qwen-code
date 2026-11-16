# Mod terminal rendering: the band above the prompt

[English](2026-10-26-mod-terminal-render.md) | [简体中文](2026-10-26-mod-terminal-render.zh-CN.md)

Status: proposed. This stage follows the turn events in #15443 and the 2.1.310 baseline in #15560, and is tracked in #13749. It follows the Claude Code 2.1.310 plugin API declarations of `ui.render`, `$.ui.resolve`, `$.ui.invalidate` and the `h` and `Fragment` globals, which are unchanged since 2.1.308 apart from image drawing.

## Problem and current behavior

Token Weather, the sample that marks the first milestone in #13749, draws a one-line forecast of the context window directly above the prompt: an icon, a word, the fill percentage, the token count and a chart of the last turns. It needs three things Qwen Code does not have:

- a `ui.render` hook on the `AbovePrompt` component, which returns a tree of `Box` and `Text` elements;
- `$.ui.resolve(e)`, which hands the hook those element constructors;
- `$.ui.invalidate("ui.render")`, which its `turn.complete` hook calls after each reading so the band redraws.

Everything else it uses, `session.start`, `turn.complete` and `$.session.usage()`, already runs. Today Qwen Code skips the `ui.render` hook at load with `Hooks for unsupported events will not run: ui.render`, and `$.ui.resolve` and `$.ui.invalidate` throw `Mod API not supported`. There is no host code that draws a tree a Mod returns.

## Goals and non-goals

Goals:

- Raise `ui.render` for the `AbovePrompt` site in the Ink terminal, with Claude Code's input, and draw the tree a hook returns.
- Give `$.ui.resolve(e)` the terminal's element table and draw its `Box` and `Text`. Provide the `h` and `Fragment` globals that Claude Code's element constructors and JSX use.
- Redraw the band on `$.ui.invalidate("ui.render")` and when the site's input changes.
- Judge a tree as Claude Code does, draw nothing for a tree that fails, and never make the prompt wait for a Mod.
- Run Token Weather unchanged.

Non-goals, each left to a later stage:

- The other fourteen render components, such as `Spinner`, `PromptHint`, `ToolUse` and `Pane`.
- The other terminal elements: `Button`, `Input`, `Select`, `Link`, `Code`, `Markdown`, `Client`, `Raster` and `Image`. With them come the `ui.press`, `ui.input`, `ui.select`, `ui.focus` and `ui.scroll` events, and the band's focus, collapse mark and scrolling.
- `ui.resolve` hooks, which restyle or withhold elements for other plugins.
- `$.state` and its redraw on write, and `$.clock.after` and `every`.
- JSX and `.tsx` entries. This stage provides `h` and `Fragment`; compiling JSX is the next step (see the PR plan).
- The OpenTUI terminal. Until its step lands, OpenTUI does not offer the site, and headless runs have no surface to draw on.

## Proposed changes

### 1. The site

The hook receives Claude Code's input for the band:

| Field               | Value in Qwen Code                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `surface`           | `"terminal"`                                                                                                                                            |
| `component`         | `"AbovePrompt"`                                                                                                                                         |
| `requestId`         | `"above-prompt"`, the one instance                                                                                                                      |
| `viewport`          | `{ columns, rows, isFullscreen }`: the terminal's size, and whether Ink draws on the alternate screen, the value `command.run`'s `presentation` carries |
| `props.hasSurvey`   | `true` while the session feedback survey shows above the prompt                                                                                         |
| `props.isWorking`   | `true` while a model turn runs                                                                                                                          |
| `props.maxRows`     | the rows the band may take: a third of the terminal's rows, at least 1                                                                                  |
| `props.bodyColumns` | the composer's width less 5 columns, the room Claude Code keeps for its collapse mark                                                                   |
| `props.scroll`      | `{ offset: 0, bodyRows: maxRows - 1 }`                                                                                                                  |
| `props.view`        | `{}`: the band is drawn only under the main conversation, never in an agent tab                                                                         |

`surface`, `component`, `requestId`, `viewport` and `props.view` are pinned: a rewrite that changes or drops them fails the hook. The other props keep their kind. `next(e)` resolves to the engine's own node, `{ type: "engine", ref: 0 }`, which draws nothing at this site. With no hook, or with every hook passing `next(e)` on, the band takes no rows.

### 2. When the band redraws

A render runs when the site's input changes, when the Mods load, and when a plugin asks:

- **The input key** is the viewport's `columns` and `isFullscreen` and the props, compared as stable JSON. A change of height alone runs nothing, unless it changes `maxRows`. A change of width or of `maxRows` runs once it has settled for 150 milliseconds, so a drag-resize runs one render.
- **The first render** runs after `session.start`, and again after a session switch (`/clear`, `/resume`, `/branch`), since the band's facts may differ.
- **`$.ui.invalidate("ui.render")`** asks for a redraw of every site the calling plugin's `ui.render` registrations may select. It returns at once. Qwen Code Mods have no timers yet, so the call comes from some other dispatch, such as `turn.complete`, and the render runs after that dispatch. Calls fold: a burst runs one render. Renders run at most every 34 milliseconds, Claude Code's rate for an expanded band. As in Claude Code, a plugin whose render takes longer than that drops to the steady rate, one render every 100 milliseconds, for the next second, so a hook that asks for its own redraw on every render cannot keep the dispatch queue busy. `$.ui.invalidate` for the cached events Claude Code also names, such as `prompt.section`, has nothing to drop in Qwen Code and does nothing.

Renders share the session's dispatch queue with commands, tool middleware and turn events, because the Mod worker runs one root at a time:

- The band keeps its last tree until a new answer lands. Before the first answer it draws nothing. The prompt never waits for a render.
- At most one render waits. A newer input replaces the waiting one.
- A render that is running is never cancelled to make way for a newer one. A cancel that the worker cannot settle within 250 milliseconds terminates it, which would end every Mod in the session. The newer render waits instead.
- A render that waits behind a tool call keeps waiting while that call runs and while its approval is open.

### 3. Elements, `h` and `Fragment`

`$.ui.resolve(e)` reads, without a dispatch, the element table of `e.surface`. It is a frozen object with no prototype. For the terminal it holds all eleven constructors Claude Code declares, so a Mod that destructures `Button` still loads. In this stage only `Box` and `Text` draw. A tree with any other element fails, with the reason `<Element> is not drawn by Qwen Code yet`. Any argument other than a `ui.render` input with a known surface throws.

A constructor takes the props, with `children` among them, and returns a deep-frozen plain-data element, as Claude Code's does:

- `{ type, props?, hover?, children? }`, with empty `props` and `children` left out;
- children flattened: `null`, `undefined` and booleans dropped, arrays spread, numbers turned into strings;
- `key` kept only on a `Box`, as a string;
- `hover` moved beside the props; it is checked, but this stage does not draw it.

`h(tag, props, ...children)` and `Fragment` are globals in each plugin's environment, as in Claude Code. `h` calls a function tag with its props and its children flattened, always an array, as Claude Code's `h` does. An unknown string tag throws Claude Code's message, `JSX element <X> is not an element: a render hook draws with the table $.ui.resolve(e) returns`. `Fragment` returns a column `Box` around its children.

### 4. Judging a tree

Each hook's answer is checked as that hook returned it, and the whole tree is checked again once the chain settles. One module in core does both checks, on the worker side and on the host side, with Claude Code's rules:

- the root is an element, not a string; at most 32 levels and 20,000 nodes;
- `Box` and `Text` take only Claude Code's props, each with its value rule: enumerations, numeric ranges, sizes as cells or percentages, spacing as cells or the steps `xs` to `xl`, and colors matching Claude Code's color pattern;
- `Text` holds strings and `Text`; a `Box` inside a `Text` fails;
- the engine node may sit in a plain `Box`, not in a `Text` and not under a `Box` that sets `display`, `overflow`, `position`, a size or an offset;
- no text holds a control character other than tab, line feed and carriage return.

A hook whose answer fails is skipped alone: its `.catch` runs, what it had from `next(e)` stands, or the next handler runs in its place. A final tree that fails draws nothing. An accepted tree is then adjusted as Claude Code adjusts it:

- a `Box` `key` that is not a string of 1 to 10,000 characters is dropped;
- a `borderStyle` the terminal lacks draws no border;
- texts past 100,000 characters in all are cut, ending `… <n> more characters, not drawn`; the cut never splits a surrogate pair.

The debug log records each refusal and adjustment in Claude Code's words, such as `<plugin>: ui.render hook skipped: returned the wrong shape (a tree AbovePrompt refuses: <reason>)` and `<plugin>: ui.render (AbovePrompt) refused: <reason>; nothing was drawn`. A refusal is recorded once per load and reason, and an adjustment once per load, site and kind, so a text cut whose length changes on each render is told once. Claude Code also shows these lines in the transcript, but only while it hot-reloads a plugin folder. Qwen Code has no hot reload yet, so they stay in the debug log.

### 5. Drawing in Ink

- **Place.** The band sits in the composer, between the session feedback survey and the prompt input, and shows only while the input does. A dialog that takes the composer's place hides it. Agent tabs, which use their own composer, do not show it.
- **Size.** The band is at most `maxRows` rows tall and clips a taller tree. It is laid out `bodyColumns` wide and clips horizontal overflow to the composer's width.
- **Mapping.** A `Box` becomes an Ink `Box` and a `Text` an Ink `Text`, with these conversions:
  - a string inside a `Box` is drawn as a `Text`;
  - text wrap values `end` and `middle` become `truncate-end` and `truncate-middle`;
  - spacing steps become cells: `xs` and `sm` are 1 across and 0 down, `md` 2 and 1, `lg` 3 and 1, `xl` 4 and 2;
  - `weight: "semibold"` or `"bold"` draws bold; `size`, `mono`, `tabular` and `dir` are dropped, as Claude Code's terminal drops them;
  - a color that is one of Claude Code's theme keys maps to the active Qwen Code theme: `text` to the primary text color, `subtle` and `inactive` to the secondary one, `success`, `error` and `warning` to the status colors, and `claude` and `suggestion` to the accent;
  - Claude Code's other theme keys, such as `permission` or `diffAdded`, draw in the default color in this stage;
  - any other color draws when Ink accepts it (a name or hex value) and otherwise draws in the default color;
  - all text is sanitized for the terminal, as Mod transcript lines are; tabs become spaces to the next 8-column stop, as Claude Code's Ink expands them.
- **Failures.** An error boundary wraps the band. A tree that throws while drawn shows nothing, and that answer is not drawn again. The next answer is drawn afresh.
- **Layout.** Ink measures the controls under the transcript to size the transcript's viewport. The band's height joins the inputs of that measurement, as the live agent panel's already does, so the alternate screen does not clip the prompt.
- **Wiring.** The interactive Mod session gains a small store of the band's last tree. The band reads it with `useSyncExternalStore`, and Ink reports the site's input to the session, which keys and queues the renders.

### 6. Which hosts raise the site

The `load` request names the render sites the host draws. Ink names `AbovePrompt`. OpenTUI and headless runs name none in this stage. The worker counts `ui.render` as supported only where a site is offered:

- Elsewhere a `ui.render` hook is skipped and listed in the startup line, as now.
- `$.session.version()` lists `ui.render` only where it runs.
- `$.ui.resolve` and `$.ui.invalidate` work everywhere, so a `turn.complete` hook that asks for a redraw does not fail in a host that draws nothing.

The load result tells the host whether any plugin hooks `ui.render`. Ink queues renders only then. `$.session.surfaces()` stays `["terminal"]` in both terminals.

## Design decisions

- **One site first.** `AbovePrompt` is the site Token Weather draws, and the engine draws nothing there, so `next(e)` is trivial. The whole path gets built and tested on it: dispatch, element model, validation, scheduling and drawing. Other sites then add props and an engine node.
- **A data tree, drawn by the host.** A Mod never touches Ink. Its answer crosses the worker boundary as JSON, under the existing size and depth limits, and the same tree can be drawn by OpenTUI later.
- **No cancel to supersede.** Claude Code aborts a stale render. In Qwen Code a cancel can terminate the worker and end every Mod in the session, so renders fold and wait.
- **Claude Code's whole validator, including what this stage does not draw.** For `Box` and `Text`, a tree Qwen Code accepts is one Claude Code accepts, and the reverse. A Mod tested here does not break there, and `hover` keeps validating when it starts to draw.
- **The host offers the site.** Ink and OpenTUI both report the `terminal` surface, so the support decision cannot come from the surface name. A capability in the `load` request lets each host offer the sites it draws.

## Differences from Claude Code

These go into the user guide:

- Only the `AbovePrompt` site is raised, and only in Ink. Elements other than `Box` and `Text` fail the tree.
- The band has no collapse mark, focus, scrolling or `n more` row. A tree taller than `maxRows` is clipped. `maxRows` is a third of the terminal's rows, where Claude Code gives the bottom slot's remaining rows in fullscreen and the terminal's height otherwise. `bodyColumns` keeps Claude Code's five-column reservation.
- `$.ui.invalidate` takes effect after the dispatch that called it, since Qwen Code Mods have no timers.
- A render can wait behind a tool call and its approval, and the band keeps its last tree meanwhile. A tool call, command or turn event queued behind a running render waits for it, up to 10 seconds for each `ui.render` hook in the chain.
- `ui.resolve` hooks are skipped as unsupported. `hover` is checked but not drawn.
- Refusal lines go only to the debug log, since Qwen Code has no hot reload.
- JSX is not compiled yet, although `h` and `Fragment` exist.

The Token Weather sample reads `e.hasSurvey` and `e.bodyColumns`, but Claude Code declares both under `e.props`. In Claude Code, as in Qwen Code, the sample therefore never yields to a survey and always lays out 80 columns. Qwen Code keeps Claude Code's input shape and adds no aliases.

## PR plan

1. **Core.** The `ui.render` root, `$.ui.resolve`, `$.ui.invalidate`, `h` and `Fragment`, the tree validator, the host capability in `load` and the load flag. No host offers a site yet, so nothing draws. Tests run the real worker.
2. **Ink.** Render scheduling in the Mod session, the store, the band in the composer, the layout input, and the user guide. Token Weather runs end to end.
3. **JSX.** `.tsx` and `.jsx` entries and imports, compiled with the `h` factory and `Fragment`.
4. **OpenTUI.** The same band, drawn from the same normalized tree.

Each step is a separate PR. Steps 3 and 4 can run in parallel after step 2.

## Validation and acceptance

- Real QuickJS worker tests:
  - the element table: frozen, eleven names, the other nine failing a tree with their reason;
  - constructors, children and keys, and `h` and `Fragment`;
  - each validation rule, with Claude Code's reason text;
  - a failed hook skipped with its `.catch` run, and a failed final tree;
  - the text cut, the dropped key and the `borderStyle` fallback;
  - `$.ui.invalidate` reaching the host after its dispatch;
  - `ui.render` supported only where a site is offered, in the startup line and in `$.session.version()`.
- Mod session tests:
  - a render on each kind of input change, and none on a change of height alone;
  - the 150-millisecond settle;
  - folding;
  - no cancel of a running render, and its order with tool roots;
  - a session switch, and closing the session;
  - a failed render drawing nothing.
- Ink tests:
  - the band above the prompt, hidden by dialogs and absent in agent tabs;
  - the mapping of props, spacing steps, theme keys and colors;
  - clipping at `maxRows`;
  - the error boundary;
  - the layout measurement including the band.
- The built CLI against a fixture server, with Token Weather installed unchanged:
  - Ink shows the forecast line above the prompt after the first reading, and redraws it after each turn;
  - a resize redraws it at the new width;
  - the survey sets `hasSurvey`;
  - headless and OpenTUI runs list `ui.render` in the startup line and otherwise work.

Acceptance: Token Weather's line shows in Ink with the icon, word, percentage, token count and chart that its screenshots show, and updates after each turn without delaying the prompt.

## Risks and open questions

- The band takes rows from the transcript. The cap of a third of the terminal keeps it small. Whether to match Claude Code's fullscreen slot more closely is open.
- A render that waits behind a long tool call leaves the band stale. That is acceptable for a band that changes per turn. Concurrent roots in the worker would lift it.
- A slow render hook delays the tool middleware queued behind it by up to 10 seconds for each `ui.render` hook in the chain.
- Whether refusal lines should also reach the transcript under `--debug`, since there is no hot reload to show them, is open.
