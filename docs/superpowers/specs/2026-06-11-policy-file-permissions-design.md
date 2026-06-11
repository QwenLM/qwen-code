# Cycle 48 — World-writable policy file warning (boot-time)

**Proposal:** `add-policy-engine` (design.md threat model, "File tamper by
non-daemon process" row: _"Daemon checks file mode at load (warns on
world-writable); fsnotify is a load trigger, not a trust signal. Operator must
control filesystem perms."_).

**Status:** light, additive, daemon-independent boot diagnostic. Spreads off
`add-session-forking` (cycle 47). Completes a named standalone spec item; the
remaining policy work (Phase-4 owner-broadcast SSE, a `policy reload` control
surface) is heavy and stays deferred.

## Deviation from the OpenSpec design

The design has the **daemon** check the policy file mode at load. We deliver the
same guarantee **gateway-side**, at `runServe` boot, for BOTH policy layers the
gateway already loads: the user file `~/.qwen/rc/policy.yaml` and the workspace
override `<workspaceCwd>/.qwen/policy.yaml`. The gateway owns policy loading
(cycle 38+), so this is the correct home. The check is purely advisory — it
NEVER changes whether the policy loads or how it evaluates; a world-writable
policy still loads (fail-closed parsing is unchanged). It only emits a
`console.warn` so the operator notices a tampering-exposed file.

## Decisions

1. **Mask = group OR world writable (`0o022`), not just world (`0o002`).** The
   spec says "world-writable", but a **group**-writable policy file is equally a
   non-owner-write exposure (another account in the file's group can rewrite your
   security policy). Warning on `mode & 0o022` is the strictly safer superset and
   matches the intent ("operator must control filesystem perms"). Documented so
   the broadened scope is explicit, not accidental.

2. **`console.warn` only — no new audit action.** This is a boot-time diagnostic
   about local filesystem hygiene, not a per-request security event. The audit
   log is request-oriented (token ids, scopes, decisions); a boot warning does
   not belong there. Keeping it to stderr also avoids enum churn. (If a durable
   record is wanted later, it is an additive follow-up.)

3. **ENOENT / any stat error -> NO warning (best-effort, never throws).** A
   missing policy file is the normal no-policy case (mirrors `loadPolicyFile`
   returning null on ENOENT). Any other stat failure (EACCES on the dir, etc.) is
   swallowed — a permission CHECK must never itself break boot. The pure function
   catches per-path and returns only the warnings it could compute.

4. **Pure `checkPolicyFilePermissions(paths, statFn?)` with injected stat.** The
   logic lives in a new pure module `policy/permissions.ts` and is unit-tested by
   injecting a fake `statFn` (no real `chmod`/root needed, works headless). It
   returns a `{ path, mode }[]` of offending files (mode = the low 12 perm bits)
   so the caller formats + warns. `runServe` is thin glue (stat the 2 paths,
   `console.warn` each) and is smoke-tested, never unit-tested.

5. **Report the basename + octal mode, never the full path's contents.** The
   warning names the file path (already non-secret — it is a fixed location) and
   the octal permission bits, nothing from inside the file.

## Behavior

```
At runServe boot, after the policy paths are known:
  for each of [ ~/.qwen/rc/policy.yaml, <cwd>/.qwen/policy.yaml ]:
    stat the file
      ENOENT / error  -> skip (no warning)
      (mode & 0o022)  -> console.warn(
        "policy: <path> is group/world-writable (mode 0<octal>) - "
      + "anyone with write access can alter your tool-permission policy; "
      + "run: chmod go-w <path>")
```

## Deferred (explicit)

- A durable audit record of the warning (decision 2 — additive follow-up).
- A world-writable _parent directory_ check (a `0700`-vs-file-mode mismatch can
  defeat a `0600` file). Spec scope is the file mode; dir-mode hardening is a
  separate, broader item.
- The routing config files (`routing.yaml`) — routing is fail-open/suppress-only
  (not a security control like policy), so a tampering warning is lower value;
  out of scope this slice.
- Refusing to load a world-writable policy (fail-closed-on-perms). The spec says
  "warn", not "refuse"; refusing risks bricking a working deployment over a
  hygiene issue. Warn only.
