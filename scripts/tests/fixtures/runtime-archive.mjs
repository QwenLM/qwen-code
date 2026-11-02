import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runtimeSelection } from '../../managed-runtime-backends.mjs';

export async function runtimeArchiveFixture(
  file,
  value = 'full',
  declared = value,
) {
  const selection = runtimeSelection(value);
  const metadata = runtimeSelection(declared);
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-jar-'));
  try {
    const files = {
      'META-INF/MANIFEST.MF': `Manifest-Version: 1.0\r\nQwen-Runtime-Backends: ${metadata.backends.join(',')}\r\nQwen-Runtime-Variant: ${metadata.variant}\r\n\r\n`,
      'BOOT-INF/classes/application.yml': 'qwen: {}\n',
      'BOOT-INF/classes/META-INF/spring-configuration-metadata.json': '{}',
      ...Object.fromEntries(
        selection.backends.map((backend) => [
          `BOOT-INF/lib/qwen-managed-agent-runtime-${backend}-0.4.0-alpha.jar`,
          backend,
        ]),
      ),
    };
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await mkdir(path.dirname(file), { recursive: true });
    await rm(file, { force: true });
    execFileSync('zip', ['-q', '-X', file, ...Object.keys(files)], {
      cwd: root,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
