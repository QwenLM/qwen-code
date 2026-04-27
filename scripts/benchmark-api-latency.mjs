#!/usr/bin/env node
/**
 * API Preconnect Latency Benchmark
 *
 * Measures the real TCP+TLS connection reuse benefit of preconnect by using
 * undici (the same library as apiPreconnect.ts) within a single process.
 *
 * Unlike the previous curl-based approach, this correctly measures connection
 * pool reuse: the same dispatcher instance is shared between the preconnect
 * HEAD request and the subsequent measured request, just like in production.
 *
 * Usage:
 *   node scripts/benchmark-api-latency.mjs
 *
 * Environment variables:
 *   ITERATIONS=3              Number of cold/warm pairs per endpoint (default: 3)
 *   REQUEST_TIMEOUT_MS=5000   Per-request timeout in ms (default: 5000)
 *   BENCHMARK_URLS            Space-separated extra URLs to benchmark
 */

import { createRequire } from 'module';
import { performance } from 'perf_hooks';

// Resolve undici from the core package (same version used by preconnect)
const require = createRequire(import.meta.url);
const { Agent } = require('../packages/core/node_modules/undici/index.js');

const ITERATIONS = parseInt(process.env['ITERATIONS'] ?? '3', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env['REQUEST_TIMEOUT_MS'] ?? '5000', 10);

const DEFAULT_ENDPOINTS = [
  { url: 'https://api.openai.com',                              label: 'OpenAI' },
  { url: 'https://api.anthropic.com',                          label: 'Anthropic' },
  { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', label: 'DashScope (openai-compatible)' },
];

const extraUrls = process.env['BENCHMARK_URLS']
  ? process.env['BENCHMARK_URLS'].split(' ').filter(Boolean).map((url) => ({ url, label: url }))
  : [];

const ENDPOINTS = [...DEFAULT_ENDPOINTS, ...extraUrls];

// ---------------------------------------------------------------------------

function newDispatcher() {
  return new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    keepAliveTimeout: 60_000,
  });
}

async function fetchOnce(url, dispatcher, method = 'HEAD') {
  const start = performance.now();
  try {
    await fetch(url, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'QwenCode-Benchmark/1.0' },
      dispatcher,
    });
  } catch (err) {
    // Timeouts and non-2xx are fine — we only care about connection timing
    if (err?.name === 'TimeoutError') {
      return performance.now() - start; // still records the time spent
    }
  }
  return performance.now() - start;
}

/**
 * Cold measurement: brand-new dispatcher, no preconnect.
 * Returns elapsed ms of the measured request.
 */
async function measureCold(url) {
  const dispatcher = newDispatcher();
  return fetchOnce(url, dispatcher, 'HEAD');
}

/**
 * Warm measurement: same dispatcher for preconnect HEAD + measured request.
 * Returns elapsed ms of the measured request only (not the preconnect time).
 */
async function measureWarm(url) {
  const dispatcher = newDispatcher();
  // Preconnect — mirrors apiPreconnect.ts behaviour
  await fetchOnce(url, dispatcher, 'HEAD').catch(() => {});
  // Measured request reuses the warmed connection from the same pool
  return fetchOnce(url, dispatcher, 'HEAD');
}

// ---------------------------------------------------------------------------

function fmt(ms) {
  return `${ms.toFixed(1)}ms`;
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function benchmarkEndpoint({ url, label }) {
  console.log(`\n  ${label}`);
  console.log(`  ${url}`);

  const coldTimes = [];
  const warmTimes = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const cold = await measureCold(url);
    coldTimes.push(cold);

    // Brief pause so the OS can release the cold connection
    await new Promise((r) => setTimeout(r, 500));

    const warm = await measureWarm(url);
    warmTimes.push(warm);

    console.log(`    run ${i + 1}: cold=${fmt(cold)}  warm=${fmt(warm)}`);

    await new Promise((r) => setTimeout(r, 500));
  }

  const avgCold = avg(coldTimes);
  const avgWarm = avg(warmTimes);
  const saved = avgCold - avgWarm;
  const pct = avgCold > 0 ? (saved / avgCold) * 100 : 0;

  return { label, url, avgCold, avgWarm, saved, pct };
}

// ---------------------------------------------------------------------------

console.log('=== Qwen Code API Preconnect Latency Benchmark ===');
console.log(`Iterations per endpoint : ${ITERATIONS}`);
console.log(`Request timeout         : ${REQUEST_TIMEOUT_MS}ms`);
console.log('\nRunning...');

const results = [];
for (const endpoint of ENDPOINTS) {
  const result = await benchmarkEndpoint(endpoint);
  results.push(result);
}

// Summary table
console.log('\n\n=== Results ===\n');
console.log(
  'Endpoint'.padEnd(36) +
  'Cold (avg)'.padStart(12) +
  'Warm (avg)'.padStart(12) +
  'Saved'.padStart(10) +
  'Improvement'.padStart(13),
);
console.log('─'.repeat(83));

for (const r of results) {
  const status = r.pct >= 30 ? '✓' : r.pct >= 10 ? '~' : '✗';
  console.log(
    r.label.slice(0, 35).padEnd(36) +
    fmt(r.avgCold).padStart(12) +
    fmt(r.avgWarm).padStart(12) +
    fmt(r.saved).padStart(10) +
    `${r.pct.toFixed(1)}% ${status}`.padStart(13),
  );
}

console.log('\nLegend: ✓ ≥30% improvement   ~ 10–30%   ✗ <10%');
