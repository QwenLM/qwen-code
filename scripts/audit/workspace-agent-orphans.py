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
]

# Accepted: each is reachable, or deliberately kept, for the stated reason.
BASELINE = {
    'createWorkspaceAgentRoutes': 'route entry point; express calls it',
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

orphans = [
    (n, o, len(tests[n]))
    for n, o in sorted(exports.items())
    if n not in BASELINE and not (prod[n] - {o})
]

print(f'{len(exports)} exports in the workspace-agents scope, '
      f'{len(BASELINE)} accepted in the baseline')
if not orphans:
    print('OK: no unexplained orphan.')
    sys.exit(0)
print(f'\n{len(orphans)} seam(s) with no production caller:\n')
for n, o, nt in orphans:
    print(f'  {n:<34} {o}' +
          (f'  <-- ALIVE ONLY IN TESTS ({nt})' if nt else '  (unused entirely)'))
sys.exit(1)
