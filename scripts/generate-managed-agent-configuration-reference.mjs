#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Writes the Managed Agent server's configuration reference, in English and
// Chinese, from three sources: the configuration metadata the server build
// writes for ManagedAgentProperties (names, types, the server's defaults),
// the packaged application.yml (environment variables and their defaults),
// and the descriptions kept in DESCRIPTIONS. --check fails when a setting has
// no description, a description names no setting, or either page differs
// from what this script writes.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const SERVER = 'packages/managed-agent-server';
export const METADATA = `${SERVER}/server/target/classes/META-INF/spring-configuration-metadata.json`;
export const APPLICATION_YML = `${SERVER}/server/src/main/resources/application.yml`;
// Every module's main sources: a setting read through a placeholder may
// live in any of them.
export const JAVA_SOURCES = SERVER;
export const DESCRIPTIONS = `${SERVER}/configuration-descriptions.json`;
export const PAGES = Object.freeze({
  en: 'docs/users/managed-agent-configuration-reference.md',
  zh: 'docs/users/managed-agent-configuration-reference.zh-CN.md',
});
const PREFIX = 'qwen.managed-agent';
// clean: an incremental build skips the metadata compile when the classes
// are newer than the sources, which keeps metadata older than the code.
const BUILD = `mvn -f ${SERVER}/pom.xml -DskipTests clean process-classes`;
const REGENERATE = `${BUILD} && node scripts/generate-managed-agent-configuration-reference.mjs`;

/**
 * The scalar settings of application.yml by dotted path, with quotes
 * removed. Only the block mappings the file uses are read; anything else is
 * refused, so a construct this reader does not know cannot be misread.
 */
export function parseApplicationYml(text) {
  const values = new Map();
  const keys = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '' || line.trim().startsWith('#')) {
      return;
    }
    const match = /^( *)([A-Za-z0-9_.-]+):(?: +(.*))?$/.exec(line);
    if (!match) {
      throw new Error(`application.yml:${index + 1}: unsupported YAML`);
    }
    const [, indent, key, raw] = match;
    while (keys.length > 0 && keys.at(-1).indent >= indent.length) {
      keys.pop();
    }
    keys.push({ indent: indent.length, key });
    if (raw !== undefined) {
      values.set(keys.map((each) => each.key).join('.'), scalar(raw, index));
    }
  });
  return values;
}

function scalar(raw, index) {
  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) {
      throw new Error(`application.yml:${index + 1}: unsupported YAML`);
    }
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  if (/^["[{|>&*!]/.test(raw)) {
    throw new Error(`application.yml:${index + 1}: unsupported YAML`);
  }
  return raw.replace(/ +#.*$/, '');
}

/**
 * `${NAME:default}` as { name, fallback }, where the fallback may itself be
 * a placeholder; undefined for a value that is not one placeholder.
 */
export function parsePlaceholder(value) {
  if (!value.startsWith('${') || !value.endsWith('}')) {
    return undefined;
  }
  let depth = 0;
  let colon = -1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith('${', index)) {
      depth += 1;
      index += 1;
    } else if (value[index] === '}') {
      depth -= 1;
      if (depth === 0 && index !== value.length - 1) {
        return undefined;
      }
    } else if (value[index] === ':' && depth === 1 && colon < 0) {
      colon = index;
    }
  }
  const name = value.slice(2, colon < 0 ? -1 : colon);
  return {
    name,
    fallback: colon < 0 ? undefined : value.slice(colon + 1, -1),
  };
}

/**
 * The settings read through `${qwen.managed-agent.…}` placeholders in the
 * main Java sources under `root` (each `src/main/java`, not tests), such as
 * scheduling delays, by name, with their defaults.
 */
