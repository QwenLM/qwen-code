# @qwen-code/chat-panel

The **one** chat panel — input composer + conversation flow — shared by all three
chat surfaces so a rendering change lands once and shows up everywhere:

- `@qwen-code/web-shell` (reference host)
- the VSCode webview (`@qwen-code/vscode-ide-companion`)
- the desktop app (`packages/desktop`, via a sync overlay)

Session management, navigation, and app shell stay **per-host** and are out of
scope. The panel is **props-driven**: each host maps its own data source (daemon
hooks / ACP) into the shared `Message[]` contract and injects values via the
context providers in `src/context.tsx` — the panel never calls
`daemon-react-sdk` itself.

## Status

Scaffold. See the convergence plan for the workstreams (WS0 daemon-decoupling →
WS1 carve → WS2 web-shell self-migrate → VSCode → desktop → rich-render parity)
and tracking issue **QwenLM/qwen-code#5883**.

Build mirrors web-shell's library build: `vite build --config vite.lib.config.ts`
(ES lib, self-injecting CSS Modules) + `tsc -p tsconfig.lib.json` for types.
