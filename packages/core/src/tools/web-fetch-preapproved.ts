/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** WebFetch (GET) preapproval does not authorize other network operations. */
export type PreapprovedHostChecker = (
  hostname: string,
  pathname: string,
) => boolean;

/** Build an independent matcher, indexing entries once at creation time. */
export function createPreapprovedHostChecker(
  entries: ReadonlySet<string>,
): PreapprovedHostChecker {
  const hosts = new Set<string>();
  const paths = new Map<string, string[]>();
  for (const entry of entries) {
    const slash = entry.indexOf('/');
    if (slash === -1) {
      hosts.add(entry);
    } else {
      const host = entry.slice(0, slash);
      const path = entry.slice(slash);
      const prefixes = paths.get(host);
      if (prefixes) prefixes.push(path);
      else paths.set(host, [path]);
    }
  }

  return (hostname, pathname) => {
    if (hosts.has(hostname)) return true;
    const prefixes = paths.get(hostname);
    if (prefixes) {
      for (const prefix of prefixes) {
        // Match the path itself or descendants, preserving segment boundaries.
        if (pathname === prefix || pathname.startsWith(prefix + '/'))
          return true;
      }
    }
    return false;
  };
}

const PREAPPROVED_HOSTS: ReadonlySet<string> = new Set([
  // Qwen ecosystem
  'qwenlm.github.io',
  'qwen.readthedocs.io',
  'github.com/QwenLM',
  // Matches QwenLM raw files whether requested directly or via a github.com
  // blob URL (the tool rewrites those to this host before fetching).
  'raw.githubusercontent.com/QwenLM',
  'modelcontextprotocol.io',

  // Top programming languages
  'docs.python.org',
  'en.cppreference.com',
  'docs.oracle.com',
  'learn.microsoft.com',
  'developer.mozilla.org',
  'go.dev',
  'pkg.go.dev',
  'www.php.net',
  'docs.swift.org',
  'kotlinlang.org',
  'ruby-doc.org',
  'doc.rust-lang.org',
  'www.typescriptlang.org',

  // Web & JavaScript frameworks/libraries
  'react.dev',
  'angular.io',
  'vuejs.org',
  'nextjs.org',
  'expressjs.com',
  'nodejs.org',
  'bun.sh',
  'jquery.com',
  'getbootstrap.com',
  'tailwindcss.com',
  'd3js.org',
  'threejs.org',
  'redux.js.org',
  'webpack.js.org',
  'jestjs.io',
  'reactrouter.com',

  // Python frameworks & libraries
  'docs.djangoproject.com',
  'flask.palletsprojects.com',
  'fastapi.tiangolo.com',
  'pandas.pydata.org',
  'numpy.org',
  'www.tensorflow.org',
  'pytorch.org',
  'scikit-learn.org',
  'matplotlib.org',
  'requests.readthedocs.io',
  'jupyter.org',

  // PHP frameworks
  'laravel.com',
  'symfony.com',
  'wordpress.org',

  // Java frameworks & libraries
  'docs.spring.io',
  'hibernate.org',
  'tomcat.apache.org',
  'gradle.org',
  'maven.apache.org',

  // .NET & C# frameworks
  'asp.net',
  'dotnet.microsoft.com',
  'nuget.org',
  'blazor.net',

  // Mobile development
  'reactnative.dev',
  'docs.flutter.dev',
  'developer.apple.com',
  'developer.android.com',

  // Data science & machine learning
  'keras.io',
  'spark.apache.org',
  'huggingface.co',
  'www.kaggle.com',

  // Databases
  'www.mongodb.com',
  'redis.io',
  'www.postgresql.org',
  'dev.mysql.com',
  'www.sqlite.org',
  'graphql.org',
  'prisma.io',

  // Cloud & DevOps
  'docs.aws.amazon.com',
  'cloud.google.com',
  'kubernetes.io',
  'www.docker.com',
  'www.terraform.io',
  'www.ansible.com',
  'vercel.com/docs',
  'docs.netlify.com',
  'devcenter.heroku.com',

  // Testing & monitoring
  'cypress.io',
  'selenium.dev',

  // Game development
  'docs.unity.com',
  'docs.unrealengine.com',

  // Other essential tools
  'git-scm.com',
  'nginx.org',
  'httpd.apache.org',
]);

export const isPreapprovedHost =
  createPreapprovedHostChecker(PREAPPROVED_HOSTS);
