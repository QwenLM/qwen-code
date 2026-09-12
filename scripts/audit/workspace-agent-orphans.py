#!/usr/bin/env python3
# Usage: python3 scripts/audit/workspace-agent-orphans.py .
"""Find workspace-agents seams whose only callers are tests.

This is the bug class lint and tsc cannot see: delete a file, orphan the
production call it made, and the tests keep the export alive so nothing goes
red. That is exactly how `runWithAgentRunContext` was lost.

Scoped to the workspace-agents subsystem. Anything outside it is somebody
else's pre-existing surface and only adds noise.
"""
import re, sys, pathlib
from collections import defaultdict

ROOT = pathlib.Path(sys.argv[1])
SCOPE = [
    'packages/core/src/agents/workspace-agents',
    'packages/core/src/tools/thread-tools.ts',
    'packages/cli/src/serve/workspace-agents',
    # The REST layer belongs to this subsystem too. Leaving it out meant the
    # whole surface went unswept, which is how a baseline entry came to name a
    # symbol the scan could not see.
    'packages/cli/src/serve/routes/workspace-agents.ts',
]

# Accepted: each is reachable, or deliberately kept, for the stated reason.
BASELINE = {
    'registerWorkspaceAgentRoutes': 'route entry point; server.ts calls it',
    'startAgentHostSessionOwner': 'daemon entry point',
    'AGENTS_DISPLAY_PATH': 'user-facing path string, used in messages',
    'AGENT_NAME_PATTERN': 'consumed via isValidAgentName in the same file',
    'DEFAULT_POST_CHAR_BUDGET': 'prompt tuning constant, exported for tests',
    'DEFAULT_RECENT_POST_COUNT': 'prompt tuning constant, exported for tests',
    'PROMPT_RETENTION_BOUND': 'prompt tuning constant, exported for tests',
    'isValidId': 'store-internal validator, exported for tests',
    'generateThreadId': 'store-internal id minting, exported for tests',
    'getAgentsDir': 'path helper, exported for tests',
    'getThreadsDir': 'path helper, exported for tests',
    'getAgentsFilePath': 'path helper, exported for tests',
    'getAgentHostsFilePath': 'path helper used inside store.ts; the sweep does not count the defining file as a caller',
    'getThreadPath': 'path helper, exported for tests',
    'getWorkspaceFilePath': 'path helper, exported for tests',
    'listThreadIds': 'store helper, exported for tests',
    'ensureMigrated': 'store-internal migration, exported for tests',
    'deleteThread': 'store helper, exported for tests',
    'enqueueThreadEvent': 'store helper, exported for tests',
    'updateThread': 'store helper, exported for tests',
    'setAgentNotifyTarget': 'store helper, exported for tests',
    'createThreadInTransaction': 'transaction variant, exported for tests',
    'readTokenBudgetThread': 'budget helper, exported for tests',
    'countQueuedElsewhere': 'admission helper, exported for tests',
    'selectCandidates': 'dispatcher internal, exported for tests',
    'classifyAgentTool': 'capability internal, exported for tests',
    'getAgentRunContext': 'the non-throwing reader; requireAgentRunContext is the used one',
    'outstandingCloseObligations': 'status internal, exported for tests',
    'listCloseObligations': 'status internal, exported for tests',
    'admissionBookedNothing': 'status internal, exported for tests',
    'closeRunInTransaction': 'run-lifecycle internal, exported for tests',
    'finishRun': 'non-transaction variant; dispatcher uses finishRunInTransaction',
    'deliverParentReports': 'called through the dispatcher barrel',
}

WORD = re.compile(r'[A-Za-z_$][A-Za-z0-9_$]*')
prod, tests = defaultdict(set), defaultdict(set)
for f in ROOT.joinpath('packages').rglob('*.ts*'):
    sf = str(f)
    if 'node_modules' in sf or '/dist/' in sf:
        continue
    try:
        text = f.read_text()
    except Exception:
        continue
    rel = str(f.relative_to(ROOT))
    if rel.endswith('/index.ts'):
        continue                      # a barrel re-export is not a caller
    (tests if '.test.' in rel else prod)[rel] = None
    for w in set(WORD.findall(text)):
        (tests if '.test.' in rel else prod)
        (tests[w] if '.test.' in rel else prod[w]).add(rel)

exports = {}
for scope in SCOPE:
    p = ROOT / scope
    for f in (p.rglob('*.ts') if p.is_dir() else [p]):
        if '.test.' in f.name:
            continue
        rel = str(f.relative_to(ROOT))
        for m in re.finditer(
            r'^export (?:async )?function (\w+)|^export const (\w+)\s*[:=]',
            f.read_text(), re.M):
            exports.setdefault(m.group(1) or m.group(2), rel)

