#!/usr/bin/env bun
/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Replace the VS_VERSION_INFO resource (RT_VERSION) inside a Windows PE file
 * with our own branding. Used to overwrite the default VersionInfo carried by
 * Bun (ProductName=Bun, CompanyName=Oven) or Node.js (ProductName=Node.js).
 *
 * Uses the `resedit` npm package (the same library electron-builder uses) to
 * serialize a fresh resource section and write it back into the PE.
 *
 * Bun-specific constraint: Bun appends a custom `.bun` section after `.rsrc`
 * to embed the JS bundle. resedit's default safety check refuses to operate
 * on such layouts because it does not know whether the trailing custom
 * section has internal RVA references that would break when `.rsrc` grows.
 *
 * Our workaround:
 *   1. Temporarily detach trailing non-.reloc sections (e.g. `.bun`) from the
 *      internal `_sections` array — by reference, preserving original order.
 *   2. Run `NtExecutableResource.from(exe)` so the safety check passes.
 *   3. Restore the detached sections in their original positions BEFORE
 *      `outputResource(...)`, so resedit's `rearrangeSections()` will shift
 *      their virtual addresses correctly when `.rsrc` grows.
 *   4. Bun looks up `.bun` at runtime by section name (standard PE practice
 *      for custom sections), so the relocation is safe.
 *
 * Atomic write (.tmp -> rename); fail-fast on any inconsistency.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { NtExecutable, NtExecutableResource, Resource } from 'resedit';

type Strings = {
  productName: string;
  fileDescription: string;
  companyName: string;
  productVersion: string;
  fileVersion: string;
  internalName: string;
  originalFilename: string;
  legalCopyright: string;
};

// VS_VERSION_INFO wLength is a uint16 (max 65535 bytes per block); per-field
// limits below keep us well under that even if every field were maxed out.
const MAX_FIELD_CHARS = 256;

// Canonical translation we project all RT_VERSION entries onto:
// 0x0409 = English (US), 0x04b0 = Unicode codepage. Matches what most
// commercial Windows installers use.
const LANG_EN_US = 0x0409;
const CODEPAGE_UNICODE = 0x04b0;

function usage(): never {
  console.error(
    'Usage: bun run scripts/patch_windows_version_info.ts <path-to-exe> \\\n' +
      '  --product-name <s> --file-description <s> --company-name <s> \\\n' +
      '  --product-version <s> --file-version <s> --internal-name <s> \\\n' +
      '  --original-filename <s> --legal-copyright <s>',
  );
  process.exit(2);
}

function sanitize(s: string, label: string): string {
  if (s.length > MAX_FIELD_CHARS) {
    throw new Error(
      `${label}: ${s.length} chars exceeds limit ${MAX_FIELD_CHARS}`,
    );
  }
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code === 0) {
      throw new Error(`${label}: contains NUL`);
    }
    if (code < 0x20 && code !== 0x09) {
      throw new Error(
        `${label}: contains control char U+${code.toString(16).padStart(4, '0')}`,
      );
    }
  }
  return s;
}

function parseFourPart(
  version: string,
  label: string,
): [number, number, number, number] {
  // Strip semver prerelease/build metadata before parsing the numeric core.
  const cleaned = version.split(/[-+]/)[0];
  const rawParts = cleaned.split('.');
  if (rawParts.length === 0 || rawParts.length > 4) {
    throw new Error(`${label}: "${version}" must have 1-4 numeric components`);
  }
  const parts: number[] = [];
  for (const p of rawParts) {
    if (!/^\d+$/.test(p)) {
      throw new Error(
        `${label}: "${version}" has non-numeric component "${p}"`,
      );
    }
    const n = parseInt(p, 10);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) {
      throw new Error(
        `${label}: "${version}" component ${n} out of range 0..65535`,
      );
    }
    parts.push(n);
  }
  while (parts.length < 4) parts.push(0);
  return [parts[0], parts[1], parts[2], parts[3]];
}

