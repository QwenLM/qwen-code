import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function resolveUbrn(typescriptRoot) {
  const require = createRequire(join(typescriptRoot, 'package.json'));
  let root = dirname(require.resolve('uniffi-bindgen-react-native'));
  const expected = JSON.parse(readFileSync(join(typescriptRoot, 'package.json'), 'utf8')).devDependencies['uniffi-bindgen-react-native'];
  while (dirname(root) !== root) {
    const manifest = join(root, 'package.json');
    if (existsSync(manifest)) {
      const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
      if (metadata.name === 'uniffi-bindgen-react-native') {
        if (metadata.version !== expected) throw new Error(`UBRN version mismatch: expected ${expected}, found ${metadata.version}`);
        return root;
      }
    }
    root = dirname(root);
  }
  throw new Error('Pinned UBRN source not found; run corepack pnpm install at the repository root.');
}
