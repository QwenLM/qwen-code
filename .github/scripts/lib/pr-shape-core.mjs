const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'into',
  'adds',
  'add',
  'fix',
  'fixes',
  'update',
  'updates',
  'support',
  'enable',
  'review',
  'qwen',
  'code',
]);

export function stripGitPrefix(path) {
  return path.replace(/^"?[ab]\//, '').replace(/"$/, '');
}

export function parseUnifiedDiff(diffText) {
  const files = new Map();
  let current = null;

  for (const line of diffText.split(/\r?\n/)) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (fileMatch) {
      current = fileMatch[2];
      files.set(current, {
        file: current,
        additions: 0,
        deletions: 0,
        addedLines: [],
      });
      continue;
    }

    if (!current || !files.has(current)) {
      continue;
    }

    const entry = files.get(current);
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      continue;
    }
    if (line.startsWith('+')) {
      entry.additions += 1;
      entry.addedLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      entry.deletions += 1;
    }
  }

  return [...files.values()];
}

export function detectPublicSurfaceChanges(files) {
  const changes = [];
  for (const file of files) {
    for (const line of file.addedLines ?? []) {
      const namedExport =
        /^\s*export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z0-9_$]+)/.exec(
          line,
        );
      if (namedExport) {
        changes.push({
          file: file.file,
          kind: 'export',
          name: namedExport[1],
        });
        continue;
      }

      const exportList = /^\s*export\s+\{([^}]+)\}/.exec(line);
      if (exportList) {
        for (const name of exportList[1].split(',')) {
          const cleanName = name
            .trim()
            .split(/\s+as\s+/i)[0]
            ?.trim();
          if (cleanName) {
            changes.push({
              file: file.file,
              kind: 'export',
              name: cleanName,
            });
          }
        }
        continue;
      }

      const moduleExport =
        /^\s*module\.exports(?:\.([A-Za-z0-9_$]+))?\s*=/.exec(line);
      if (moduleExport) {
        changes.push({
          file: file.file,
          kind: 'module_exports',
          name: moduleExport[1] ?? 'default',
        });
      }
    }
  }
  return changes;
}

export function detectDependencyChanges(files) {
  const changes = new Set();
  for (const file of files) {
    if (!/(^|\/)(package|package-lock)\.json$/.test(file.file)) {
      continue;
    }
    for (const line of file.addedLines ?? []) {
      const depMatch = /^\s*"(@?[^"]+)":\s*"([^"]+)"/.exec(line);
      if (depMatch && !depMatch[1].startsWith('//')) {
        changes.add(`${depMatch[1]}@${depMatch[2]}`);
      }
    }
  }
  return [...changes].sort();
}

export function isConfigFile(file) {
  return (
    file === 'package.json' ||
    file === 'package-lock.json' ||
    file.endsWith('/package.json') ||
    file.endsWith('/package-lock.json') ||
    file.endsWith('pnpm-lock.yaml') ||
    file.endsWith('yarn.lock') ||
    file.endsWith('tsconfig.json') ||
    file.startsWith('.github/workflows/') ||
    file === 'action.yml' ||
    file === 'Dockerfile'
  );
}

export function isApiEntrypoint(file) {
  return (
    /^packages\/cli\/src\/commands\/.+\.(ts|tsx|js|mjs)$/.test(file) ||
    /^packages\/sdk-[^/]+\/src\/index\.(ts|tsx|js|mjs)$/.test(file) ||
    /^packages\/[^/]+\/src\/index\.(ts|tsx|js|mjs)$/.test(file) ||
    file === 'action.yml' ||
    file === 'package.json'
  );
}

export function buildPrShape({
  diffText = '',
  additions,
  deletions,
  changedFiles,
} = {}) {
  const parsedFiles = parseUnifiedDiff(diffText);
  const changedFileList = parsedFiles.map((entry) =>
    stripGitPrefix(entry.file),
  );
  const packages = new Map();

  for (const file of parsedFiles) {
    const packageMatch = /^packages\/([^/]+)\//.exec(file.file);
    if (!packageMatch) {
      continue;
    }
    const name = packageMatch[1];
    const existing = packages.get(name) ?? {
      files: 0,
      additions: 0,
      deletions: 0,
    };
    existing.files += 1;
    existing.additions += file.additions;
    existing.deletions += file.deletions;
    packages.set(name, existing);
  }

  const computedAdditions = parsedFiles.reduce(
    (total, file) => total + file.additions,
    0,
  );
  const computedDeletions = parsedFiles.reduce(
    (total, file) => total + file.deletions,
    0,
  );

  return {
    changed_files: changedFileList,
    packages_touched: [...packages.keys()].sort(),
    package_stats: Object.fromEntries([...packages.entries()].sort()),
    public_surface_changes: detectPublicSurfaceChanges(parsedFiles),
    config_files_changed: changedFileList.filter(isConfigFile).sort(),
    api_entrypoints_changed: changedFileList.filter(isApiEntrypoint).sort(),
    dependency_changes: detectDependencyChanges(parsedFiles),
    diff_stat: {
      files: changedFiles ?? changedFileList.length,
      additions: additions ?? computedAdditions,
      deletions: deletions ?? computedDeletions,
    },
  };
}

function wordsFromText(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter(
    (word) => !STOP_WORDS.has(word),
  );
}

export function extractKeywords({ title = '', body = '', files = [] } = {}) {
  const keywords = new Set();
  const lowerTitle = title.toLowerCase();

  for (const phrase of [
    'design gate',
    'model list',
    'review automation',
    'desktop launcher',
    'github app',
    'pull request',
  ]) {
    if (`${lowerTitle}\n${body.toLowerCase()}`.includes(phrase)) {
      keywords.add(phrase);
    }
  }

  for (const word of wordsFromText(`${title}\n${body}`)) {
    keywords.add(word);
  }

  for (const file of files) {
    const parts = file
      .split(/[/. _-]+/)
      .map((part) => part.toLowerCase())
      .filter((part) => part.length > 2 && !STOP_WORDS.has(part));
    for (const part of parts) {
      keywords.add(part);
    }
  }

  return [...keywords].slice(0, 12);
}
