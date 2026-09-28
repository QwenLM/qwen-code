/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The Java integration-test jobs split `*IT.java` by name: `Hosted*IT` runs
// only in the Hosted MySQL job, every other `*IT` only in the MariaDB job.
// Maven still passes when a profile's <includes>, or -Dit.test in MAVEN_ARGS
// or .mvn/maven.config, narrows that selection, so after a job's tests this
// compares the failsafe reports with the source tree of each module: every
// `*IT` class of the job's family must have run at least one test (so an
// abstract base class must not end in IT), unless the class is annotated
// @Disabled at its source — a declared, review-visible skip rather than a
// silently missing report — and no other test class may have run. The reports
// also record Maven's user properties, so a run under -Dit.test or
// -Dfailsafe.includesFile/excludesFile given on the command line, in
// MAVEN_ARGS or in .mvn/maven.config fails too, even one that keeps a single
// method of every class, and so does a report without properties.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const isHosted = (className) => /^Hosted.*IT$/.test(className);
const [family, ...modules] = process.argv.slice(2);
const inFamily =
  family === 'hosted'
    ? isHosted
    : family === 'non-hosted'
      ? (className) => /IT$/.test(className) && !isHosted(className)
      : undefined;
if (!inFamily || modules.length === 0) {
  console.error(
    'usage: node scripts/check-failsafe-reports.js hosted|non-hosted <maven-module-dir>...',
  );
  process.exit(2);
}

const simpleName = (className) => className.split('.').at(-1);
// A class annotated @Disabled at its source is a declared skip, visible in
// review, not a silently missing report.
const disabledAtSource = (module, className) => {
  const file = path.join(
    module,
    'src',
    'test',
    'java',
    ...className.split('.'),
  );
  try {
    return readFileSync(`${file}.java`, 'utf8').includes('@Disabled');
  } catch {
    return false;
  }
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
for (const module of modules) {
  const expected = javaFiles(path.join(module, 'src', 'test', 'java'))
    .filter((file) => file.endsWith('IT.java'))
    .map((file) => file.slice(0, -'.java'.length))
    .filter((className) => inFamily(simpleName(className)));
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
    } else if (disabledAtSource(module, className)) {
      console.log(`${module}: ${className} is disabled at its source`);
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
