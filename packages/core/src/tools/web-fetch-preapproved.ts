/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// A curated list of official code-documentation domains. This list is NOT a
// permission grant: WebFetch requires per-domain user approval for every host,
// because a GET discloses its full path/query to a third party and is an
// exfiltration channel regardless of how trusted the host is. The list's only
// job is a content optimization — a text/markdown response from one of these
// hosts may be returned to the model verbatim, skipping the summarization
// side-query — and that decision is made AFTER the fetch has already been
// permitted and completed.
//
// SECURITY WARNING: even as a passthrough gate, this list must never feed a
// sandbox/network allowlist — several of these domains (e.g. huggingface.co,
// kaggle.com, nuget.org) accept file uploads, so unrestricted network access
// to them would enable data exfiltration.

export const PREAPPROVED_HOSTS: ReadonlySet<string> = new Set([
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

// An apex domain and its "www." form are the same site (same DNS owner), and
// several listed sites 301 one form to the other (cypress.io →
// www.cypress.io; php.net → www.php.net). This list now gates only the
// markdown passthrough, which is evaluated against the post-redirect final
// URL — so without this equivalence, fetching a listed apex host that
// canonicalizes to www would land on a www final URL that fails the match and
// needlessly fall back to summarization. Mirrors the www handling in
// isPermittedRedirect (utils/fetch.ts).
const stripWww = (hostname: string): string => hostname.replace(/^www\./, '');

// Split once at module load: O(1) Set lookup for hostname-only entries, plus a
// small per-host path-prefix list for path-scoped entries like
// "github.com/QwenLM". Hosts are stored www-stripped; lookups strip too.
const { HOSTNAME_ONLY, PATH_PREFIXES } = (() => {
  const hosts = new Set<string>();
  const paths = new Map<string, string[]>();
  for (const entry of PREAPPROVED_HOSTS) {
    const slash = entry.indexOf('/');
    if (slash === -1) {
      hosts.add(stripWww(entry));
    } else {
      const host = stripWww(entry.slice(0, slash));
      // Stored lowercased; lookups lowercase too. GitHub owner names are
      // case-insensitive and unique regardless of case, so this cannot match
      // a different owner — and a casing mismatch would only cost the
      // passthrough optimization (an unnecessary summarization pass).
      const prefix = entry.slice(slash).toLowerCase();
      const prefixes = paths.get(host);
      if (prefixes) {
        prefixes.push(prefix);
      } else {
        paths.set(host, [prefix]);
      }
    }
  }
  return { HOSTNAME_ONLY: hosts, PATH_PREFIXES: paths };
})();

export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  const host = stripWww(hostname.toLowerCase());
  if (HOSTNAME_ONLY.has(host)) {
    return true;
  }
  const prefixes = PATH_PREFIXES.get(host);
  if (prefixes) {
    const path = pathname.toLowerCase();
    for (const prefix of prefixes) {
      // Path-segment boundary: "/QwenLM" must not match "/QwenLM-evil/x".
      if (path === prefix || path.startsWith(prefix + '/')) {
        return true;
      }
    }
  }
  return false;
}

export function isPreapprovedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Preapproval only ever applies over https: plaintext http (an explicit
    // non-default port, or a TLS-failure fallback) is trivially injectable
    // by an on-path attacker and must go through user confirmation.
    return (
      parsed.protocol === 'https:' &&
      isPreapprovedHost(parsed.hostname, parsed.pathname)
    );
  } catch {
    return false;
  }
}
