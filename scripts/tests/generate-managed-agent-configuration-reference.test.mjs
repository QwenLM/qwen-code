/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APPLICATION_YML,
  DESCRIPTIONS,
  JAVA_SOURCES,
  METADATA,
  PAGES,
  buildReference,
  parseApplicationYml,
  parsePlaceholder,
  scanJavaPlaceholders,
} from '../generate-managed-agent-configuration-reference.mjs';

const SCRIPT = fileURLToPath(
  new URL(
    '../generate-managed-agent-configuration-reference.mjs',
    import.meta.url,
  ),
);

const YML = `spring:
  datasource:
    url: '\${SPRING_DATASOURCE_URL:jdbc:mysql://127.0.0.1:3306/db}'
logging:
  pattern:
    # A quote inside a quoted value.
    correlation: '%X{id} ''x'''
qwen:
  managed-agent:
    harness:
      enabled: '\${QWEN_MANAGED_AGENT_HARNESS_ENABLED:false}'
      base-url: '\${QWEN_MANAGED_AGENT_HARNESS_BASE_URL:http://127.0.0.1:4170}'
      token: '\${QWEN_MANAGED_AGENT_HARNESS_TOKEN:}'
      connect-timeout: '5s'
    session-store:
      enabled: '\${QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED:\${qwen.managed-agent.harness.enabled:false}}'
    dispatch:
      scan-delay: '1s'
`;

const METADATA_FIXTURE = {
  groups: [
    { name: 'qwen.managed-agent' },
    { name: 'qwen.managed-agent.harness' },
    { name: 'qwen.managed-agent.harness.pool' },
    { name: 'qwen.managed-agent.session-store' },
  ],
  properties: [
    {
      name: 'qwen.managed-agent.agent-revision',
      type: 'java.lang.String',
      defaultValue: '1',
    },
    {
      name: 'qwen.managed-agent.harness.enabled',
      type: 'java.lang.Boolean',
      defaultValue: true,
    },
    { name: 'qwen.managed-agent.harness.base-url', type: 'java.lang.String' },
    {
      name: 'qwen.managed-agent.harness.token',
      type: 'java.lang.String',
      defaultValue: 'unused',
    },
    {
      name: 'qwen.managed-agent.harness.connect-timeout',
      type: 'java.time.Duration',
      defaultValue: '1s',
    },
    {
      name: 'qwen.managed-agent.harness.request-timeout',
      type: 'java.time.Duration',
      defaultValue: '30s',
    },
    {
      name: 'qwen.managed-agent.harness.pool.instances',
      type: 'java.util.List<com.example.Instance>',
    },
    {
      name: 'qwen.managed-agent.session-store.enabled',
      type: 'java.lang.Boolean',
    },
    {
      name: 'qwen.managed-agent.definition-models',
      type: 'java.util.List<java.lang.String>',
      defaultValue: ['a|b', 'c'],
    },
  ],
};

function described(names, overrides = {}) {
  const properties = {};
  for (const name of names) {
    properties[name] = { en: `About ${name}.`, zh: `关于 ${name}。` };
  }
  // A copy, so a test that edits it leaves the shared entries alone.
  return structuredClone({
    groups: groupDescriptions(),
    properties: { ...properties, ...overrides },
  });
}

function groupDescriptions() {
  return Object.fromEntries(
    METADATA_FIXTURE.groups.map(({ name }) => [
      name,
      { en: `The ${name} group.`, zh: `${name} 分组。` },
    ]),
  );
}

const ALL = [
  ...METADATA_FIXTURE.properties.map((property) => property.name),
  'qwen.managed-agent.dispatch.scan-delay',
  'spring.datasource.url',
];
const TYPED = {
  'qwen.managed-agent.dispatch.scan-delay': {
    en: 'How often.',
    zh: '多久一次。',
    type: 'duration',
  },
  'spring.datasource.url': {
    en: 'The JDBC URL.',
    zh: 'JDBC URL。',
    type: 'string',
  },
};

function reference(
  overrides = {},
  placeholders = new Map([['qwen.managed-agent.dispatch.scan-delay', '1s']]),
) {
  return buildReference({
    metadata: METADATA_FIXTURE,
    yml: YML,
    placeholders,
    descriptions: described(ALL, { ...TYPED, ...overrides }),
  });
}

