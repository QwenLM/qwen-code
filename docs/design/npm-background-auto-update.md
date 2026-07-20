# Background npm updates

## Problem

The published CLI is code-split into content-hashed JavaScript chunks. Running
`npm install -g` from an active session replaces those chunks in place, so a
later dynamic import in the old process can fail with `ERR_MODULE_NOT_FOUND`.
Deferring the install until session exit avoids corruption, but turns a
background update into an exit-time delay and gives users no benefit until they
leave the session.

## Design

For writable global npm installations, the post-render update check installs
the exact resolved version under a directory derived from the global launcher:

```text
~/.qwen/updates/npm/<launcher-id>/versions/<version>/
```

The version check runs npm in its global context and the staged install uses an
empty prefix. Both bypass the current repository's `.npmrc` and inherit the
same environment and user/global npm configuration, so the version that was
checked is installed from the same configured registry.

The launcher resolves `QWEN_HOME` from the same home-scoped `.env` files before
selecting a version. This keeps the bootstrap path aligned with CLI storage even
though the full environment loader runs later.

After npm exits successfully, Qwen Code verifies the package name, version,
bundle, and launcher, then atomically writes an `active.json` pointer beside
that launcher's versions. The global npm package is not modified. The
already-running process continues loading its original package and chunks. On
the next invocation, the stable launcher reads the pointer and starts the
verified version directory.

Each global npm launcher has its own pointer and version payloads, so
installations under different npm or nvm prefixes can share `~/.qwen` without
overriding one another or sharing dependencies. A slower concurrent update
cannot replace a newer active version.

An incomplete install never changes the active pointer. Before activation, the
new launcher must report the expected version. A missing, malformed, or
launcher-mismatched pointer is ignored and the original npm package remains the
fallback. The pointer also records the base package and launcher identity, so a
later explicit global npm install supersedes the managed version.

Version directories are retained because an older live session may still load
from them. Cleanup is intentionally deferred until disk usage shows that a
lease-based collector is necessary.

## Scope

This changes automatic updates for npm installations only. Other package
managers and standalone archives keep the existing exit-safe behavior until
they have an equivalent immutable-version installation layout.