# A baseline entry naming a symbol that no longer exists protects nothing and
# hides that it stopped: the excuse outlives the thing it excused. This was
# real — `createWorkspaceAgentRoutes` was baselined under a name the code has
# never had, so the entry was inert from the day it was written.
stale_baseline = sorted(set(BASELINE) - set(exports))

orphans = [
    (n, o, len(tests[n]))
    for n, o in sorted(exports.items())
    if n not in BASELINE and not (prod[n] - {o})
]

failed = False
print(f'{len(exports)} exports in the workspace-agents scope, '
      f'{len(BASELINE)} accepted in the baseline')
if orphans:
    failed = True
    print(f'\n{len(orphans)} seam(s) with no production caller:\n')
    for n, o, nt in orphans:
        print(f'  {n:<34} {o}' +
              (f'  <-- ALIVE ONLY IN TESTS ({nt})' if nt else '  (unused entirely)'))
else:
    print('OK: no unexplained orphan.')

if stale_baseline:
    failed = True
    print(f'\n{len(stale_baseline)} baseline entr(ies) naming no export:\n')
    for name in stale_baseline:
        print(f'  {name:<34} remove it or fix the name')
else:
    print('OK: every baseline entry still names a real export.')


# --- second sweep: fields declared on a stored record that nothing uses ------
# A field only a validator mentions is a decoration, not a seam. `runtime` was
# exactly that: declared, validated, never written, never read, and it read as
# a working runtime binding to anyone reviewing the type.

RECORD_FILES = ['packages/core/src/agents/workspace-agents/types.ts']
FIELD_BASELINE = {
    'runtimeId': 'reserved by #11222 for later runtime adapters; has a round-trip test',
    'schemaVersion': 'written by every record constructor via a spread',
}

field_orphans = []
for rel in RECORD_FILES:
    text = (ROOT / rel).read_text()
    for m in re.finditer(r'^  (\w+)\??:\s', text, re.M):
        name = m.group(1)
        if name in FIELD_BASELINE:
            continue
        users = set()
        for f, t in [(r, (ROOT / r).read_text()) for r in
                     sorted({*prod.get(name, set()), *tests.get(name, set())})]:
            if f == rel:
                continue
            # A validator naming the field in a string key is not a user.
            if re.search(r'\b' + re.escape(name) + r'\b(?!\'\])', t):
                users.add(f)
        real = {u for u in users if '.test.' not in u}
        if not real:
            field_orphans.append((name, rel, len(users)))

if field_orphans:
    failed = True
    print(f'\n{len(field_orphans)} record field(s) nothing reads or writes:\n')
    for name, rel, nt in field_orphans:
        print(f'  {name:<34} {rel}' +
              (f'  <-- only tests ({nt})' if nt else '  (validator only)'))
else:
    print('OK: no orphan record field.')




# --- third sweep: the design doc's record diagrams vs the real types --------
# The plan is the authoritative description of these records, and a diagram
# that has drifted is worse than none: it is read as current. This caught a
# `backgroundAgentId` that no longer existed and three fields that did.

DOC = 'docs/plans/2026-09-06-multi-agent-board-collaboration.md'
DIAGRAMS = {  # interface name -> (start marker, end marker) in the diagram
    'WorkspaceAgent': ('WorkspaceAgent ', '\n\nThread'),
    'Thread': ('Thread    ', '\n\nThreadMessage'),
}
# Words in the diagram that annotate rather than name a field.
ANNOTATIONS = {'execution', 'binding'}

doc_path = ROOT / DOC
if doc_path.exists():
    types_src = (ROOT / 'packages/core/src/agents/workspace-agents/types.ts').read_text()
    doc_text = doc_path.read_text()
    drift = []
    for iface, (head, tail) in DIAGRAMS.items():
        m = re.search(r'export interface ' + iface + r'\s*\{(.*?)\n\}',
                      types_src, re.S)
        if not m or head not in doc_text or tail not in doc_text:
            continue
        code = set(re.findall(r'^  (\w+)\??:', m.group(1), re.M))
        block = doc_text.split(head, 1)[1].split(tail, 1)[0]
        listed = set(re.findall(r'\b([a-z][A-Za-z]+)\b', block)) - ANNOTATIONS
        for name in sorted(listed - code):
            drift.append((iface, name, 'in the diagram, not in the type'))
        for name in sorted(code - listed):
            drift.append((iface, name, 'in the type, not in the diagram'))
    if drift:
        failed = True
        print(f'\n{len(drift)} record diagram drift(s) in {DOC}:\n')
        for iface, name, why in drift:
            print(f'  {iface}.{name:<26} {why}')
    else:
        print('OK: the design doc\'s record diagrams match the types.')

sys.exit(1 if failed else 0)
