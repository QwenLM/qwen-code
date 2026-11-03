/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The Java integration-test jobs split `*IT.java` by name: `Hosted*IT` runs
// only in the Hosted MySQL job, and every other `*IT` runs in the MySQL 8.4
// mysql-integration job.
// Maven still passes when a profile's <includes>, or -Dit.test in MAVEN_ARGS
// or .mvn/maven.config, narrows that selection, so after a job's tests this
// compares the failsafe reports with the source tree of each module: every
// `*IT` class of the job's family must have run at least one test (so an
// abstract base class must not end in IT), and no other test class may have
// run. The reports also record Maven's user properties, so a run under
// -Dit.test or -Dfailsafe.includesFile/excludesFile given on the command line,
// in MAVEN_ARGS or in .mvn/maven.config fails too, even one that keeps a
// single method of every class, and so does a report without properties.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const isHosted = (className) => /^Hosted.*IT$/.test(className);
const isGate = (className) => /^Hosted.*Gate$/.test(className);
const [family, ...modules] = process.argv.slice(2);
const optIn =
  family === 'o4-mysql' ||
  family === 'o4-oss' ||
  family === 'event-transport' ||
  family === 'event-transport-multi-node';
const inFamily = new Map([
  ['hosted', isHosted],
  ['non-hosted', (className) => /IT$/.test(className) && !isHosted(className)],
  ['hosted-gates', isGate],
  ['o4-mysql', (className) => className === 'O4MySqlGate'],
  ['o4-oss', (className) => className === 'O4OssGate'],
  ['event-transport', (className) => className === 'EventTransportBrokerGate'],
  [
    'event-transport-multi-node',
    (className) => className === 'EventTransportMultiNodeGate',
  ],
]).get(family);
if (!inFamily || modules.length === 0) {
  console.error(
    'usage: node scripts/check-failsafe-reports.js hosted|non-hosted|hosted-gates|o4-mysql|o4-oss|event-transport|event-transport-multi-node <maven-module-dir>...',
  );
  process.exit(2);
}

const simpleName = (className) => className.split('.').at(-1);

// A module can bind an `*IT` class to a surefire execution instead of failsafe.
// Such a class is then excluded from the mysql-integration failsafe (so it can
// never have a report) while still matching the non-hosted roster below, which
// is a contradiction rather than a missed run: #15820 item 1. Name each such
// class here, and keep the pom in agreement — the check below fails if a name
// is not bound to a surefire include and a failsafe exclude in that module.
const SUREFIRE_BOUND = new Map([
  ['packages/managed-agent-server/verification', ['ManagedAgentPackagingIT']],
]);

// The module argument is whatever the job passed to Maven: relative on CI,
// absolute in the meta-tests, so match its trailing segments.
const boundNames = (module) => {
  const normalized = path.normalize(module).split(path.sep).join('/');
  for (const [dir, names] of SUREFIRE_BOUND) {
    if (normalized === dir || normalized.endsWith(`/${dir}`)) return names;
  }
  return [];
};

const rosterExempt = (module, name) => boundNames(module).includes(name);

const pomBindsBoth = (module, name) => {
  const pom = path.join(module, 'pom.xml');
  if (!existsSync(pom)) return false;
  const xml = readFileSync(pom, 'utf8');
  return (
    xml.includes(`<include>**/${name}.java</include>`) &&
    xml.includes(`<exclude>**/${name}.java</exclude>`)
  );
};
// Not readdirSync's `recursive`: a Node older than 18.17 ignores it, and the
// check would then find no integration test at all.
const javaFiles = (dir, prefix = []) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? javaFiles(path.join(dir, entry.name), [...prefix, entry.name])
      : [[...prefix, entry.name].join('.')],
  );
let failed = false;
for (const requestedModule of modules) {
  const module =
    path.basename(path.resolve(requestedModule)) === 'managed-agent-server'
      ? path.join(requestedModule, 'verification')
      : requestedModule;
  const expected = javaFiles(path.join(module, 'src', 'test', 'java'))
    .filter((file) => file.endsWith('.java'))
    .map((file) => file.slice(0, -'.java'.length))
    .filter((className) => inFamily(simpleName(className)))
    .filter((className) => {
      const name = simpleName(className);
      if (!rosterExempt(module, name)) return true;
      console.log(`${module}: ${name} runs under surefire, not failsafe`);
      return false;
    });
  for (const name of boundNames(module)) {
    if (!pomBindsBoth(module, name)) {
      failed = true;
      console.error(
        `::error::${module}: ${name} is listed as surefire-bound but its pom no longer binds it to a surefire include and a failsafe exclude`,
      );
    }
  }
  if (expected.length === 0) {
    failed = true;
    console.error(`::error::${module}: no ${family} test sources found`);
  }
  if (optIn && expected.length !== 1) {
    failed = true;
    console.error(
      `::error::${module}: expected exactly one ${family} gate source`,
    );
  }
  const reports = path.join(module, 'target', 'failsafe-reports');
  const ran = new Map();
  const filters = new Set();
  const unrecorded = [];
  for (const file of existsSync(reports) ? readdirSync(reports) : []) {
    // A nested class that gets a report of its own counts as its outer class.
    const className = /^TEST-(.+)\.xml$/.exec(file)?.[1].split('$')[0];
    if (!className) continue;
    // Count test cases, not the suite's `tests` attribute: some failsafe
    // versions fold @Nested cases into the outer report and leave it at 0.
    const report = readFileSync(path.join(reports, file), 'utf8').replace(
      /<!\[CDATA\[[\s\S]*?\]\]>/g,
      '',
    );
    const count = (element) =>
      report.match(new RegExp(`<${element}\\b`, 'g'))?.length ?? 0;
    if (
      optIn &&
      ['skipped', 'failure', 'error'].some((element) => count(element))
    ) {
      failed = true;
      console.error(
        `::error::${module}: ${file} contains a skipped or failed gate case`,
      );
    }
    ran.set(
      className,
      (ran.get(className) ?? 0) + count('testcase') - count('skipped'),
    );
    if (!/<properties\b/.test(report)) unrecorded.push(file);
    for (const [, name, value] of report.matchAll(
      /<property name="(it\.test|failsafe\.(?:in|ex)cludesFile)" value="([^"]*)"/g,
    )) {
      filters.add(`-D${name}=${value}`);
    }
  }
  for (const filter of filters) {
    failed = true;
    console.error(`::error::${module}: ${filter} narrowed this run`);
  }
  for (const file of unrecorded) {
    failed = true;
    console.error(
      `::error::${module}: ${file} records no properties, so its selection cannot be checked`,
    );
  }
  for (const className of expected) {
    if (ran.get(className) > 0) {
      console.log(`${module}: ${className} ran ${ran.get(className)} test(s)`);
    } else {
      failed = true;
      console.error(`::error::${module}: ${className} ran no test in this job`);
    }
  }
  for (const className of ran.keys()) {
    if (!inFamily(simpleName(className))) {
      failed = true;
      console.error(
        `::error::${module}: ${className} ran outside the ${family} family`,
      );
    }
  }
}
process.exitCode = failed ? 1 : 0;
