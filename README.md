# PR #10024 — local validation screenshots

Captured on Linux against a real `qwen serve` daemon (built from the PR head)
serving the built Web Shell, driven by headless Chromium. Provider CLIs were
installed by the daemon's own setup route from the public npm registry
(wrangler 4.127.1, vercel 59.10.0, netlify-cli 27.4.1); the provider backends and
the public `*.pages.dev` / `*.vercel.app` / `*.netlify.app` hosts are local
stand-ins served over real HTTPS.

| file | what it shows |
| --- | --- |
| 01 | HTML artifact card exposing Download / Open / Share |
| 02 | Share dialog, Cloudflare ready, Details expanded |
| 03 | published artifact fetched anonymously over HTTPS (no daemon) |
| 04 | reopened dialog: existing publication, Open current / Publish again |
| 05 | artifact changed after publish: "Publish new version" |
| 06 | Cloudflare authorization: spinner, no URL and no browser window |
| 07 | Netlify authorization page opened from the dialog |
| 08 | Netlify authorization pending, dialog polling |
| 09 | Artifact sharing disabled: Share gone, Download kept |
| 10 | non-HTML artifact (CSV): no Share |
| 11 | Stop during authorization returns control |
