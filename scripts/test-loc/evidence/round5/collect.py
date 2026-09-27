#!/usr/bin/env python3
"""Collect explicit local evidence snapshots; never execute experiments."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
RAW = REPO / '.qwen/testloc-evidence/round5-raw.tar.gz'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()


def collect():
    config_bytes = (HERE / 'sources.json').read_bytes()
    config = json.loads(config_bytes)
    records, results, members = [], [], []
    ids = [item['id'] for item in config['sources']]
    if len(set(ids)) != len(ids) or any(not re.fullmatch(r'[a-z0-9-]+', i) for i in ids):
        raise ValueError('Source IDs must be unique lowercase names')
    RAW.parent.mkdir(parents=True, exist_ok=True)
    temporary = tempfile.NamedTemporaryFile(dir=RAW.parent, delete=False)
    try:
        with temporary, gzip.GzipFile(filename='', mode='wb', fileobj=temporary, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode='w') as archive:
                def add(name, data):
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    info.mode = 0o644
                    archive.addfile(info, io.BytesIO(data))
                    members.append({'file': name, 'bytes': len(data), 'sha256': digest(data)})

                for source in config['sources']:
                    record = dict(source)
                    records.append(record)
                    if not source.get('local'):
                        record['status'] = 'pending-source'
                        continue
                    local = REPO / source['local']
                    if not local.exists():
                        record['status'] = 'missing'
                        continue
                    if local.is_dir():
                        if source['kind'] != 'raw':
                            raise ValueError(f"Only raw inputs may be directories: {source['id']}")
                        files = sorted(p for p in local.rglob('*') if p.is_file())
                        for file in files:
                            add(f"{source['id']}/{file.relative_to(local)}", file.read_bytes())
                        record.update(status='available' if files else 'empty', files=len(files))
                        continue
                    data = local.read_bytes()
                    sha = digest(data)
                    if source.get('expectedSha256') and source['expectedSha256'] != sha:
                        raise ValueError(f"Frozen source changed: {source['id']}")
                    member = f"{source['id']}/{local.name}"
                    add(member, data)
                    record.update(status='available', bytes=len(data), sha256=sha, archiveMember=member)
                    if source['kind'] == 'plan':
                        plan = json.loads(data)
                        packed = gzip.compress(data, mtime=0)
                        target = Path('plans') / f"{source['id']}.json.gz"
                        (HERE / target).parent.mkdir(parents=True, exist_ok=True)
                        (HERE / target).write_bytes(packed)
                        record.update(file=str(target), gzipSha256=digest(packed), gzipBytes=len(packed))
                        record['summary'] = {key: plan[key] for key in ['kind', 'pkg', 'profile', 'seed', 'maxWorkers', 'maxTests'] if key in plan}
                        record['summary']['items'] = len(plan.get('faults', plan.get('samples', [])))
                    elif source['kind'] == 'json':
                        value = json.loads(data)
                        if isinstance(value, dict) and value.get('complete') is False:
                            record['status'] = 'incomplete'
                        results.append({'id': source['id'], 'sourceSha256': sha, 'data': value})
                add('raw-files.json', encoded(members.copy()))
        os.replace(temporary.name, RAW)
    finally:
        Path(temporary.name).unlink(missing_ok=True)
    result_bytes = encoded({'schemaVersion': 1, 'results': results})
    (HERE / 'results.json').write_bytes(result_bytes)
    manifest = {
        'schemaVersion': 1,
        'collectionComplete': all(item['status'] == 'available' for item in records),
        'meaning': 'Collection status only; capability conclusions remain in individual comparison reports.',
        'collectorSha256': digest(Path(__file__).read_bytes()),
        'sourcesSha256': digest(config_bytes),
        'sources': records,
        'results': {'file': 'results.json', 'sha256': digest(result_bytes), 'bytes': len(result_bytes)},
        'rawArchive': {'file': str(RAW.relative_to(REPO)), 'sha256': digest(RAW.read_bytes()), 'bytes': RAW.stat().st_size, 'members': len(members)},
    }
    (HERE / 'manifest.json').write_bytes(encoded(manifest))
    print(json.dumps({'collectionComplete': manifest['collectionComplete'], 'available': sum(r['status'] == 'available' for r in records), 'sources': len(records)}))


if __name__ == '__main__':
    collect()
