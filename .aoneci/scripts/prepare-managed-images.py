#!/usr/bin/env python3
"""Prepare minimal image contexts from this run's verified runtime artifact."""
import argparse
import hashlib
import json
import re
import shutil
import tarfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--runtime', type=Path, required=True)
parser.add_argument('--release', required=True)
parser.add_argument('--source-sha', required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,100}', args.release):
    raise SystemExit('Invalid release id for image tags')
provenance = json.loads((args.runtime / 'PROVENANCE.json').read_text())
assert provenance['producer'] == 'runtime'
assert provenance['preview'] == args.release
assert provenance['sourceRevision'] == args.source_sha
archive = args.runtime / ('qwen-runtime-' + args.release + '.tar.gz')
assert archive.stat().st_size == provenance['bytes']
assert hashlib.sha256(archive.read_bytes()).hexdigest() == provenance['sha256']
with tarfile.open(archive) as bundle:
    package = json.load(bundle.extractfile('qwen-code/package.json'))
for field, expected in [('version', provenance['version']), ('managedPreview', args.release),
                        ('sourceRevision', args.source_sha), ('sourceTreeSha256', provenance['sourceTreeSha256'])]:
    assert package[field] == expected, field
root = Path(__file__).resolve().parents[2]
for producer in ('worker', 'harness'):
    context = args.out / producer
    context.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(archive, context / 'runtime.tar.gz')
    shutil.copyfile(args.runtime / 'PROVENANCE.json', context / 'PROVENANCE.json')
    shutil.copyfile(root / '.aoneci/images' / ('Dockerfile.' + producer), context / 'Dockerfile')
    shutil.copyfile(root / '.aoneci/scripts/verify-managed-image.cjs', context / 'verify-managed-image.cjs')
    (context / 'runtime.sha256').write_text(provenance['sha256'] + '  /tmp/runtime.tar.gz\n')
print(json.dumps({key: provenance[key] for key in ('preview', 'version', 'sourceRevision', 'sourceTreeSha256', 'sha256')}, indent=2))
