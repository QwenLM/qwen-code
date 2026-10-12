"""Compile the one private evidence worker template into explicit CEL guards."""

import hashlib
import json
import re
from pathlib import Path, PurePosixPath


SCHEMA_PATH = Path(__file__).with_name('worker-pod-schema-v1.36.json')
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding='utf-8'))['fields']
GATE = 'qwen-code.io/k2-source-ready'
ACCOUNT = 'qwen-k2-worker'
PROFILE = 'qwen-k2-worker-v1'


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate worker-plan field')
        result[key] = value
    return result


def non_json_number(value):
    raise ValueError('Non-JSON number')


def text(value, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError('Invalid bounded worker-plan string')
    if any(ord(char) < 32 or ord(char) >= 127 for char in value):
        raise ValueError('Worker-plan strings must be printable ASCII')
    return value


def dns(value):
    value = text(value, 253)
    if not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part)
               for part in value.split('.')):
        raise ValueError('Invalid worker-plan Kubernetes name')
    return value


def read_plan(path):
    with path.open('rb') as stream:
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise ValueError('Worker plan exceeds 64 KiB')
    plan = json.loads(raw, object_pairs_hook=unique_object,
                      parse_constant=non_json_number)
    fields = {'schemaVersion', 'provisionRequestId', 'image', 'command', 'pvcName',
              'mountRoot', 'artifactConfigMaps'}
    if not isinstance(plan, dict) or set(plan) != fields or type(plan['schemaVersion']) is not int or plan['schemaVersion'] != 1:
        raise ValueError('Exact worker-plan v1 fields are required')
    text(plan['provisionRequestId'], 512)
    if not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', text(plan['image'], 512)):
        raise ValueError('A pinned worker image is required')
    if not isinstance(plan['command'], list) or not 1 <= len(plan['command']) <= 32:
        raise ValueError('A bounded original base command is required')
    for value in plan['command']:
        text(value, 8192)
    if sum(len(value) for value in plan['command']) > 32768:
        raise ValueError('Worker command exceeds the CEL rendering bound')
    dns(plan['pvcName'])
    mount = text(plan['mountRoot'], 2048)
    parsed = PurePosixPath(mount)
    if not mount.startswith('/') or mount.startswith('//') or mount == '/' or str(parsed) != mount or '\\' in mount or any(part in {'.', '..'} for part in parsed.parts):
        raise ValueError('A canonical absolute workspace mount is required')
    if parsed.parts[1] in {'tmp', 'var', 'run', 'proc', 'sys', 'dev', 'etc', 'usr',
                           'bin', 'sbin', 'lib', 'lib64', 'opt', 'root'}:
        raise ValueError('Workspace mount overlaps a protected runtime path')
    chunks = plan['artifactConfigMaps']
    if not isinstance(chunks, list) or len(chunks) > 48 :
        raise ValueError('An ordered unique artifact list is required')
    for value in chunks:
        dns(value)
    if len(set(chunks)) != len(chunks):
        raise ValueError('Duplicate artifact ConfigMap name')
    return plan, hashlib.sha256(raw).hexdigest()


def pod_name(plan):
    encoded = json.dumps(plan['provisionRequestId'], separators=(',', ':')).encode()
    return 'qwen-csi-' + hashlib.sha256(encoded).hexdigest()[:48]


