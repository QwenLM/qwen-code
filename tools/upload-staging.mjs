#!/usr/bin/env node
// Upload hosted-staging/{install-qwen.sh,install-qwen.bat,SHA256SUMS} to your
// own staging OSS bucket using credentials from tools/.env.
//
// Usage:
//   1. cp tools/.env.example tools/.env && fill in
//   2. node tools/upload-staging.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STAGING_DIR = path.join(ROOT, 'hosted-staging');
const ENV_FILE = path.join(__dirname, '.env');

const FILES = [
  { name: 'install-qwen.sh', contentType: 'application/x-sh' },
  { name: 'install-qwen.bat', contentType: 'application/octet-stream' },
  { name: 'SHA256SUMS', contentType: 'text/plain' },
];

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

function bail(msg) {
  console.error(msg);
  process.exit(1);
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
    const sig = crypto
      .createHmac('sha1', sk)
      .update(stringToSign)
      .digest('base64');

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
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(
                `OSS PUT ${objectKey} -> ${res.statusCode}\n${data}`,
              ),
            );
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
    const req = https.request(
      { method: 'HEAD', host: u.host, path: u.pathname },
      (res) => resolve(res.statusCode),
    );
    req.on('error', reject);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      })
      .on('error', reject);
  });
}

const env = loadEnv(ENV_FILE);
for (const k of [
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'OSS_BUCKET',
  'OSS_ENDPOINT',
]) {
  if (!env[k]) bail(`Missing ${k} in tools/.env`);
}
if (env.OSS_BUCKET === 'qwen-code-assets') {
  bail('Refusing to upload to production bucket qwen-code-assets. Use a staging bucket.');
}
env.OSS_ENDPOINT = env.OSS_ENDPOINT.replace(/^https?:\/\//, '').replace(/\/+$/, '');
const prefix = (env.OSS_PREFIX || 'installation').replace(/^\/+|\/+$/g, '');

if (!fs.existsSync(STAGING_DIR)) {
  bail(`Missing ${STAGING_DIR}. Run: npm run package:hosted-installation -- --out-dir ./hosted-staging`);
}

const baseUrl = `https://${env.OSS_BUCKET}.${env.OSS_ENDPOINT}/${prefix}`;

console.log(`Uploading to oss://${env.OSS_BUCKET}/${prefix}/ ...`);
for (const f of FILES) {
  const local = path.join(STAGING_DIR, f.name);
  const body = fs.readFileSync(local);
  process.stdout.write(`  PUT ${f.name.padEnd(20)} ${body.length.toString().padStart(6)} bytes ... `);
  await ossPut({
    ak: env.OSS_ACCESS_KEY_ID,
    sk: env.OSS_ACCESS_KEY_SECRET,
    endpoint: env.OSS_ENDPOINT,
    bucket: env.OSS_BUCKET,
    objectKey: `${prefix}/${f.name}`,
    body,
    contentType: f.contentType,
  });
  console.log('OK');
}

console.log('\nVerifying public URLs (HEAD)...');
let allOk = true;
for (const f of FILES) {
  const url = `${baseUrl}/${f.name}`;
  const status = await httpHead(url);
  const tag = status === 200 ? 'OK  ' : 'FAIL';
  console.log(`  ${tag} ${status}  ${url}`);
  if (status !== 200) allOk = false;
}
if (!allOk) bail('\nOne or more URLs not reachable. Check bucket ACL.');

console.log('\nVerifying remote SHA256SUMS matches local...');
const remote = await httpGet(`${baseUrl}/SHA256SUMS`);
const local = fs.readFileSync(path.join(STAGING_DIR, 'SHA256SUMS'), 'utf8');
if (remote.body.trim() === local.trim()) {
  console.log('  OK  remote SHA256SUMS matches local');
} else {
  console.log('  FAIL remote != local');
  console.log('--- local ---\n' + local);
  console.log('--- remote ---\n' + remote.body);
  process.exit(1);
}

console.log('\n=== Done ===');
console.log(`\nECS test entry point (Linux/macOS):`);
console.log(`  curl -fsSL ${baseUrl}/install-qwen.sh | bash`);
console.log(`\nECS test entry point (Windows PowerShell):`);
console.log(`  $i = Join-Path $env:TEMP 'install-qwen.bat'; Invoke-WebRequest '${baseUrl}/install-qwen.bat' -OutFile $i; & $i`);
console.log(`\nGitHub Actions input (installer_base_url):`);
console.log(`  ${baseUrl}\n`);
