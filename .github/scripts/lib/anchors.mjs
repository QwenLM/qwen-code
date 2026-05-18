import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const DEFAULT_ANCHORS = [
  'docs/developers/roadmap.md',
  'docs/developers/architecture.md',
  '.qwen/review-rules.md',
  '.github/pull_request_template.md',
];

async function fileExists(path) {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function listMarkdownFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

function relevantDesignDirs(changedFiles) {
  const dirs = new Set();
  for (const file of changedFiles ?? []) {
    const match = /^docs\/design\/([^/]+)/.exec(file);
    if (match) {
      dirs.add(`docs/design/${match[1]}`);
    }
  }
  return [...dirs].sort();
}

async function loadAnchor(rootDir, relativePath, maxBytes) {
  const absolutePath = join(rootDir, relativePath);
  if (!(await fileExists(absolutePath))) {
    return { missing: relativePath };
  }
  const content = await readFile(absolutePath, 'utf8');
  return {
    anchor: {
      path: relativePath,
      excerpt:
        content.length > maxBytes
          ? `${content.slice(0, maxBytes)}\n[truncated]`
          : content,
    },
  };
}

export async function loadAnchors({
  rootDir = process.cwd(),
  changedFiles = [],
  maxBytes = 12000,
} = {}) {
  const requested = new Set(DEFAULT_ANCHORS);

  for (const dir of relevantDesignDirs(changedFiles)) {
    const files = await listMarkdownFiles(join(rootDir, dir));
    for (const file of files) {
      requested.add(relative(rootDir, file));
    }
  }

  const loaded = [];
  const missing = [];
  for (const path of [...requested].sort((a, b) => {
    const aDefault = DEFAULT_ANCHORS.indexOf(a);
    const bDefault = DEFAULT_ANCHORS.indexOf(b);
    if (aDefault !== -1 || bDefault !== -1) {
      return (
        (aDefault === -1 ? 999 : aDefault) - (bDefault === -1 ? 999 : bDefault)
      );
    }
    return a.localeCompare(b);
  })) {
    const result = await loadAnchor(rootDir, path, maxBytes);
    if (result.anchor) {
      loaded.push(result.anchor);
    } else {
      missing.push(result.missing);
    }
  }

  return { loaded, missing };
}
