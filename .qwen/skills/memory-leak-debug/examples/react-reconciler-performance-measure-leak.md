# React Reconciler PerformanceMeasure Leak

## Symptom

After the ink 6→7 upgrade (v0.15.11), moderate CLI usage caused heap to grow
to 300+ MB. RSS climbed steadily and never stabilized.

## Diagnosis

### Snapshot comparison

Took 5 snapshots over ~25 minutes of normal usage.

Snapshot #1 (baseline):

```
PerformanceMeasure: count=184, retainedSize=184 kB
```

Snapshot #5 (after activity):

```
PerformanceMeasure: count=150,716, retainedSize=146,798 kB (~143 MB)
```

Growth: ~800x over the session. Linear with number of React renders.

### Retainer chain

```
chrome-devtools get_node_retainers <snapshot> 1003471
```

Showed `PerformanceMeasure` instances retained by `(object elements)` → `Array`
— the global `measureEntryBuffer` that Node.js maintains for
`performance.measure()` calls.

### Source identification

`react-reconciler` ≥0.33 (pulled in by ink 7) calls `performance.measure()` on
every component render in its **development build**. The dev/prod build is
selected at runtime via `process.env.NODE_ENV`. Since the esbuild config never
set `NODE_ENV` to `"production"`, the bundle shipped both builds and selected
dev at runtime.

## Fix

Set `process.env.NODE_ENV` to `"production"` in esbuild's `define` map so the
conditional require resolves statically and the entire 15K-line dev build is
tree-shaken:

```js
// esbuild.config.js
define: {
  'process.env.NODE_ENV': JSON.stringify('production'),
}
```

Bundle shrank by ~700 KB / 15,800 lines. PerformanceMeasure objects no longer
accumulate.

## Commit

`dbdc94be9` — fix(build): tree-shake React reconciler dev build to prevent
PerformanceMeasure leak
