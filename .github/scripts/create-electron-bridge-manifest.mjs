#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const options = parseArguments(process.argv.slice(2));
const assets = fs.readdirSync(options.assets).sort();
const names = [
  'Qwen-Code-Desktop-arm64.zip',
  'Qwen-Code-Desktop-x64.zip',
  'Qwen-Code-Desktop-arm64.dmg',
  'Qwen-Code-Desktop-x64.dmg',
];
const artifacts = names.map((name) => readArtifact(assets, name));
const primary = artifacts[0];

const lines = [
  `version: ${options.version}`,
  'files:',
  ...artifacts.flatMap((artifact) => [
    `  - url: ${artifact.name}`,
    `    sha512: ${artifact.sha512}`,
    `    size: ${artifact.size}`,
  ]),
  `path: ${primary.name}`,
  `sha512: ${primary.sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
];
fs.writeFileSync(options.output, `${lines.join('\n')}\n`);

function readArtifact(assets, name) {
  if (!assets.includes(name)) {
    throw new Error(`Missing Electron bridge artifact: ${name}`);
  }
  const file = path.join(options.assets, name);
  return {
    name,
    sha512: crypto
      .createHash('sha512')
      .update(fs.readFileSync(file))
      .digest('base64'),
    size: fs.statSync(file).size,
  };
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, '');
    const value = args[index + 1];
    if (!name || value === undefined) throw new Error('Invalid arguments.');
    values[name] = value;
  }
  for (const required of ['assets', 'version', 'output']) {
    if (!values[required]) throw new Error(`Missing --${required}`);
  }
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      values.version,
    )
  ) {
    throw new Error(`Invalid --version: ${values.version}`);
  }
  return values;
}
