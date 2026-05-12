#!/usr/bin/env node
// Upload one or more standalone release archives + SHA256SUMS to a mirror path
// on the staging OSS bucket, so install-qwen.sh can be tested with
// QWEN_INSTALL_BASE_URL pointing at OSS instead of slow GitHub release CDN.
//
// Usage:
//   node tools/upload-release-mirror.mjs                   # uploads linux-x64 + SHA256SUMS
//   node tools/upload-release-mirror.mjs all               # uploads all 5 tarballs + SHA256SUMS
//   node tools/upload-release-mirror.mjs darwin-arm64 win-x64

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release-staging');
const ENV_FILE = path.join(__dirname, '.env');
const VERSION_TAG = 'v0.0.0-pr3828-test';

const ALL_TARGETS = {
  'darwin-arm64': 'qwen-code-darwin-arm64.tar.gz',
  'darwin-x64':   'qwen-code-darwin-x64.tar.gz',
  'linux-arm64':  'qwen-code-linux-arm64.tar.gz',
  'linux-x64':    'qwen-code-linux-x64.tar.gz',
  'win-x64':      'qwen-code-win-x64.zip',
};

function bail(msg) {
  console.error(msg);
  process.exit(1);
}

function loadEnv(file) {
  if (!fs.existsSync(file)) {
    bail(`Missing ${file}. Copy tools/.env.example to tools/.env and fill it in.`);
  }
  const env = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return env;
}

function ossPut({ ak, sk, endpoint, bucket, objectKey, body, contentType }) {
  return new Promise((resolve, reject) => {
    const date = new Date().toUTCString();
    const md5 = crypto.createHash('md5').update(body).digest('base64');
    const ossHeaders = 'x-oss-object-acl:public-read';
    const stringToSign = [
      'PUT',
      md5,
      contentType,
      date,
      ossHeaders,
      `/${bucket}/${objectKey}`,
    ].join('\n');
    const sig = crypto.createHmac('sha1', sk).update(stringToSign).digest('base64');
    const host = `${bucket}.${endpoint}`;
    const req = https.request(
      {
        method: 'PUT',
        host,
        path: `/${encodeURI(objectKey)}`,
        headers: {
          Host: host,
          Date: date,
          'Content-Type': contentType,
          'Content-Length': body.length,
          'Content-MD5': md5,
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
            reject(new Error(`OSS PUT ${objectKey} -> ${res.statusCode}\n${data}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpHead(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https
      .request({ method: 'HEAD', host: u.host, path: u.pathname }, (res) =>
        resolve({ status: res.statusCode, contentLength: res.headers['content-length'] }),
      )
      .on('error', reject)
      .end();
  });
}

const env = loadEnv(ENV_FILE);
for (const k of ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_ENDPOINT']) {
  if (!env[k]) bail(`Missing ${k} in tools/.env`);
}
if (env.OSS_BUCKET === 'qwen-code-assets') {
  bail('Refusing to upload to production bucket qwen-code-assets.');
}
env.OSS_ENDPOINT = env.OSS_ENDPOINT.replace(/^https?:\/\//, '').replace(/\/+$/, '');

const args = process.argv.slice(2);
let selected;
if (args.length === 0) {
  selected = ['linux-x64'];
} else if (args.length === 1 && args[0] === 'all') {
  selected = Object.keys(ALL_TARGETS);
} else {
  selected = args.map((a) => {
    if (!ALL_TARGETS[a]) bail(`Unknown target: ${a}. Valid: ${Object.keys(ALL_TARGETS).join(', ')} | all`);
    return a;
  });
}

if (!fs.existsSync(RELEASE_DIR)) {
  bail(`Missing ${RELEASE_DIR}. Run: npm run package:standalone:release -- --version ${VERSION_TAG} --out-dir ./release-staging`);
}

const prefix = `releases/qwen-code/${VERSION_TAG}`;
const baseUrl = `https://${env.OSS_BUCKET}.${env.OSS_ENDPOINT}/${prefix}`;

const filesToUpload = [
  ...selected.map((t) => ({
    name: ALL_TARGETS[t],
    contentType: ALL_TARGETS[t].endsWith('.zip')
      ? 'application/zip'
      : 'application/gzip',
  })),
  { name: 'SHA256SUMS', contentType: 'text/plain' },
];

console.log(`Uploading ${filesToUpload.length} files to oss://${env.OSS_BUCKET}/${prefix}/ ...`);
for (const f of filesToUpload) {
  const local = path.join(RELEASE_DIR, f.name);
  if (!fs.existsSync(local)) bail(`Missing ${local}`);
  const body = fs.readFileSync(local);
  const sizeMb = (body.length / 1024 / 1024).toFixed(1);
  process.stdout.write(`  PUT ${f.name.padEnd(34)} ${sizeMb.padStart(6)} MB ... `);
  const start = Date.now();
  await ossPut({
    ak: env.OSS_ACCESS_KEY_ID,
    sk: env.OSS_ACCESS_KEY_SECRET,
    endpoint: env.OSS_ENDPOINT,
    bucket: env.OSS_BUCKET,
    objectKey: `${prefix}/${f.name}`,
    body,
    contentType: f.contentType,
  });
  console.log(`OK (${((Date.now() - start) / 1000).toFixed(1)}s)`);
}

console.log('\nVerifying public URLs (HEAD)...');
let allOk = true;
for (const f of filesToUpload) {
  const url = `${baseUrl}/${f.name}`;
  const { status, contentLength } = await httpHead(url);
  const tag = status === 200 ? 'OK  ' : 'FAIL';
  console.log(`  ${tag} ${status}  ${(contentLength || '?').padStart(10)} B  ${url}`);
  if (status !== 200) allOk = false;
}
if (!allOk) bail('\nOne or more URLs not reachable.');

console.log('\n=== Done ===');
console.log(`\nLinux/macOS test command (uses your OSS as mirror):`);
console.log(`  QWEN_INSTALL_BASE_URL=${baseUrl} \\`);
console.log(`    bash <(curl -fsSL https://${env.OSS_BUCKET}.${env.OSS_ENDPOINT}/installation/install-qwen.sh)`);
console.log(`\nWindows PowerShell test command:`);
console.log(`  $env:QWEN_INSTALL_BASE_URL='${baseUrl}'`);
console.log(`  $i = Join-Path $env:TEMP 'install-qwen.bat'`);
console.log(`  Invoke-WebRequest 'https://${env.OSS_BUCKET}.${env.OSS_ENDPOINT}/installation/install-qwen.bat' -OutFile $i`);
console.log(`  & $i`);
console.log('');
