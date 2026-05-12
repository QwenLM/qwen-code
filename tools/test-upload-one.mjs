#!/usr/bin/env node
// One-shot OSS upload smoke test: PUT only SHA256SUMS, then HEAD verify.
// Used to validate credentials + bucket ACL before running the full upload.

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '.env');
const TARGET = path.resolve(__dirname, '..', 'hosted-staging', 'SHA256SUMS');

if (!fs.existsSync(ENV_FILE)) {
  console.error('Missing tools/.env');
  process.exit(1);
}
if (!fs.existsSync(TARGET)) {
  console.error(`Missing ${TARGET}`);
  process.exit(1);
}

const env = {};
for (const raw of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}
for (const k of [
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'OSS_BUCKET',
  'OSS_ENDPOINT',
]) {
  if (!env[k]) {
    console.error(`Missing ${k} in tools/.env`);
    process.exit(1);
  }
}
if (env.OSS_BUCKET === 'qwen-code-assets') {
  console.error('Refusing to upload to production bucket qwen-code-assets.');
  process.exit(1);
}
env.OSS_ENDPOINT = env.OSS_ENDPOINT.replace(/^https?:\/\//, '').replace(/\/+$/, '');
const prefix = (env.OSS_PREFIX || 'installation').replace(/^\/+|\/+$/g, '');
const objectKey = `${prefix}/SHA256SUMS`;
const baseUrl = `https://${env.OSS_BUCKET}.${env.OSS_ENDPOINT}/${prefix}`;
const objectUrl = `${baseUrl}/SHA256SUMS`;

console.log(`Bucket:      ${env.OSS_BUCKET}`);
console.log(`Endpoint:    ${env.OSS_ENDPOINT}`);
console.log(`Object key:  ${objectKey}`);
console.log(`Public URL:  ${objectUrl}`);
console.log('');

const body = fs.readFileSync(TARGET);
const date = new Date().toUTCString();
const md5 = crypto.createHash('md5').update(body).digest('base64');
const ossHeaders = 'x-oss-object-acl:public-read';
const stringToSign = [
  'PUT',
  md5,
  'text/plain',
  date,
  ossHeaders,
  `/${env.OSS_BUCKET}/${objectKey}`,
].join('\n');
const sig = crypto
  .createHmac('sha1', env.OSS_ACCESS_KEY_SECRET)
  .update(stringToSign)
  .digest('base64');

const host = `${env.OSS_BUCKET}.${env.OSS_ENDPOINT}`;
console.log(`PUT https://${host}/${objectKey} (${body.length} bytes) ...`);

await new Promise((resolve, reject) => {
  const req = https.request(
    {
      method: 'PUT',
      host,
      path: `/${encodeURI(objectKey)}`,
      headers: {
        Host: host,
        Date: date,
        'Content-Type': 'text/plain',
        'Content-Length': body.length,
        'Content-MD5': md5,
        'x-oss-object-acl': 'public-read',
        Authorization: `OSS ${env.OSS_ACCESS_KEY_ID}:${sig}`,
      },
    },
    (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        console.log(`  -> HTTP ${res.statusCode}`);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          console.error('--- response body ---');
          console.error(data);
          reject(new Error(`PUT failed: ${res.statusCode}`));
        }
      });
    },
  );
  req.on('error', reject);
  req.write(body);
  req.end();
});

console.log('');
console.log(`HEAD ${objectUrl} ...`);
const headStatus = await new Promise((resolve, reject) => {
  const u = new URL(objectUrl);
  const req = https.request(
    { method: 'HEAD', host: u.host, path: u.pathname },
    (res) => resolve(res.statusCode),
  );
  req.on('error', reject);
  req.end();
});
console.log(`  -> HTTP ${headStatus}`);

console.log('');
console.log(`GET ${objectUrl} ...`);
const remote = await new Promise((resolve, reject) => {
  https
    .get(objectUrl, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    })
    .on('error', reject);
});
console.log(`  -> HTTP ${remote.status}, ${remote.body.length} bytes`);

const local = fs.readFileSync(TARGET, 'utf8');
if (remote.body.trim() === local.trim()) {
  console.log('');
  console.log('✓ Smoke test passed. Credentials, ACL, and HEAD/GET all OK.');
  console.log('  You can now run: node tools/upload-staging.mjs');
} else {
  console.log('');
  console.log('✗ Remote body differs from local SHA256SUMS.');
  process.exit(1);
}