export async function scanJavaPlaceholders(root) {
  const found = new Map();
  const problems = [];
  const pattern = /\$\{(qwen\.managed-agent\.[a-z0-9.-]+)(?::([^}"]*))?\}/g;
  for (const file of await javaFiles(root)) {
    const text = await readFile(file, 'utf8');
    for (const [, name, fallback] of text.matchAll(pattern)) {
      if (found.has(name) && found.get(name) !== fallback) {
        problems.push(
          `${name} has two defaults in the Java sources: ${found.get(name)} and ${fallback}`,
        );
      }
      found.set(name, fallback);
    }
  }
  return { placeholders: found, problems };
}

async function javaFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await javaFiles(full)));
    } else if (
      entry.name.endsWith('.java') &&
      full.split(path.sep).join('/').includes('/src/main/java/')
    ) {
      files.push(full);
    }
  }
  return files.sort();
}

const TYPES = {
  boolean: ['java.lang.Boolean', 'boolean'],
  integer: [
    'java.lang.Integer',
    'int',
    'java.lang.Long',
    'long',
    'java.lang.Short',
  ],
  number: ['java.lang.Double', 'double', 'java.lang.Float'],
  duration: ['java.time.Duration'],
  size: ['org.springframework.util.unit.DataSize'],
  string: ['java.lang.String'],
  path: ['java.nio.file.Path'],
  list: ['java.util.List<java.lang.String>', 'java.util.Set<java.lang.String>'],
};

function typeOf(javaType) {
  for (const [label, types] of Object.entries(TYPES)) {
    if (types.includes(javaType)) {
      return label;
    }
  }
  if (/^java\.util\.(List|Set)</.test(javaType)) {
    return 'yaml-list';
  }
  if (/^java\.util\.Map</.test(javaType)) {
    return 'yaml-map';
  }
  return javaType.replace(/^.*[.$]/, '');
}

const WORDS = {
  en: {
    title: 'Managed Agent server configuration reference',
    columns: ['Property', 'Variable', 'Type', 'Default', 'Description'],
    other: 'Database and listener',
    otherIntro:
      'Spring settings the packaged `application.yml` maps to variables, and the listener port.',
    empty: '*(empty)*',
    none: '—',
    follows: (name) => `follows \`${name}\``,
    types: {
      boolean: 'boolean',
      integer: 'integer',
      number: 'number',
      duration: 'duration',
      size: 'size',
      string: 'string',
      path: 'path',
      list: 'list',
      'yaml-list': 'YAML list',
      'yaml-map': 'YAML map',
    },
    intro: [
      "Every setting of the Managed Agent control plane, `qwen-managed-agent-server`. The page is generated from the server build's configuration metadata, the packaged `application.yml` and `packages/managed-agent-server/configuration-descriptions.json`; edit that file, not this page, and regenerate:",
      '',
      '```bash',
      REGENERATE,
      '```',
      '',
      '- **Variable** is the environment variable the packaged `application.yml` maps to the property, which `server.env` sets. A property without one is set in `config/application.yml`, which the launchers load when it exists; see the [deployment guide](managed-agent-reference-deployment.md).',
      "- **Default** is what the packaged `application.yml` sets, or else the server's own default. *(empty)* is an empty value, *follows* names the property whose value is the default, and — means no value: the description says what applies then.",
      '- A **duration** is a number with a unit, such as `500ms`, `30s`, `10m`, `24h` or `30d`. Always write the unit: a bare number does not mean the same unit everywhere.',
      '- A **list** takes comma-separated values in a variable. A **YAML list** or **YAML map** can only be set in a configuration file.',
    ],
  },
  zh: {
    title: 'Managed Agent 服务端配置参考',
    columns: ['属性', '环境变量', '类型', '默认值', '说明'],
    other: '数据库与监听',
    otherIntro:
      '打包的 `application.yml` 映射到环境变量的 Spring 设置，以及监听端口。',
    empty: '*（空）*',
    none: '—',
    follows: (name) => `同 \`${name}\``,
    types: {
      boolean: '布尔',
      integer: '整数',
      number: '数值',
      duration: '时长',
      size: '大小',
      string: '字符串',
      path: '路径',
      list: '列表',
      'yaml-list': 'YAML 列表',
      'yaml-map': 'YAML 映射',
    },
    intro: [
      'Managed Agent 控制面 `qwen-managed-agent-server` 的全部设置。本页由服务端构建生成的配置元数据、打包的 `application.yml` 和 `packages/managed-agent-server/configuration-descriptions.json` 生成；请修改该文件而不是本页，然后重新生成：',
      '',
      '```bash',
      REGENERATE,
      '```',
      '',
      '- **环境变量**是打包的 `application.yml` 为该属性映射的环境变量，在 `server.env` 中设置。没有环境变量的属性写在 `config/application.yml` 中，该文件存在时启动脚本会加载它，见[部署指南](managed-agent-reference-deployment.zh-CN.md)。',
      '- **默认值**是打包的 `application.yml` 设置的值，没有时为服务端自身的默认值。*（空）* 表示空值，“同”指默认值取自所列属性的值，— 表示没有值，此时的行为见说明。',
      '- **时长**是带单位的数字，例如 `500ms`、`30s`、`10m`、`24h` 或 `30d`。请始终写上单位：不带单位的数字在不同属性中单位并不相同。',
      '- **列表**在环境变量中用逗号分隔。**YAML 列表**和 **YAML 映射**只能写在配置文件中。',
    ],
  },
};

