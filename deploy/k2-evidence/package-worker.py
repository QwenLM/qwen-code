#!/usr/bin/env python3
# Copyright 2026 Qwen Team. SPDX-License-Identifier: Apache-2.0

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile


def digest(raw):
    return 'sha256:' + hashlib.sha256(raw).hexdigest()


def closed_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate image metadata field')
        result[key] = value
    return result


def decode(raw):
    return json.loads(raw, object_pairs_hook=closed_pairs)


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def checked_digest(value):
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', value):
        raise ValueError('expected a complete sha256 digest')
    return value


def input_blob(root, descriptor, maximum):
    pin = checked_digest(descriptor['digest'])
    size = descriptor['size']
    if type(size) is not int or size <= 0 or size > maximum:
        raise ValueError('unsupported base image blob size')
    path = root / 'blobs' / 'sha256' / pin[7:]
    if path.is_symlink() or not path.is_file() or path.stat().st_size != size:
        raise ValueError('base image blob is not an exact regular file')
    return path


def read_metadata(path, pin):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1 << 20:
        raise ValueError('invalid image metadata file')
    raw = path.read_bytes()
    if digest(raw) != pin:
        raise ValueError('image metadata digest differs')
    return decode(raw)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-layout', type=Path, required=True)
    parser.add_argument('--base-manifest', required=True)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--bundle-sha256', required=True)
    parser.add_argument('--architecture', choices=('amd64', 'arm64'), required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not all(p.is_absolute() for p in (args.base_layout, args.bundle, args.output)):
        raise ValueError('use absolute artifact paths')
    base_pin = checked_digest(args.base_manifest)
    bundle_pin = checked_digest('sha256:' + args.bundle_sha256)
    if args.bundle.is_symlink() or not args.bundle.is_file() or not 0 < args.bundle.stat().st_size <= 32 << 20:
        raise ValueError('worker bundle is not a bounded regular file')
    bundle = args.bundle.read_bytes()
    if digest(bundle) != bundle_pin:
        raise ValueError('worker bundle digest differs')
    base = read_metadata(args.base_layout / 'blobs' / 'sha256' / base_pin[7:], base_pin)
    config_path = input_blob(args.base_layout, base['config'], 1 << 20)
    old_config = read_metadata(config_path, base['config']['digest'])
    layers = base['layers']
    diffs = old_config['rootfs']['diff_ids']
    if base['schemaVersion'] != 2 or old_config['os'] != 'linux' or old_config['architecture'] != args.architecture or old_config['rootfs']['type'] != 'layers' or not 0 < len(layers) <= 16 or len(layers) != len(diffs):
        raise ValueError('base image architecture or layer shape differs')
    if len([v for v in old_config.get('config', {}).get('Env', []) if v.startswith('NODE_VERSION=22.')]) != 1:
        raise ValueError('base image is not the reviewed Node 22 lane')
    if sum(v['size'] for v in layers) > 512 << 20:
        raise ValueError('base image exceeds the compressed byte limit')
    args.output.mkdir(mode=0o700)
    blobs = args.output / 'blobs' / 'sha256'
    blobs.mkdir(parents=True, mode=0o700)
    for layer, expected_diff in zip(layers, diffs):
        checked_digest(expected_diff)
        if layer['mediaType'] not in ('application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.docker.image.rootfs.diff.tar.gzip'):
            raise ValueError('unsupported base image layer encoding')
        source = input_blob(args.base_layout, layer, 512 << 20)
        checksum = hashlib.sha256()
        with source.open('rb') as stream, (blobs / layer['digest'][7:]).open('xb') as out:
            while data := stream.read(1 << 20):
                checksum.update(data)
                out.write(data)
        if 'sha256:' + checksum.hexdigest() != layer['digest']:
            raise ValueError('base image layer digest differs')
        uncompressed = hashlib.sha256()
        count = 0
        with gzip.open(blobs / layer['digest'][7:], 'rb') as stream:
            while data := stream.read(1 << 20):
                count += len(data)
                if count > 2 << 30:
                    raise ValueError('base image layer exceeds the uncompressed limit')
                uncompressed.update(data)
        if 'sha256:' + uncompressed.hexdigest() != expected_diff:
            raise ValueError('base image uncompressed diff ID differs')

    def blob(raw, media):
        pin = digest(raw)
        with (blobs / pin[7:]).open('xb') as stream:
            stream.write(raw)
        return {'mediaType': media, 'digest': pin, 'size': len(raw)}

    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name in ('opt/', 'opt/qwen-k2/'):
            item = tarfile.TarInfo(name)
            item.type = tarfile.DIRTYPE
            item.mode = 0o755
            archive.addfile(item)
        item = tarfile.TarInfo('opt/qwen-k2/worker.mjs')
        item.mode = 0o444
        item.size = len(bundle)
        archive.addfile(item, io.BytesIO(bundle))
    worker_layer = blob(buffer.getvalue(), 'application/vnd.oci.image.layer.v1.tar')
    config = {'architecture': args.architecture, 'os': 'linux', 'config': {
        'User': '1000:1000', 'WorkingDir': '/', 'Env': ['HOME=/tmp', 'QWEN_RUNTIME_DIR=/tmp/qwen', 'NODE_ENV=production'],
        'Entrypoint': ['/usr/local/bin/node', '/opt/qwen-k2/worker.mjs'],
        'Cmd': ['managed-runtime-worker', '--container-boot', '/var/run/qwen-runtime/boot.json'],
        'ExposedPorts': {'43190/tcp': {}}}, 'rootfs': {'type': 'layers', 'diff_ids': diffs + [worker_layer['digest']]}}
    config_descriptor = blob(encode(config), 'application/vnd.oci.image.config.v1+json')
    layers = [{**layer, 'mediaType': 'application/vnd.oci.image.layer.v1.tar+gzip'} for layer in layers]
    manifest = blob(encode({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'config': config_descriptor, 'layers': layers + [worker_layer], 'annotations': {'org.opencontainers.image.base.digest': base_pin}}), 'application/vnd.oci.image.manifest.v1+json')
    (args.output / 'oci-layout').write_bytes(encode({'imageLayoutVersion': '1.0.0'}))
    (args.output / 'index.json').write_bytes(encode({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json', 'manifests': [{**manifest, 'platform': {'os': 'linux', 'architecture': args.architecture}}]}))
    result = {'manifest': manifest, 'baseManifest': base_pin, 'bundleSha256': bundle_pin, 'architecture': args.architecture, 'command': config['config']['Entrypoint'], 'qualified': False, 'published': False}
    (args.output / 'provenance.json').write_bytes(encode(result))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
