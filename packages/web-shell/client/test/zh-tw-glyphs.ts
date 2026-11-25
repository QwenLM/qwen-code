/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The CLI's zh and zh-TW packs translate one key set and are hand-corrected for
// Taiwan, so a Han character the Simplified pack uses and the Traditional pack
// never uses is a Simplified-only glyph. Deriving the class from that corpus
// catches a Simplified paste anywhere; the hand-enumerated class this replaces
// missed most of them (本轮已结束, Qwen 订阅). Glyphs both scripts share
// (析/表/置/系/存) appear in the Traditional pack and drop out by construction.

// jsdom rewrites import.meta.url to an http URL; dirname stays a real path.
const repoRoot = resolve(import.meta.dirname, '../../../..');
const HAN = /[㐀-鿿]/;

async function packCharacters(locale: 'zh' | 'zh-TW'): Promise<Set<string>> {
  const { default: pack } = (await import(
    pathToFileURL(`${repoRoot}/packages/cli/src/i18n/locales/${locale}.js`).href
  )) as { default: Record<string, string | string[]> };
  const text = Object.values(pack).flat().join('');
  return new Set([...text].filter((char) => HAN.test(char)));
}

// Valid Traditional glyphs the CLI pack renders with another word (克隆→複製,
// 套餐→方案, 宿主→主機, 捕獲→擷取, 逐項→詳細, 折疊→摺疊) or drops (那裡), so the
// corpus difference alone would red on correct Web Shell copy that uses them.
const TRADITIONAL_GLYPHS_THE_CLI_PACK_OMITS = new Set([
  '隆',
  '那',
  '餐',
  '宿',
  '捕',
  '逐',
  '折',
]);

const simplified = await packCharacters('zh');
const traditional = await packCharacters('zh-TW');

export const SIMPLIFIED_ONLY_GLYPHS = new RegExp(
  `[${[...simplified]
    .filter(
      (char) =>
        !traditional.has(char) &&
        !TRADITIONAL_GLYPHS_THE_CLI_PACK_OMITS.has(char),
    )
    .join('')}]`,
);