/**
 * Both pages and what keeps them from being written: the settings come from
 * `metadata` (spring-configuration-metadata.json), `yml` (application.yml's
 * text), `placeholders` (from scanJavaPlaceholders) and `descriptions`.
 */
export function buildReference({ metadata, yml, placeholders, descriptions }) {
  const problems = [];
  const values = parseApplicationYml(yml);
  const groups = metadata.groups
    .map((group) => group.name)
    .filter((name) => name === PREFIX || name.startsWith(`${PREFIX}.`));
  const settings = new Map();
  for (const property of metadata.properties) {
    settings.set(property.name, {
      type: typeOf(property.type ?? ''),
      fallback: serverDefault(property.defaultValue),
    });
  }
  for (const [name, fallback] of placeholders) {
    if (!settings.has(name)) {
      settings.set(name, { fallback: serverDefault(fallback) });
    }
  }
  const other = new Set();
  for (const [name, value] of values) {
    if (name.startsWith(`${PREFIX}.`)) {
      if (!settings.has(name)) {
        problems.push(
          `${APPLICATION_YML} sets ${name}, which the server neither binds nor reads`,
        );
      }
    } else if (parsePlaceholder(value)) {
      other.add(name);
    }
  }
  const described = descriptions.properties ?? {};
  for (const [name, entry] of Object.entries(described)) {
    if (entry.variable !== undefined && !settings.has(name)) {
      other.add(name);
    }
  }
  const all = [...settings.keys(), ...other];
  for (const name of all) {
    const entry = described[name];
    for (const language of ['en', 'zh']) {
      const text = entry?.[language];
      if (typeof text !== 'string' || text.trim() === '') {
        problems.push(
          `${name} has no ${language} description in ${DESCRIPTIONS}`,
        );
      } else if (/[|\n]/.test(text)) {
        problems.push(
          `${name}'s ${language} description has a | or a line break`,
        );
      }
    }
    if (!settings.get(name)?.type && !entry?.type) {
      problems.push(`${name} needs a "type" in ${DESCRIPTIONS}`);
    }
  }
  for (const name of Object.keys(described)) {
    if (!all.includes(name)) {
      problems.push(`${DESCRIPTIONS} describes ${name}, which is no setting`);
    }
  }
  for (const group of groups) {
    for (const language of ['en', 'zh']) {
      if (!descriptions.groups?.[group]?.[language]) {
        problems.push(
          `group ${group} has no ${language} description in ${DESCRIPTIONS}`,
        );
      }
    }
  }
  for (const group of Object.keys(descriptions.groups ?? {})) {
    if (!groups.includes(group)) {
      problems.push(
        `${DESCRIPTIONS} describes group ${group}, which is no group`,
      );
    }
  }
  if (problems.length > 0) {
    return { problems };
  }

  const row = (language, label, name) => {
    const words = WORDS[language];
    const entry = described[name];
    const raw = values.get(name);
    const placeholder = raw === undefined ? undefined : parsePlaceholder(raw);
    const variable =
      entry.variable ??
      (placeholder && /^[A-Z][A-Z0-9_]*$/.test(placeholder.name)
        ? placeholder.name
        : undefined);
    let fallback;
    if (entry.default !== undefined) {
      fallback = { value: entry.default };
    } else if (raw === undefined) {
      fallback = settings.get(name)?.fallback;
    } else if (!placeholder) {
      fallback = { value: raw };
    } else if (placeholder.fallback === undefined) {
      fallback = undefined;
    } else {
      const inner = parsePlaceholder(placeholder.fallback);
      fallback = inner
        ? { follows: inner.name }
        : { value: placeholder.fallback };
    }
    const type = entry.type ?? settings.get(name).type;
    return [
      code(label),
      variable ? code(variable) : words.none,
      words.types[type] ?? code(type),
      fallback === undefined
        ? words.none
        : fallback.follows
          ? words.follows(fallback.follows)
          : fallback.value === ''
            ? words.empty
            : code(fallback.value),
      entry[language],
    ];
  };
  const table = (language, rows) => {
    const words = WORDS[language];
    return [
      `| ${words.columns.join(' | ')} |`,
      `| ${words.columns.map(() => '---').join(' | ')} |`,
      ...rows.map((cells) => `| ${cells.join(' | ')} |`),
    ];
  };
  const groupOf = (name) =>
    groups
      .filter((group) => name.startsWith(`${group}.`))
      .sort((left, right) => right.length - left.length)[0] ?? PREFIX;
  const ordered = [PREFIX, ...groups.filter((each) => each !== PREFIX).sort()];
  const pages = {};
  for (const language of ['en', 'zh']) {
    const words = WORDS[language];
    const lines = [
      `# ${words.title}`,
      '',
      `[English](${path.basename(PAGES.en)}) | [简体中文](${path.basename(PAGES.zh)})`,
      '',
      `<!-- Generated by scripts/generate-managed-agent-configuration-reference.mjs; edit ${DESCRIPTIONS} instead. -->`,
      '',
      ...words.intro,
      '',
      `## ${words.other}`,
      '',
      words.otherIntro,
      '',
      ...table(
        language,
        [...other].sort().map((name) => row(language, name, name)),
      ),
    ];
    for (const group of ordered) {
      const members = [...settings.keys()]
        .filter((name) => groupOf(name) === group)
        .sort();
      if (members.length === 0) {
        continue;
      }
      lines.push(
        '',
        `## \`${group}\``,
        '',
        descriptions.groups[group][language],
        '',
        ...table(
          language,
          members.map((name) =>
            row(language, name.slice(group.length + 1), name),
          ),
        ),
      );
    }
    pages[language] = `${lines.join('\n')}\n`;
  }
  return { problems, pages };
}

