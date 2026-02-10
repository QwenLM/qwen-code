import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const assetsDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(assetsDir, 'src');

export const buildConfig = {
  entryPoints: [join(srcDir, 'main.tsx')],
  bundle: true,
  minify: true,
  write: false,
  outdir: join(assetsDir, 'dist'),
  platform: 'browser',
  format: 'iife',
  target: ['es2018'],
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  tsconfigRaw: {
    compilerOptions: {
      jsx: 'react',
    },
  },
  external: ['react', 'react-dom', 'react-dom/client'],
  legalComments: 'none',
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.js': 'jsx',
    '.jsx': 'jsx',
    '.css': 'css',
    '.svg': 'text',
  },
};