function rowOf(page, label) {
  return page.split('\n').find((line) => line.startsWith(`| \`${label}\` |`));
}

test('application.yml values come back by dotted path, unquoted', () => {
  const values = parseApplicationYml(YML);
  assert.equal(values.get('qwen.managed-agent.harness.connect-timeout'), '5s');
  assert.equal(values.get('logging.pattern.correlation'), "%X{id} 'x'");
  assert.equal(
    values.get('qwen.managed-agent.session-store.enabled'),
    '${QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED:${qwen.managed-agent.harness.enabled:false}}',
  );
  assert.equal(values.has('qwen.managed-agent.harness'), false);
});

test('application.yml constructs the reader does not know are refused', () => {
  for (const text of [
    'a:\n  - one\n',
    "a: {b: 'c'}\n",
    'a: "b"\n',
    "a: 'b\n",
  ]) {
    assert.throws(() => parseApplicationYml(text), /unsupported YAML/, text);
  }
});

test('a placeholder gives its name and fallback, nested or not', () => {
  assert.deepEqual(parsePlaceholder('${A:b}'), { name: 'A', fallback: 'b' });
  assert.deepEqual(parsePlaceholder('${A:}'), { name: 'A', fallback: '' });
  assert.deepEqual(parsePlaceholder('${A}'), {
    name: 'A',
    fallback: undefined,
  });
  assert.deepEqual(parsePlaceholder('${A:http://h:1}'), {
    name: 'A',
    fallback: 'http://h:1',
  });
  assert.deepEqual(parsePlaceholder('${A:${b.c:false}}'), {
    name: 'A',
    fallback: '${b.c:false}',
  });
  // A placeholder in the name: its colon is not the fallback's.
  assert.deepEqual(parsePlaceholder('${a.${b:c}:d}'), {
    name: 'a.${b:c}',
    fallback: 'd',
  });
  assert.equal(parsePlaceholder('${A}-${B}'), undefined);
  assert.equal(parsePlaceholder('plain'), undefined);
});

test('each row takes the variable and default application.yml gives', () => {
  const { problems, pages } = reference();
  assert.deepEqual(problems, []);
  const page = pages.en;
  assert.equal(
    rowOf(page, 'enabled'),
    '| `enabled` | `QWEN_MANAGED_AGENT_HARNESS_ENABLED` | boolean | `false` | About qwen.managed-agent.harness.enabled. |',
  );
  // application.yml's fallback, not the server's default; an empty one says so.
  assert.match(
    rowOf(page, 'token'),
    /\| `QWEN_MANAGED_AGENT_HARNESS_TOKEN` \| string \| \*\(empty\)\* \|/,
  );
  assert.match(rowOf(page, 'base-url'), /\| `http:\/\/127\.0\.0\.1:4170` \|/);
  // A literal in application.yml, with no variable.
  assert.match(
    rowOf(page, 'connect-timeout'),
    /^\| `connect-timeout` \| — \| duration \| `5s` \|/,
  );
  // Not in application.yml: the server's own default, or none.
  assert.match(rowOf(page, 'request-timeout'), /\| — \| duration \| `30s` \|/);
  assert.match(rowOf(page, 'instances'), /\| — \| YAML list \| — \|/);
  assert.match(rowOf(page, 'definition-models'), /\| list \| `a\\\|b,c` \|/);
  // A default that is another property's value.
  assert.match(
    page,
    /\| `enabled` \| `QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED` \| boolean \| follows `qwen\.managed-agent\.harness\.enabled` \|/,
  );
  // Read only through a placeholder: its type comes from the descriptions.
  assert.match(
    rowOf(page, 'dispatch.scan-delay'),
    /\| — \| duration \| `1s` \|/,
  );
  assert.match(
    rowOf(page, 'spring.datasource.url'),
    /\| `SPRING_DATASOURCE_URL` \| string \| `jdbc:mysql:\/\/127\.0\.0\.1:3306\/db` \| The JDBC URL\. \|/,
  );
});