def worker_spec(plan, node, gated):
    name = pod_name(plan)
    mounts = [{'name': 'boot', 'mountPath': '/var/run/qwen-runtime', 'readOnly': True},
              {'name': 'workspace', 'mountPath': plan['mountRoot']},
              {'name': 'tmp', 'mountPath': '/tmp'}]
    volumes = [{'name': 'boot', 'secret': {'secretName': name, 'defaultMode': 288,
                'items': [{'key': 'boot.json', 'path': 'boot.json'}]}},
               {'name': 'workspace', 'persistentVolumeClaim': {'claimName': plan['pvcName']}},
               {'name': 'tmp', 'emptyDir': {'sizeLimit': '512Mi'}}]
    if plan['artifactConfigMaps']:
        mounts.append({'name': 'worker', 'mountPath': '/var/run/qwen-worker-parts', 'readOnly': True})
        sources = [{'configMap': {'name': value, 'items': [{'key': 'chunk', 'path': f'{index:03d}'}]}}
                   for index, value in enumerate(plan['artifactConfigMaps'])]
        volumes.append({'name': 'worker', 'projected': {'defaultMode': 292, 'sources': sources}})
    env = [{'name': 'HOME', 'value': '/tmp'}, {'name': 'QWEN_RUNTIME_DIR', 'value': '/tmp/qwen'}]
    env.extend({'name': name, 'valueFrom': {'fieldRef': {'apiVersion': 'v1', 'fieldPath': field}}}
               for name, field in [('QWEN_POD_UID', 'metadata.uid'),
                                   ('QWEN_POD_NAMESPACE', 'metadata.namespace'),
                                   ('QWEN_NODE_NAME', 'spec.nodeName')])
    container = {
        'name': 'runtime', 'image': plan['image'], 'imagePullPolicy': 'IfNotPresent',
        'command': plan['command'] + ['managed-runtime-worker', '--container-boot', '/var/run/qwen-runtime/boot.json'],
        'env': env, 'ports': [{'name': 'runtime', 'containerPort': 43190, 'protocol': 'TCP'}],
        'readinessProbe': {'tcpSocket': {'port': 43190}, 'periodSeconds': 1,
                           'timeoutSeconds': 1, 'successThreshold': 1, 'failureThreshold': 3},
        'resources': {'requests': {'cpu': '100m', 'memory': '256Mi', 'ephemeral-storage': '2Gi'},
                      'limits': {'cpu': '1', 'memory': '1Gi', 'ephemeral-storage': '2Gi'}},
        'securityContext': {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True,
                            'capabilities': {'drop': ['ALL']}},
        'volumeMounts': mounts, 'terminationMessagePath': '/dev/termination-log',
        'terminationMessagePolicy': 'File',
    }
    spec = {
        'restartPolicy': 'Never', 'automountServiceAccountToken': False, 'enableServiceLinks': False,
        'serviceAccountName': ACCOUNT, 'nodeSelector': {'kubernetes.io/os': 'linux'},
        'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000,
                            'fsGroup': 1000, 'seccompProfile': {'type': 'RuntimeDefault'},
                            'appArmorProfile': {'type': 'Localhost', 'localhostProfile': PROFILE}},
        'containers': [container], 'volumes': volumes,
        'affinity': {'nodeAffinity': {'requiredDuringSchedulingIgnoredDuringExecution': {
            'nodeSelectorTerms': [{'matchFields': [{'key': 'metadata.name', 'operator': 'In', 'values': [node]}]}]}}},
        'tolerations': [{'key': 'qwen-code.io/k2-evidence', 'operator': 'Equal', 'value': 'isolated', 'effect': 'NoSchedule'},
                        {'key': 'node.kubernetes.io/not-ready', 'operator': 'Exists', 'effect': 'NoExecute', 'tolerationSeconds': 300},
                        {'key': 'node.kubernetes.io/unreachable', 'operator': 'Exists', 'effect': 'NoExecute', 'tolerationSeconds': 300}],
        'dnsPolicy': 'ClusterFirst', 'schedulerName': 'default-scheduler', 'terminationGracePeriodSeconds': 30,
    }
    if gated:
        spec['schedulingGates'] = [{'name': GATE}]
    return spec


def literal(value):
    return json.dumps(value, ensure_ascii=True, separators=(',', ':'))


