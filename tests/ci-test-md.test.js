/**
 * CI Markdown Quality Tests
 *
 * Test framework: Jest-style (works with Jest; also compatible with Vitest if globals are enabled).
 * Purpose: Provide meaningful validation for Markdown/MDX files in the repository.
 *
 * Coverage:
 *  - Balanced code fences (``` and ~~~)
 *  - At least one H1 heading for .md files
 *  - No TODO/TBD/FIXME outside code blocks
 *  - All relative links and image sources resolve to existing files
 *  - No trailing whitespace outside code blocks
 *  - Reasonable line length limits outside code blocks (<= 200 chars, excluding URLs and tables)
 *
 * Notes:
 *  - External links (http/https/mailto/etc.) are not fetched; only local paths are validated.
 *  - Directories linked without a filename are accepted if they contain README.md or index.md.
 */

const fs = require("fs");
const path = require("path");

// Directories to skip during traversal
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  "out",
  "public",
  "static",
  ".turbo",
  ".vercel",
  ".expo",
]);

function isIgnoredDir(dirPath) {
  const parts = dirPath.split(path.sep);
  return parts.some((seg) => IGNORED_DIRS.has(seg));
}

function collectMarkdownFiles(rootDir) {
  const result = [];
  const stack = [rootDir];

  while (stack.length) {
    const dir = stack.pop();
    if (isIgnoredDir(dir)) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue; // permissions or transient errors
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredDir(full)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".md" || ext === ".mdx") {
        result.push(full);
      }
    }
  }
  // Ensure deterministic order for stable CI output
  result.sort();
  return result;
}

function getLines(content) {
  return content.split(/\r?\n/);
}

function computeCodeBlockMask(lines) {
  // Toggle when encountering a fence line starting with ``` or ~~~ (allow leading spaces)
  const mask = new Array(lines.length).fill(false);
  let inFence = false;
  let fenceStyle = null; // "```" or "~~~"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    const isBacktick = /^```/.test(trimmed);
    const isTilde = /^~~~/.test(trimmed);

    if ((isBacktick && fenceStyle === "```") || (isTilde && fenceStyle === "~~~")) {
      // Closing current fence
      mask[i] = true;
      inFence = false;
      fenceStyle = null;
      continue;
    }

    if (!inFence && (isBacktick || isTilde)) {
      // Opening a fence
      mask[i] = true;
      inFence = true;
      fenceStyle = isBacktick ? "```" : "~~~";
      continue;
    }

    if (inFence) {
      mask[i] = true;
    }
  }
  return mask;
}

function countFences(content, fence) {
  const re = new RegExp(`^\\s*${fence}`, "gm");
  const matches = content.match(re);
  return matches ? matches.length : 0;
}

function linesOutsideCode(lines, codeMask) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!codeMask[i]) out.push({ i, line: lines[i] });
  }
  return out;
}

function isExternalLink(target) {
  return /^(?:[a-z]+:)?\/\//i.test(target) ||
         /^(mailto:|tel:|data:|javascript:|geo:|sms:)/i.test(target);
}

function normalizeTarget(raw) {
  // Strip angle brackets around autolinks and trim
  let t = raw.trim();
  if (t.startsWith("<") && t.endsWith(">")) {
    t = t.slice(1, -1).trim();
  }
  // Remove query/hash when checking filesystem
  return t;
}

function stripQueryHash(target) {
  return target.split("#")[0].split("?")[0];
}

function parseLinks(content) {
  // Capture both links and images. Title (optional) is ignored.
  // Examples: [text](path "title"), ![alt](path), [text](<path with spaces>)
  const re = /(!)?\[[^\]]*?\]\(\s*<?([^)\s]+|[^)]+?)>?(?:\s+"[^"]*")?\s*\)/g;
  const results = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    const isImage = Boolean(m[1]);
    const targetRaw = m[2];
    const target = normalizeTarget(targetRaw);
    results.push({ isImage, target });
  }
  return results;
}

function fileOrDirExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveRelativeLink(baseFile, target) {
  // target may start with "/" (repo-root relative) or be relative to base file
  if (target.startsWith("/")) {
    return path.join(process.cwd(), target.replace(/^\//, ""));
  }
  return path.resolve(path.dirname(baseFile), target);
}

function resolvesToExistingFile(baseFile, target) {
  const noHash = stripQueryHash(target);
  if (!noHash) return true; // empty link; ignore
  const abs = resolveRelativeLink(baseFile, noHash);

  // Direct hit
  if (fileOrDirExists(abs) && !isDirectory(abs)) return true;

  // If it's a directory, allow README.md or index.md
  if (fileOrDirExists(abs) && isDirectory(abs)) {
    const candidates = [path.join(abs, "README.md"), path.join(abs, "index.md")];
    if (candidates.some(fileOrDirExists)) return true;
  }

  // Try appending .md if no extension
  if (!path.extname(abs)) {
    const mdCandidate = `${abs}.md`;
    if (fileOrDirExists(mdCandidate)) return true;
  }

  return false;
}

const mdFiles = collectMarkdownFiles(process.cwd());

if (mdFiles.length === 0) {
  test("No Markdown files found - skipping Markdown quality checks", () => {
    expect(true).toBe(true);
  });
} else {
  describe("Markdown quality checks", () => {
    test("Repository contains Markdown files", () => {
      expect(mdFiles.length).toBeGreaterThan(0);
    });

    describe.each(mdFiles)("File: %s", (file) => {
      const content = fs.readFileSync(file, "utf8");
      const lines = getLines(content);
      const codeMask = computeCodeBlockMask(lines);
      const outside = linesOutsideCode(lines, codeMask);
      const ext = path.extname(file).toLowerCase();

      test("has balanced code fences (``` and ~~~)", () => {
        const backtickCount = countFences(content, "```");
        const tildeCount = countFences(content, "~~~");
        expect(backtickCount % 2).toBe(0);
        expect(tildeCount % 2).toBe(0);
      });

      if (ext === ".md") {
        test("contains at least one H1 heading (# ...) near the top", () => {
          const first20 = lines.slice(0, Math.min(20, lines.length));
          const hasH1Anywhere = lines.some((l) => /^#\s+/.test(l.trim()));
          const hasEarlyH1 = first20.some((l) => /^#\s+/.test(l.trim()));
          expect(hasH1Anywhere).toBe(true);
          expect(hasEarlyH1).toBe(true);
        });
      }

      test("has no TODO/TBD/FIXME outside code blocks", () => {
        const offenders = outside
          .filter(({ line }) => /\b(TODO|TBD|FIXME)\b/i.test(line))
          .map(({ i, line }) => `${i + 1}: ${line}`);
        expect(offenders).toEqual([]);
      });

      test("has no trailing whitespace outside code blocks", () => {
        const offenders = outside
          .filter(({ line }) => /[ \t]+$/.test(line))
          .map(({ i, line }) => `${i + 1}: ${line}`);
        expect(offenders).toEqual([]);
      });

      test("keeps line length reasonable (<= 200 chars) outside code blocks, excluding URLs and tables", () => {
        const offenders = outside
          .filter(({ line }) => {
            const trimmed = line.trimRight();
            if (!trimmed) return false;
            if (trimmed.includes("http")) return false; // allow long URLs
            if (/^\|.*\|$/.test(trimmed)) return false; // allow tables
            return trimmed.length > 200;
          })
          .map(({ i, line }) => `${i + 1}: ${line.length} chars`);
        expect(offenders).toEqual([]);
      });

      test("all relative links and image sources resolve to existing files", () => {
        const links = parseLinks(content);
        const missing = [];

        for (const { isImage, target } of links) {
          if (!target || isExternalLink(target) || target.startsWith("#")) {
            continue; // external or pure anchor
          }
          if (!resolvesToExistingFile(file, target)) {
            missing.push(`${isImage ? "image" : "link"} -> ${target}`);
          }
        }

        expect(missing).toEqual([]);
      });
    });
  });
}