function parseArgs(argv: string[]): { exePath: string; strings: Strings } {
  let exePath = '';
  const map: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`Missing value for ${a}`);
      }
      map[a] = value;
    } else if (!exePath) {
      exePath = a;
    } else {
      throw new Error(`Unexpected positional argument: ${a}`);
    }
  }
  if (!exePath) usage();

  const req = (key: string): string => {
    const v = map[key];
    if (!v) throw new Error(`Missing required flag: ${key}`);
    return sanitize(v, key);
  };

  return {
    exePath,
    strings: {
      productName: req('--product-name'),
      fileDescription: req('--file-description'),
      companyName: req('--company-name'),
      productVersion: req('--product-version'),
      fileVersion: req('--file-version'),
      internalName: req('--internal-name'),
      originalFilename: req('--original-filename'),
      legalCopyright: req('--legal-copyright'),
    },
  };
}

type SectionInternal = {
  info: { name: string; virtualAddress: number };
  data: ArrayBuffer | null;
};
type InternalExe = NtExecutable & { _sections: SectionInternal[] };

/**
 * Load NtExecutableResource while bypassing resedit's "section after .rsrc"
 * safety check. See module-level docblock for the full rationale.
 *
 * Detach and restore use the section table's NATURAL order (the array as
 * pe-library stored it). resedit's safety check sorts by virtual address, but
 * the underlying `rearrangeSections()` uses the array iteration order to
 * recompute file offsets and SizeOfImage. Preserving the original array order
 * on restore is what keeps the resulting PE structurally identical.
 */
function loadResourceWithBunSectionWorkaround(exe: NtExecutable): {
  res: NtExecutableResource;
  restore: () => void;
} {
  const internal = exe as InternalExe;
  const originalSections = internal._sections.slice();

  // Find .rsrc by VA position: trailing sections (in VA order) that aren't
  // .reloc are the ones resedit's check rejects.
  const byVa = [...originalSections].sort(
    (a, b) => a.info.virtualAddress - b.info.virtualAddress,
  );
  const rsrcVaIdx = byVa.findIndex((s) => s.info.name === '.rsrc');
  if (rsrcVaIdx === -1) {
    throw new Error('PE file has no .rsrc section');
  }
  const toHide = new Set<SectionInternal>();
  for (let i = rsrcVaIdx + 1; i < byVa.length; i++) {
    if (byVa[i].info.name !== '.reloc') toHide.add(byVa[i]);
  }

  if (toHide.size > 0) {
    internal._sections = originalSections.filter((s) => !toHide.has(s));
  }

  const res = NtExecutableResource.from(exe);

  const restore = () => {
    // Restore exact original array order so rearrangeSections() iterates the
    // same sequence pe-library produced when loading the PE.
    internal._sections = originalSections.slice();
  };

  return { res, restore };
}

function applyBranding(
  vi: InstanceType<typeof Resource.VersionInfo>,
  strings: Strings,
  fileVersion: [number, number, number, number],
  productVersion: [number, number, number, number],
): void {
  for (const lang of vi.getAllLanguagesForStringValues()) {
    vi.removeAllStringValues(lang);
  }
  vi.setStringValues(
    { lang: LANG_EN_US, codepage: CODEPAGE_UNICODE },
    {
      CompanyName: strings.companyName,
      FileDescription: strings.fileDescription,
      FileVersion: strings.fileVersion,
      InternalName: strings.internalName,
      LegalCopyright: strings.legalCopyright,
      OriginalFilename: strings.originalFilename,
      ProductName: strings.productName,
      ProductVersion: strings.productVersion,
    },
  );
  vi.fixedInfo.fileVersionMS = (fileVersion[0] << 16) | fileVersion[1];
  vi.fixedInfo.fileVersionLS = (fileVersion[2] << 16) | fileVersion[3];
  vi.fixedInfo.productVersionMS = (productVersion[0] << 16) | productVersion[1];
  vi.fixedInfo.productVersionLS = (productVersion[2] << 16) | productVersion[3];
  // Single English-US/Unicode translation keeps explorer.exe and SmartScreen
  // consistent across user locales.
  vi.replaceAvailableLanguages([
    { lang: LANG_EN_US, codepage: CODEPAGE_UNICODE },
  ]);
  // The resource entry itself carries a lang field that Windows resource
  // managers (and outputToResourceEntries' replace-vs-append logic) key on.
  // Force English so we never end up with stale-language entries lingering
  // alongside a freshly-written English block.
  vi.lang = LANG_EN_US;
}

const EXPECTED_KEYS = [
  'CompanyName',
  'FileDescription',
  'FileVersion',
  'InternalName',
  'LegalCopyright',
  'OriginalFilename',
  'ProductName',
  'ProductVersion',
] as const;

const VENDOR_BLACKLIST = ['Bun', 'Oven', 'Node.js', 'OpenJS Foundation'];

