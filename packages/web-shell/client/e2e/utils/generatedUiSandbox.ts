import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// E2E fixtures use the repository's build dependency.
// eslint-disable-next-line import/no-extraneous-dependencies
import { build } from 'esbuild';

const root = new URL('../../../../../', import.meta.url);

export async function startGeneratedUiSandbox() {
  const appHtml = await readFile(
    new URL('integrations/generated-ui/dist/app.html', root),
    'utf8',
  );
  const require = createRequire(new URL('packages/cli/package.json', root));
  const fixture = await build({
    stdin: {
      resolveDir: fileURLToPath(root),
      contents: `
        import express from ${JSON.stringify(require.resolve('express'))};
        import { mountMcpAppSandbox } from './packages/cli/src/serve/mcp-app-sandbox.ts';
        export { createShowResult } from './integrations/generated-ui/src/contracts.ts';
        export async function startSandbox() {
          const app = express();
          const dispose = mountMcpAppSandbox(app);
          const server = await new Promise((resolve) => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
          });
          return {
            url: 'http://127.0.0.1:' + server.address().port,
            async close() {
              dispose();
              server.closeAllConnections();
              await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            },
          };
        }
      `,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    banner: {
      js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(fileURLToPath(new URL('packages/cli/package.json', root)))});`,
    },
  });
  const directory = await mkdtemp(join(tmpdir(), 'generated-ui-e2e-'));
  const fixturePath = join(directory, 'sandbox.mjs');
  await writeFile(fixturePath, fixture.outputFiles[0].text);
  const helpers = (await import(pathToFileURL(fixturePath).href)) as {
    createShowResult(
      document: Record<string, unknown>,
    ): Record<string, unknown>;
    startSandbox(): Promise<{ url: string; close(): Promise<void> }>;
  };
  const sandbox = await helpers.startSandbox();
  return {
    appHtml,
    createShowResult: helpers.createShowResult,
    url: sandbox.url,
    async close() {
      try {
        await sandbox.close();
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  };
}