test('the Chinese page carries the same rows in its own words', () => {
  const { pages } = reference();
  const page = pages.zh;
  assert.match(page, /^# Managed Agent 服务端配置参考\n/);
  assert.match(page, /\| 属性 \| 环境变量 \| 类型 \| 默认值 \| 说明 \|/);
  assert.match(
    rowOf(page, 'token'),
    /\| 字符串 \| \*（空）\* \| 关于 qwen\.managed-agent\.harness\.token。 \|/,
  );
  assert.match(
    page,
    /\| 布尔 \| 同 `qwen\.managed-agent\.harness\.enabled` \|/,
  );
  assert.match(
    page,
    /\[部署指南\]\(managed-agent-reference-deployment\.zh-CN\.md\)/,
  );
});

test('sections follow the groups, the top level first and the rest in order', () => {
  const { pages } = reference();
  const headings = pages.en
    .split('\n')
    .filter((line) => line.startsWith('## '));
  assert.deepEqual(headings, [
    '## Database and listener',
    '## `qwen.managed-agent`',
    '## `qwen.managed-agent.harness`',
    '## `qwen.managed-agent.harness.pool`',
    '## `qwen.managed-agent.session-store`',
  ]);
  // A setting outside every metadata group joins the top level.
  const top = pages.en.split('## `qwen.managed-agent`')[1].split('\n## ')[0];
  assert.match(top, /\| `dispatch\.scan-delay` \|/);
  assert.match(top, /\| `agent-revision` \|/);
  assert.match(
    pages.en,
    /## `qwen\.managed-agent\.harness`\n\nThe qwen\.managed-agent\.harness group\.\n/,
  );
});

test('a setting declared with its variable joins the first section', () => {
  const { problems, pages } = reference({
    'server.port': {
      en: 'The port.',
      zh: '端口。',
      type: 'integer',
      variable: 'SERVER_PORT',
      default: '8080',
    },
  });
  assert.deepEqual(problems, []);
  assert.equal(
    rowOf(pages.en, 'server.port'),
    '| `server.port` | `SERVER_PORT` | integer | `8080` | The port. |',
  );
});

test('a setting without a usable description stops the pages', () => {
  const missing = described(
    ALL.filter((name) => name !== 'qwen.managed-agent.harness.token'),
    TYPED,
  );
  missing.properties['qwen.managed-agent.harness.base-url'] = {
    en: 'A | B.',
    zh: '换\n行',
  };
  delete missing.properties['qwen.managed-agent.agent-revision'].zh;
  delete missing.groups['qwen.managed-agent.harness.pool'];
  missing.properties['qwen.managed-agent.harness.removed'] = {
    en: 'Gone.',
    zh: '已删。',
  };
  missing.groups['qwen.managed-agent.removed'] = { en: 'Gone.', zh: '已删。' };
  delete missing.properties['qwen.managed-agent.dispatch.scan-delay'].type;
  const result = buildReference({
    metadata: METADATA_FIXTURE,
    yml: `${YML}    unbound: 'x'\n`,
    placeholders: new Map([['qwen.managed-agent.dispatch.scan-delay', '1s']]),
    descriptions: missing,
  });
  assert.equal(result.pages, undefined);
  assert.deepEqual(
    result.problems.sort(),
    [
      `${APPLICATION_YML} sets qwen.managed-agent.unbound, which the server neither binds nor reads`,
      `${DESCRIPTIONS} describes group qwen.managed-agent.removed, which is no group`,
      `${DESCRIPTIONS} describes qwen.managed-agent.harness.removed, which is no setting`,
      `group qwen.managed-agent.harness.pool has no en description in ${DESCRIPTIONS}`,
      `group qwen.managed-agent.harness.pool has no zh description in ${DESCRIPTIONS}`,
      `qwen.managed-agent.agent-revision has no zh description in ${DESCRIPTIONS}`,
      'qwen.managed-agent.dispatch.scan-delay needs a "type" in ' +
        DESCRIPTIONS,
      "qwen.managed-agent.harness.base-url's en description has a | or a line break",
      "qwen.managed-agent.harness.base-url's zh description has a | or a line break",
      `qwen.managed-agent.harness.token has no en description in ${DESCRIPTIONS}`,
      `qwen.managed-agent.harness.token has no zh description in ${DESCRIPTIONS}`,
    ].sort(),
  );
});

test('the Java sources give the placeholder settings and refuse two defaults', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qma-config-reference-'));
  try {
    const one = 'first/src/main/java/a';
    const two = 'second/src/main/java/a/b';
    await mkdir(path.join(root, one), { recursive: true });
    await mkdir(path.join(root, two), { recursive: true });
    await mkdir(path.join(root, 'second/src/test/java'), { recursive: true });
    await writeFile(
      path.join(root, one, 'One.java'),
      '@Scheduled(fixedDelayString = "${qwen.managed-agent.dispatch.scan-delay:1s}")\n' +
        '@Value("${qwen.managed-agent.other.flag:false}") boolean flag;\n' +
        '@Value("${unrelated.setting:1}") int unrelated;\n',
    );
    await writeFile(
      path.join(root, two, 'Two.java'),
      '@Scheduled(fixedDelayString = "${qwen.managed-agent.dispatch.scan-delay:1s}")\n' +
        '@Scheduled(fixedDelayString = "${qwen.managed-agent.relay.scan-delay:2s}")\n',
    );
    await writeFile(
      path.join(root, two, 'notes.txt'),
      '${qwen.managed-agent.ignored:1}',
    );
    // A test's placeholder is no setting of the server.
    await writeFile(
      path.join(root, 'second/src/test/java/Fixture.java'),
      '@Value("${qwen.managed-agent.fixture.only:1}") int fixture;\n',
    );
    let scanned = await scanJavaPlaceholders(root);
    assert.deepEqual(scanned.problems, []);
    assert.deepEqual([...scanned.placeholders].sort(), [
      ['qwen.managed-agent.dispatch.scan-delay', '1s'],
      ['qwen.managed-agent.other.flag', 'false'],
      ['qwen.managed-agent.relay.scan-delay', '2s'],
    ]);
    await writeFile(
      path.join(root, two, 'Three.java'),
      '@Scheduled(fixedDelayString = "${qwen.managed-agent.relay.scan-delay:5s}")\n',
    );
    scanned = await scanJavaPlaceholders(root);
    assert.deepEqual(scanned.problems, [
      'qwen.managed-agent.relay.scan-delay has two defaults in the Java sources: 5s and 2s',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--check fails on a stale page, and passes once the pages are written', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qma-config-reference-'));
  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  try {
    for (const file of [METADATA, APPLICATION_YML, DESCRIPTIONS, PAGES.en]) {
      await mkdir(path.join(root, path.dirname(file)), { recursive: true });
    }
    const sources = path.join(root, JAVA_SOURCES, 'core/src/main/java/x');
    await mkdir(sources, { recursive: true });
    await writeFile(
      path.join(sources, 'Scan.java'),
      '@Scheduled(fixedDelayString = "${qwen.managed-agent.dispatch.scan-delay:1s}")\n',
    );
    await writeFile(path.join(root, APPLICATION_YML), YML);
    await writeFile(
      path.join(root, DESCRIPTIONS),
      JSON.stringify(described(ALL, TYPED)),
    );

    let result = run('--check');
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /cannot read .*spring-configuration-metadata\.json.*build the server first/,
    );

    await writeFile(
      path.join(root, METADATA),
      JSON.stringify(METADATA_FIXTURE),
    );
    result = run('--check');
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /docs\/users\/managed-agent-configuration-reference\.md and docs\/users\/managed-agent-configuration-reference\.zh-CN\.md are out of date; run: mvn /,
    );

    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Wrote docs\/users\/managed-agent-configuration-reference\.md/,
    );
    assert.equal(
      await readFile(path.join(root, PAGES.en), 'utf8'),
      reference().pages.en,
    );
    assert.equal(run('--check').status, 0);

    await writeFile(path.join(root, PAGES.zh), 'edited by hand\n');
    result = run('--check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /zh-CN\.md is out of date/);

    const descriptions = described(ALL.slice(1), TYPED);
    await writeFile(
      path.join(root, DESCRIPTIONS),
      JSON.stringify(descriptions),
    );
    result = run();
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /qwen\.managed-agent\.agent-revision has no en description/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