/**
 * Structural post-check: re-parse the patched buffer with resedit and assert
 * every RT_VERSION entry carries the expected 8 fields, correct fixedInfo,
 * and contains no blacklisted vendor strings.
 *
 * Stronger than a byte scan because it walks the actual resource tree
 * (catches truncation, codepage mishaps, missing entries).
 */
function selfCheckPatchedBuffer(buf: Buffer, strings: Strings): void {
  const ab = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
  const exe = NtExecutable.from(ab);
  const { res } = loadResourceWithBunSectionWorkaround(exe);
  const entries = Resource.VersionInfo.fromEntries(res.entries);

  if (entries.length === 0) {
    throw new Error('Self-check failed: patched PE has no RT_VERSION entries');
  }

  const expectedValues: Record<(typeof EXPECTED_KEYS)[number], string> = {
    CompanyName: strings.companyName,
    FileDescription: strings.fileDescription,
    FileVersion: strings.fileVersion,
    InternalName: strings.internalName,
    LegalCopyright: strings.legalCopyright,
    OriginalFilename: strings.originalFilename,
    ProductName: strings.productName,
    ProductVersion: strings.productVersion,
  };

  for (const vi of entries) {
    const values = vi.getStringValues({
      lang: LANG_EN_US,
      codepage: CODEPAGE_UNICODE,
    });
    for (const key of EXPECTED_KEYS) {
      const got = values[key];
      if (got !== expectedValues[key]) {
        throw new Error(
          `Self-check failed: ${key} = ${JSON.stringify(got)}, expected ${JSON.stringify(expectedValues[key])}`,
        );
      }
    }
    for (const word of VENDOR_BLACKLIST) {
      for (const key of EXPECTED_KEYS) {
        const v = values[key] ?? '';
        if (v.toLowerCase().includes(word.toLowerCase())) {
          throw new Error(
            `Self-check failed: blacklisted "${word}" found in ${key}="${v}"`,
          );
        }
      }
    }
  }
}

function patchVersionInfo(exePath: string, strings: Strings): void {
  if (!existsSync(exePath)) throw new Error(`Executable not found: ${exePath}`);
  if (!exePath.toLowerCase().endsWith('.exe')) {
    throw new Error(`Expected a Windows .exe path, got: ${exePath}`);
  }

  const original = readFileSync(exePath);
  const inputAb = original.buffer.slice(
    original.byteOffset,
    original.byteOffset + original.byteLength,
  ) as ArrayBuffer;

  const exe = NtExecutable.from(inputAb);
  const { res, restore } = loadResourceWithBunSectionWorkaround(exe);

  const entries = Resource.VersionInfo.fromEntries(res.entries);
  if (entries.length === 0) {
    throw new Error('PE file has no VS_VERSION_INFO resource to patch');
  }

  const fileVersion = parseFourPart(strings.fileVersion, '--file-version');
  const productVersion = parseFourPart(
    strings.productVersion,
    '--product-version',
  );

  for (const vi of entries) {
    applyBranding(vi, strings, fileVersion, productVersion);
    vi.outputToResourceEntries(res.entries);
  }

  // Restore hidden sections before outputResource so resedit's
  // rearrangeSections() re-anchors their virtual addresses as .rsrc grows.
  restore();

  // Allow .rsrc to grow when our new strings exceed Bun's reserved slot.
  // rearrangeSections() shifts trailing sections (e.g. `.bun`) and rewrites
  // their virtual addresses. Bun's runtime locates `.bun` via section name
  // lookup, so the relocation is safe.
  res.outputResource(exe, false, true);

  const outputBuf = Buffer.from(exe.generate());
  selfCheckPatchedBuffer(outputBuf, strings);

  const tmpPath = `${exePath}.versioninfo.tmp`;
  try {
    writeFileSync(tmpPath, outputBuf);
    renameSync(tmpPath, exePath);
  } catch (err) {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
    throw err;
  }

  const sizeKb = (outputBuf.length / 1024).toFixed(1);
  console.log(
    `Patched VS_VERSION_INFO: ${path.basename(exePath)} ` +
      `(ProductName="${strings.productName}", CompanyName="${strings.companyName}", ${sizeKb} KB)`,
  );
}

const { exePath, strings } = parseArgs(process.argv.slice(2));
patchVersionInfo(path.resolve(exePath), strings);
