import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalRoot = path.resolve(packageRoot, "../../core/src/skills/bundled/computer-use");
const resources = ["SKILL.md", "references/macos.md", "references/windows-linux.md"];

test("SDK skill resources match canonical content and npm includes every reference", () => {
  for (const resource of resources) {
    assert.equal(
      readFileSync(path.join(packageRoot, "computer-use", resource), "utf8"),
      readFileSync(path.join(canonicalRoot, resource), "utf8"),
      resource,
    );
  }
  const packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const files = new Set(JSON.parse(packed.stdout)[0].files.map(({ path }) => path));
  for (const resource of resources) {
    assert.ok(files.has(`computer-use/${resource}`), resource);
  }
});

test("staging copies both resources, refreshes them and fails before copying when one is absent", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cua-skill-stage-"));
  try {
    const sdk = path.join(root, "packages/cua-driver/typescript");
    const canonical = path.join(root, "packages/core/src/skills/bundled/computer-use");
    mkdirSync(path.join(sdk, "scripts"), { recursive: true });
    mkdirSync(path.join(canonical, "references"), { recursive: true });
    const script = path.join(sdk, "scripts/stage-computer-use-skill.mjs");
    copyFileSync(path.join(packageRoot, "scripts/stage-computer-use-skill.mjs"), script);
    for (const resource of resources) {
      writeFileSync(path.join(canonical, resource), resource);
    }
    const stage = () => spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(stage().status, 0);
    for (const resource of resources) {
      assert.equal(readFileSync(path.join(sdk, "computer-use", resource), "utf8"), resource);
    }
    const destination = path.join(sdk, "computer-use/references/macos.md");
    writeFileSync(destination, "stale");
    assert.equal(stage().status, 0);
    assert.equal(readFileSync(destination, "utf8"), "references/macos.md");
    rmSync(path.join(canonical, "references/windows-linux.md"));
    writeFileSync(path.join(canonical, "SKILL.md"), "not copied");
    const failed = stage();
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /canonical Computer Use skill resource not found/);
    assert.equal(readFileSync(path.join(sdk, "computer-use/SKILL.md"), "utf8"), "SKILL.md");
    assert.ok(existsSync(destination));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