function serverDefault(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return { value: value.join(',') };
  }
  return { value: String(value) };
}

function code(value) {
  const text = String(value).replaceAll('|', '\\|');
  const fence = text.includes('`') ? '``' : '`';
  return `${fence}${text}${fence}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      metadata: { type: 'string', default: METADATA },
    },
  });
  let metadata;
  try {
    metadata = JSON.parse(await readFile(values.metadata, 'utf8'));
  } catch (error) {
    throw new Error(
      `cannot read ${values.metadata} (${error.message}); build the server first: ${BUILD}`,
    );
  }
  const scanned = await scanJavaPlaceholders(JAVA_SOURCES);
  const result = buildReference({
    metadata,
    yml: await readFile(APPLICATION_YML, 'utf8'),
    placeholders: scanned.placeholders,
    descriptions: JSON.parse(await readFile(DESCRIPTIONS, 'utf8')),
  });
  const problems = [...scanned.problems, ...result.problems];
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
  const stale = [];
  for (const [language, page] of Object.entries(PAGES)) {
    const current = await readFile(page, 'utf8').catch(() => undefined);
    if (current === result.pages[language]) {
      continue;
    }
    if (values.check) {
      stale.push(page);
    } else {
      await writeFile(page, result.pages[language]);
      console.log(`Wrote ${page}`);
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `${stale.join(' and ')} ${stale.length > 1 ? 'are' : 'is'} out of date; run: ${REGENERATE}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
