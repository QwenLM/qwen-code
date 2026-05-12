#!/usr/bin/env node
// Server-side OSS Copy Object: /releases/qwen-code/v0.0.0-pr3828-test/*
//                            -> /releases/qwen-code/latest/*
// No re-upload, just metadata copy. Lets the default `--version latest` flow
// find SHA256SUMS + tarballs on OSS so the mirror race actually picks aliyun.

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '.env');

const SOURCE_PREFIX = 'releases/qwen-code/v0.0.0-pr3828-test';
const DEST_PREFIX = 'releases/qwen-code/latest';

const FILES = [
  'qwen-code-darwin-arm64.tar.gz',
  'qwen-code-darwin-x64.tar.gz',
  'qwen-code-linux-arm64.tar.gz',
  'qwen-code-linux-x64.tar.gz',
  'qwen-code-win-x64.zip',
  'SHA256SUMS',
];

if (!fs.existsSync(ENV_FILE)) {
  console.error('Missing tools/.env');
  process.exit(1);
}

const env = {};
for (const raw of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}
for (const k of ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_ENDPOINT']) {
  if (!env[k]) {
    console.error(`Missing ${k} in tools/.env`);
    process.exit(1);
  }
}
env.OSS_ENDPOINT = env.OSS_ENDPOINT.replace(/^https?:\/\//, '').replace(/\/+$/, '');

function ossCopy({ ak, sk, endpoint, bucket, sourceKey, destKey }) {
  return new Promise((resolve, reject) => {
    const date = new Date().toUTCString();
    const copySource = `/${bucket}/${sourceKey}`;
    const ossHeaders = `x-oss-copy-source:${copySource}\nx-oss-object-acl:public-read`;
    const stringToSign = ['PUT', '', '', date, ossHeaders, `/${bucket}/${destKey}`].join('\n');
    const sig = crypto.createHmac('sha1', sk).update(stringToSign).digest('base64');

    const host = `${bucket}.${endpoint}`;
    const req = https.request(
      {
        method: 'PUT',
        host,
        path: `/${encodeURI(destKey)}`,
        headers: {
          Host: host,
          Date: date,
          'Content-Length': '0',
          'x-oss-copy-source': copySource,
          'x-oss-object-acl': 'public-read',
          Authorization: `OSS ${ak}:${sig}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`OSS COPY ${destKey} -> ${res.statusCode}\n${data}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function httpHead(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https
      .request({ method: 'HEAD', host: u.host, path: u.pathname }, (res) => resolve(res.statusCode))
      .on('error', reject)
      .end();
  });
}

const baseUrl = `https://${env.OSS_BUCKET}.${env.OSS_ENDPOINT}/${DEST_PREFIX}`;

console.log(`Copying ${FILES.length} files`);
console.log(`  src: oss://${env.OSS_BUCKET}/${SOURCE_PREFIX}/`);
console.log(`  dst: oss://${env.OSS_BUCKET}/${DEST_PREFIX}/`);
console.log('');
for (const f of FILES) {
  process.stdout.write(`  COPY ${f.padEnd(34)} ... `);
  const start = Date.now();
  await ossCopy({
    ak: env.OSS_ACCESS_KEY_ID,
    sk: env.OSS_ACCESS_KEY_SECRET,
    endpoint: env.OSS_ENDPOINT,
    bucket: env.OSS_BUCKET,
    sourceKey: `${SOURCE_PREFIX}/${f}`,
    destKey: `${DEST_PREFIX}/${f}`,
  });
  console.log(`OK (${((Date.now() - start) / 1000).toFixed(1)}s)`);
}

console.log('');
console.log('Verifying public URLs (HEAD)...');
let allOk = true;
for (const f of FILES) {
  const url = `${baseUrl}/${f}`;
  const status = await httpHead(url);
  console.log(`  ${status === 200 ? 'OK ' : 'FAIL'} ${status}  ${url}`);
  if (status !== 200) allOk = false;
}
if (!allOk) process.exit(1);

const installBaseUrl = `https://${env.OSS_BUCKET}.${env.OSS_ENDPOINT}/installation`;
console.log('');
console.log('Now `--version latest` (the default) will find SHA256SUMS on OSS,');
console.log('so race_mirror_head will pick aliyun for CN users:');
console.log('');
console.log('Linux/macOS:');
console.log(`  curl -fsSL ${installBaseUrl}/install-qwen.sh | bash`);
console.log('');
console.log('Windows PowerShell:');
console.log(`  $i = Join-Path $env:TEMP 'install-qwen.bat'; Invoke-WebRequest '${installBaseUrl}/install-qwen.bat' -OutFile $i; & $i`);
