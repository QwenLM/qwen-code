#!/usr/bin/env python3
"""Record an immutable image reference together with its runtime provenance."""
import argparse
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--runtime', type=Path, required=True)
parser.add_argument('--producer', choices=('worker', 'harness'), required=True)
parser.add_argument('--digest', required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
digest = args.digest.removeprefix('sha256:')
if not re.fullmatch(r'[0-9a-f]{64}', digest):
    raise SystemExit('build-image did not return a valid digest')
runtime = json.loads((args.runtime / 'PROVENANCE.json').read_text())
image = f"hub.docker.alibaba-inc.com/aone-base-global/data-agent-{args.producer}:{args.producer}-{runtime['preview']}"
record = {'producer': args.producer, 'image': image, 'digest': 'sha256:' + digest,
          'immutableImage': image + '@sha256:' + digest, 'runtime': runtime,
          'validation': 'Image build smoke only; no deployment or real-session acceptance'}
args.out.write_text(json.dumps(record, indent=2, sort_keys=True) + '\n')
print(args.out.read_text())
