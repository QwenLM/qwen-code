# Mod prompt.submit in headless runs

Design: [docs/design/2026-10-30-mod-prompt-submit.md](../../docs/design/2026-10-30-mod-prompt-submit.md).

## Setup

- Build the CLI and bundle it: `npm run build && npm run bundle`.
- Use an isolated `HOME` whose `.qwen/settings.json` sets `experimental.mods` to `true`, selects `openai` auth and points `OPENAI_BASE_URL` at a loopback OpenAI-compatible fixture that answers `OK` and records every request.
- Install a guard Mod with `qwen extensions install ./guard-mod --consent`. Its `hooks/register.js`:

```javascript
export function register(on) {
  on('prompt.submit', async ($, e, next) => {
    $.ui.log('submit:' + JSON.stringify(e));
    if (/AKIA[0-9A-Z]{16}/.test(e.text)) return { drop: 'the prompt holds an AWS access key' };
    if (e.text === 'boom') throw new Error('guard broke');
    if (e.text === 'mine') return { text: 'answered without next' };
    const entered = await next({
      ...e,
      text: e.text.replace(/\bprod\b/g, 'production'),
      context: [
        ...(e.context ?? []),
        e.text.startsWith('note') ? 'Mod note: ' + e.text : 'Mod context: <be brief>',
      ],
    });
    $.ui.log('entered:' + JSON.stringify(entered));
    return entered;
  }).catch(($, e, next) => (next.called ? next(e) : { drop: 'the guard failed' }));
  on('turn.start', ($, e, next) => {
    $.ui.log('turn.start:' + e.text);
    return next(e);
  });
}
```

## Test groups

### Rewrite and context

- `qwen -p 'deploy prod now' --output-format json`: exit 0. The model reads `deploy production now` followed by the hidden block `Mod context: &lt;be brief&gt;`. `turn.start` hears `deploy production now`. The transcript user record has `displayText: "deploy production now"` and the block as `hookContext`.

### Drop

- `qwen -p 'key AKIAABCDEFGHIJKLMNOP' --output-format json`: exit 1, no model request, error result `Prompt dropped by a hook: the prompt holds an AWS access key`.
- The same prompt in text output: exit 1, the reason on stderr.
- `-p boom`, where the guard throws and its `.catch` drops: exit 1, no model request, `Prompt dropped by a hook: the guard failed`.
- `-p mine`, where the guard answers without `next`: exit 1, no model request, `Prompt not submitted: a hook answered without passing the prompt on`.

### stream-json

- A message holding a key, then `ship prod`: the first message ends with the error result, the session goes on, and the second reaches the model as `ship production`.
- A message `[text 'ship prod', image block]`: the model reads `ship production` with the serialized image block after it, and the transcript `displayText` keeps the block after the rewritten text, the same shape it has without a rewrite.

### Context sent once per context

Add a settings `UserPromptSubmit` command hook that prints `settings-note`, then send `note one`, `note two`, `note two` in one stream-json session:

- `note one`: block `Mod note: note one\n\nsettings-note`.
- `note two`: block `Mod note: note two` only; the unchanged `settings-note` is not sent again.
- `note two` again: no block; both contexts are already in the conversation.

## Results (2026-11-02, branch head after merging main)

Built CLI, real fixture server, all groups above pass:

| Run | Result |
| --- | --- |
| rewrite (json) | exit 0, model reads `deploy production now` + context block, transcript `displayText` rewritten |
| drop (json / text) | exit 1, 0 model requests, drop reason as error result / on stderr |
| guard throws, `.catch` drops | exit 1, 0 model requests, `the guard failed` |
| answer without `next` | exit 1, 0 model requests, `Prompt not submitted: ...` |
| stream-json drop then rewrite | first message error, second sent as `ship production` |
| stream-json rewrite with an image block | transcript `displayText` = `ship production\n{"type":"image",...}` |
| context sent once per context | blocks `["Mod note: note one\n\nsettings-note"]`, `["Mod note: note two"]`, `[]` |

## Baseline

`main` at `619a601b39`, bundled locally, skips every `prompt.submit` hook at startup (`Hooks for unsupported events will not run: prompt.submit`): the key prompts reach the model with exit 0, and `turn.start` hears the original text. The global `qwen` 0.25.1 on this machine is a standalone binary, which the fixture driver (it starts the CLI with `node`) cannot run, so the baseline comes from the `main` bundle.
