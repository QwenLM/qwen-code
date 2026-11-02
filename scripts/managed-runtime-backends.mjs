import { execFileSync } from 'node:child_process';

export const RUNTIME_BACKENDS = Object.freeze([
  'external',
  'kubernetes',
  'local',
  'ssh',
  'static',
]);

export function runtimeSelection(value = 'full') {
  const backends =
    value === 'full'
      ? [...RUNTIME_BACKENDS]
      : [...new Set(value.split(',').map((name) => name.trim()))].sort();
  if (backends.some((name) => !RUNTIME_BACKENDS.includes(name))) {
    throw new Error(`Unknown Runtime backend set: ${value}`);
  }
  const variant =
    backends.length === RUNTIME_BACKENDS.length ? 'full' : backends.join('-');
  return {
    backends,
    variant,
    classifier: variant === 'full' ? 'exec' : `exec-${variant}`,
    operatorJars: variant === 'full',
  };
}

export function runtimeBuildProperties(selection) {
  const excludes = ['org.projectlombok:lombok'];
  for (const name of RUNTIME_BACKENDS) {
    if (!selection.backends.includes(name)) {
      excludes.push(`com.alibaba:qwen-managed-agent-runtime-${name}`);
    }
  }
  return [
    `-Dmanaged.runtime.backends=${selection.backends.join(',')}`,
    `-Dmanaged.runtime.variant=${selection.variant}`,
    `-Dmanaged.exec.classifier=${selection.classifier}`,
    `-Dspring-boot.excludes=${excludes.join(',')}`,
    ...(selection.operatorJars
      ? []
      : ['-Dmanaged.operator-tools.attach=false']),
  ];
}

export function inspectRuntimeArchive(jar, selection) {
  const options = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 };
  const entries = execFileSync('unzip', ['-Z1', jar], options).split('\n');
  const manifest = execFileSync(
    'unzip',
    ['-p', jar, 'META-INF/MANIFEST.MF'],
    options,
  ).replace(/\r?\n /g, '');
  const attributes = Object.fromEntries(
    manifest
      .split(/\r?\n/)
      .filter((line) => line.includes(': '))
      .map((line) => [
        line.slice(0, line.indexOf(': ')),
        line.slice(line.indexOf(': ') + 2),
      ]),
  );
  const actual = entries
    .flatMap((entry) => {
      const match = entry.match(
        /^BOOT-INF\/lib\/qwen-managed-agent-runtime-(external|kubernetes|local|ssh|static)-[^/]+\.jar$/,
      );
      return match ? [match[1]] : [];
    })
    .sort();
  if (
    actual.join(',') !== selection.backends.join(',') ||
    attributes['Qwen-Runtime-Backends'] !== actual.join(',') ||
    attributes['Qwen-Runtime-Variant'] !== selection.variant
  ) {
    throw new Error(
      `Runtime archive does not match ${selection.variant}: ${jar}`,
    );
  }
  for (const resource of [
    'BOOT-INF/classes/application.yml',
    'BOOT-INF/classes/META-INF/spring-configuration-metadata.json',
  ]) {
    if (!entries.includes(resource)) {
      throw new Error(`Runtime archive is missing ${resource}: ${jar}`);
    }
  }
  if (entries.some((entry) => entry.startsWith('BOOT-INF/lib/lombok-'))) {
    throw new Error(`Runtime archive includes Lombok: ${jar}`);
  }
  return { backends: actual, variant: selection.variant };
}