def exact_fields(path, kind, expected):
    if kind not in SCHEMA or not set(expected) <= set(SCHEMA[kind]):
        raise ValueError('Template disagrees with the reviewed Kubernetes schema')
    rules = []
    optional_defaults = {'PodSpec': {'serviceAccount': ACCOUNT, 'priority': 0,
                                     'preemptionPolicy': 'PreemptLowerPriority'}}
    for field, child in SCHEMA[kind].items():
        current = path + '.' + field
        if field not in expected:
            defaults = optional_defaults.get(kind, {})
            if field in defaults:
                rules.append(f'(!has({current}) || {current} == {literal(defaults[field])})')
            elif kind == 'PodSpec' and field in {'initContainers', 'ephemeralContainers', 'imagePullSecrets', 'schedulingGates'}:
                rules.append(f'(!has({current}) || size({current}) == 0)')
            elif kind == 'PodSpec' and field in {'hostNetwork', 'hostPID', 'hostIPC', 'shareProcessNamespace'}:
                rules.append(f'(!has({current}) || {current} == false)')
            else:
                rules.append(f'!has({current})')
            continue
        value = expected[field]
        rules.append(f'has({current})')
        if child in SCHEMA:
            rules.extend(exact_fields(current, child, value))
        elif child.startswith('[]') and child[2:] in SCHEMA:
            rules.append(f'size({current}) == {len(value)}')
            for index, item in enumerate(value):
                rules.extend(exact_fields(f'{current}[{index}]', child[2:], item))
        else:
            rules.append(f'{current} == {literal(value)}')
    return rules


def metadata_rules(path, name, namespace):
    annotations = {'container.apparmor.security.beta.kubernetes.io/runtime': 'localhost/' + PROFILE}
    return [f'{path}.name == {literal(name)}', f'{path}.namespace == {literal(namespace)}',
            f'(!has({path}.generateName) || {path}.generateName == "")',
            f'(!has({path}.labels) || size({path}.labels) == 0)',
            f'(!has({path}.annotations) || size({path}.annotations) == 0 || {path}.annotations == {literal(annotations)})',
            f'(!has({path}.ownerReferences) || size({path}.ownerReferences) == 0)',
            f'(!has({path}.finalizers) || size({path}.finalizers) == 0)',
            f'!has({path}.deletionTimestamp)', f'!has({path}.deletionGracePeriodSeconds)']


def unchanged(path, field):
    new, old = 'object.' + path + '.' + field, 'oldObject.' + path + '.' + field
    return f'(has({new}) == has({old}) && (!has({new}) || {new} == {old}))'


def worker_guards(args):
    plan, digest = read_plan(args.worker_plan)
    name = pod_name(plan)
    coordinator = f'request.userInfo.username == {literal(args.coordinator_user)}'
    create = [coordinator, 'oldObject == null'] + metadata_rules('object.metadata', name, args.namespace)
    create += exact_fields('object.spec', 'PodSpec', worker_spec(plan, args.node, True))
    update = [coordinator, f'request.name == {literal(name)}', 'oldObject != null',
              'object.metadata.uid == oldObject.metadata.uid',
              'object.metadata.creationTimestamp == oldObject.metadata.creationTimestamp']
    update += metadata_rules('object.metadata', name, args.namespace)
    update += metadata_rules('oldObject.metadata', name, args.namespace)
    update += ['has(oldObject.spec.schedulingGates)', 'size(oldObject.spec.schedulingGates) == 1',
               f'oldObject.spec.schedulingGates[0].name == {literal(GATE)}']
    update += exact_fields('object.spec', 'PodSpec', worker_spec(plan, args.node, False))
    update += [unchanged('spec', field) for field in SCHEMA['PodSpec'] if field != 'schedulingGates']
    update += [unchanged('metadata', field) for field in ['generateName', 'labels', 'annotations', 'ownerReferences', 'finalizers']]
    guards = [('create', [(['CREATE'], ['pods'])], ' && '.join(create), 'Only the exact original gated K2 worker may be created.'),
              ('gate', [(['UPDATE'], ['pods'])], ' && '.join(update), 'Only the coordinator may remove the original K2 source gate once.')]
    if any(len(expression.encode()) > 98304 for _, _, expression, _ in guards):
        raise ValueError('Rendered worker expression exceeds the reviewed size bound')
    return guards, name, digest
