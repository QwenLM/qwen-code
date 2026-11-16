/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [output, build] = process.argv.slice(2);
assert(output && build, 'usage: node fixture.mjs fresh-output frozen-dist');
const outputPath = path.resolve(output);
const root = path.join(
  fs.realpathSync(path.dirname(outputPath)),
  path.basename(outputPath),
);
const buildDir = fs.realpathSync(path.resolve(build));
assert(!fs.existsSync(root), 'output must be a fresh directory');
assert(
  !root.startsWith(`${buildDir}${path.sep}`),
  'output must be outside the build',
);
assert(
  fs.existsSync(path.join(buildDir, 'cli.js')),
  'build must contain cli.js',
);
const chunks = path.join(buildDir, 'chunks');
const moduleFile = (prefix) => {
  const names = fs
    .readdirSync(chunks)
    .filter((name) => new RegExp(`^${prefix}[A-Z0-9]+\\.js$`).test(name));
  assert.equal(names.length, 1, `expected one ${prefix} module`);
  return path.join(chunks, names[0]);
};
const serveModule = moduleFile('run-qwen-serve-');
const fastPathModule = moduleFile('fast-path-');
fs.mkdirSync(root, { mode: 0o700 });
const workspace = path.join(root, 'workspace');
const home = path.join(root, 'home');
const qwenHome = path.join(home, '.qwen');
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(root, 'tmp'));
const inventory = [];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const put = (relativePath, content, resource = false) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (resource) {
    inventory.push({
      relativePath,
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
};
let skillCount = 0;
const addSkill = (base, name) => {
  const index = ++skillCount;
  put(
    `${base}/SKILL.md`,
    `---\nname: ${name}\ndescription: Review synthetic scenario ${index} using local examples.\nuser-invocable: true\n---\n# ${name}\n\nRead local examples, compare the expected result, and explain discrepancies.\n`,
    true,
  );
  for (let example = 0; example < 40; example++) {
    const records = Array.from({ length: 64 }, (_, item) => ({
      scenario: index,
      example,
      item,
      input: { left: index * 101 + item, right: example * 13 + item },
      expectedSum: index * 101 + example * 13 + item * 2,
    }));
    put(
      `${base}/references/group-${example % 4}/example-${example}.json`,
      json(records),
      true,
    );
  }
};
for (let suite = 1; suite <= 14; suite++) {
  const name = `benchmark-suite-${suite}`;
  const base = `home/.qwen/extensions/${name}`;
  const manifest = { name, version: '1.0.0', contextFileName: 'QWEN.md' };
  if (suite <= 5) {
    manifest.hooks = {
      UserPromptSubmit: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: 'node "${extensionPath}/hooks/noop.mjs"',
            },
          ],
        },
      ],
    };
    put(`${base}/hooks/noop.mjs`, "process.stdout.write('{}\\n');\n", true);
  }
  put(`${base}/qwen-extension.json`, json(manifest), true);
  put(
    `${base}/QWEN.md`,
    `# Synthetic suite ${suite}\n\nUse local examples and state assumptions.\n`,
    true,
  );
  put(
    `${base}/commands/review.md`,
    `---\ndescription: Review generic scenario ${suite}.\n---\nSummarize the supplied example.\n`,
    true,
  );
  for (let item = 1; item <= (suite <= 3 ? 6 : 5); item++) {
    addSkill(`${base}/skills/example-${item}`, `example-${item}`);
  }
}
for (let item = 1; item <= 17; item++) {
  const base = item === 17 ? 'workspace/.qwen' : 'home/.qwen';
  addSkill(`${base}/skills/standalone-${item}`, `benchmark-standalone-${item}`);
}
assert.equal(skillCount, 90);
put(
  'home/.qwen/settings.json',
  json({
    $version: 4,
    security: { auth: { selectedType: 'openai' } },
    model: { name: 'benchmark-model' },
    telemetry: { enabled: false },
    privacy: { usageStatisticsEnabled: false },
    disableAllHooks: false,
    mcp: { allowed: [] },
  }),
);
put('home/.qwen/trustedFolders.json', json({ [workspace]: 'TRUST_FOLDER' }));
const workload = {
  synthetic: true,
  equivalentToPrivateWorkload: false,
  resources: 31,
  extensions: 14,
  standaloneSkills: 17,
  skills: skillCount,
  promptHooks: 5,
  sessionStartHooks: 0,
  mcpServers: 0,
  nativeActivationPreseeded: false,
  resourceFiles: inventory.length,
  resourceBytes: inventory.reduce((sum, file) => sum + file.bytes, 0),
};
put('synthetic-manifest.json', json({ ...workload, inventory }));
put(
  'fixture.json',
  json({
    root,
    buildDir,
    cliEntry: path.join(buildDir, 'cli.js'),
    serveModule,
    fastPathModule,
    workspace,
    home,
    qwenHome,
    tmp: path.join(root, 'tmp'),
    runtime: path.join(root, 'runtime'),
    workload,
  }),
);
console.log(JSON.stringify(workload));
