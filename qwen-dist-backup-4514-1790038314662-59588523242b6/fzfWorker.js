"use strict";
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// scripts/esbuild-shims.js
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
var _require = createRequire(import.meta.url);
if (typeof globalThis.require === "undefined") {
  globalThis.require = _require;
}
var __qwen_filename = fileURLToPath(import.meta.url);
var __qwen_dirname = dirname(__qwen_filename);

// packages/core/src/utils/filesearch/fzfWorker.ts
import { parentPort } from "node:worker_threads";

// node_modules/fzf/dist/fzf.es.js
var normalized = {
  216: "O",
  223: "s",
  248: "o",
  273: "d",
  295: "h",
  305: "i",
  320: "l",
  322: "l",
  359: "t",
  383: "s",
  384: "b",
  385: "B",
  387: "b",
  390: "O",
  392: "c",
  393: "D",
  394: "D",
  396: "d",
  398: "E",
  400: "E",
  402: "f",
  403: "G",
  407: "I",
  409: "k",
  410: "l",
  412: "M",
  413: "N",
  414: "n",
  415: "O",
  421: "p",
  427: "t",
  429: "t",
  430: "T",
  434: "V",
  436: "y",
  438: "z",
  477: "e",
  485: "g",
  544: "N",
  545: "d",
  549: "z",
  564: "l",
  565: "n",
  566: "t",
  567: "j",
  570: "A",
  571: "C",
  572: "c",
  573: "L",
  574: "T",
  575: "s",
  576: "z",
  579: "B",
  580: "U",
  581: "V",
  582: "E",
  583: "e",
  584: "J",
  585: "j",
  586: "Q",
  587: "q",
  588: "R",
  589: "r",
  590: "Y",
  591: "y",
  592: "a",
  593: "a",
  595: "b",
  596: "o",
  597: "c",
  598: "d",
  599: "d",
  600: "e",
  603: "e",
  604: "e",
  605: "e",
  606: "e",
  607: "j",
  608: "g",
  609: "g",
  610: "G",
  613: "h",
  614: "h",
  616: "i",
  618: "I",
  619: "l",
  620: "l",
  621: "l",
  623: "m",
  624: "m",
  625: "m",
  626: "n",
  627: "n",
  628: "N",
  629: "o",
  633: "r",
  634: "r",
  635: "r",
  636: "r",
  637: "r",
  638: "r",
  639: "r",
  640: "R",
  641: "R",
  642: "s",
  647: "t",
  648: "t",
  649: "u",
  651: "v",
  652: "v",
  653: "w",
  654: "y",
  655: "Y",
  656: "z",
  657: "z",
  663: "c",
  665: "B",
  666: "e",
  667: "G",
  668: "H",
  669: "j",
  670: "k",
  671: "L",
  672: "q",
  686: "h",
  867: "a",
  868: "e",
  869: "i",
  870: "o",
  871: "u",
  872: "c",
  873: "d",
  874: "h",
  875: "m",
  876: "r",
  877: "t",
  878: "v",
  879: "x",
  7424: "A",
  7427: "B",
  7428: "C",
  7429: "D",
  7431: "E",
  7432: "e",
  7433: "i",
  7434: "J",
  7435: "K",
  7436: "L",
  7437: "M",
  7438: "N",
  7439: "O",
  7440: "O",
  7441: "o",
  7442: "o",
  7443: "o",
  7446: "o",
  7447: "o",
  7448: "P",
  7449: "R",
  7450: "R",
  7451: "T",
  7452: "U",
  7453: "u",
  7454: "u",
  7455: "m",
  7456: "V",
  7457: "W",
  7458: "Z",
  7522: "i",
  7523: "r",
  7524: "u",
  7525: "v",
  7834: "a",
  7835: "s",
  8305: "i",
  8341: "h",
  8342: "k",
  8343: "l",
  8344: "m",
  8345: "n",
  8346: "p",
  8347: "s",
  8348: "t",
  8580: "c"
};
for (let i = "\u0300".codePointAt(0); i <= "\u036F".codePointAt(0); ++i) {
  const diacritic = String.fromCodePoint(i);
  for (const asciiChar of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz") {
    const withDiacritic = (asciiChar + diacritic).normalize();
    const withDiacriticCodePoint = withDiacritic.codePointAt(0);
    if (withDiacriticCodePoint > 126) {
      normalized[withDiacriticCodePoint] = asciiChar;
    }
  }
}
var ranges = {
  a: [7844, 7863],
  e: [7870, 7879],
  o: [7888, 7907],
  u: [7912, 7921]
};
for (const lowerChar of Object.keys(ranges)) {
  const upperChar = lowerChar.toUpperCase();
  for (let i = ranges[lowerChar][0]; i <= ranges[lowerChar][1]; ++i) {
    normalized[i] = i % 2 === 0 ? upperChar : lowerChar;
  }
}
function normalizeRune(rune) {
  if (rune < 192 || rune > 8580) {
    return rune;
  }
  const normalizedChar = normalized[rune];
  if (normalizedChar !== void 0)
    return normalizedChar.codePointAt(0);
  return rune;
}
__name(normalizeRune, "normalizeRune");
function toShort(number) {
  return number;
}
__name(toShort, "toShort");
function toInt(number) {
  return number;
}
__name(toInt, "toInt");
function maxInt16(num1, num2) {
  return num1 > num2 ? num1 : num2;
}
__name(maxInt16, "maxInt16");
var strToRunes = /* @__PURE__ */ __name((str) => str.split("").map((s) => s.codePointAt(0)), "strToRunes");
var whitespaceRunes = new Set(
  " \f\n\r	\v\xA0\u1680\u2028\u2029\u202F\u205F\u3000\uFEFF".split("").map((v) => v.codePointAt(0))
);
for (let codePoint = "\u2000".codePointAt(0); codePoint <= "\u200A".codePointAt(0); codePoint++) {
  whitespaceRunes.add(codePoint);
}
var MAX_ASCII = "\x7F".codePointAt(0);
var CAPITAL_A_RUNE = "A".codePointAt(0);
var CAPITAL_Z_RUNE = "Z".codePointAt(0);
var SMALL_A_RUNE = "a".codePointAt(0);
var SMALL_Z_RUNE = "z".codePointAt(0);
var NUMERAL_ZERO_RUNE = "0".codePointAt(0);
var NUMERAL_NINE_RUNE = "9".codePointAt(0);
function indexAt(index, max, forward) {
  if (forward) {
    return index;
  }
  return max - index - 1;
}
__name(indexAt, "indexAt");
var SCORE_MATCH = 16;
var SCORE_GAP_START = -3;
var SCORE_GAP_EXTENTION = -1;
var BONUS_BOUNDARY = SCORE_MATCH / 2;
var BONUS_NON_WORD = SCORE_MATCH / 2;
var BONUS_CAMEL_123 = BONUS_BOUNDARY + SCORE_GAP_EXTENTION;
var BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENTION);
var BONUS_FIRST_CHAR_MULTIPLIER = 2;
function createPosSet(withPos) {
  if (withPos) {
    return /* @__PURE__ */ new Set();
  }
  return null;
}
__name(createPosSet, "createPosSet");
function alloc16(offset, slab2, size) {
  if (slab2 !== null && slab2.i16.length > offset + size) {
    const subarray = slab2.i16.subarray(offset, offset + size);
    return [offset + size, subarray];
  }
  return [offset, new Int16Array(size)];
}
__name(alloc16, "alloc16");
function alloc32(offset, slab2, size) {
  if (slab2 !== null && slab2.i32.length > offset + size) {
    const subarray = slab2.i32.subarray(offset, offset + size);
    return [offset + size, subarray];
  }
  return [offset, new Int32Array(size)];
}
__name(alloc32, "alloc32");
function charClassOfAscii(rune) {
  if (rune >= SMALL_A_RUNE && rune <= SMALL_Z_RUNE) {
    return 1;
  } else if (rune >= CAPITAL_A_RUNE && rune <= CAPITAL_Z_RUNE) {
    return 2;
  } else if (rune >= NUMERAL_ZERO_RUNE && rune <= NUMERAL_NINE_RUNE) {
    return 4;
  } else {
    return 0;
  }
}
__name(charClassOfAscii, "charClassOfAscii");
function charClassOfNonAscii(rune) {
  const char = String.fromCodePoint(rune);
  if (char !== char.toUpperCase()) {
    return 1;
  } else if (char !== char.toLowerCase()) {
    return 2;
  } else if (char.match(new RegExp("\\p{Number}", "gu")) !== null) {
    return 4;
  } else if (char.match(new RegExp("\\p{Letter}", "gu")) !== null) {
    return 3;
  }
  return 0;
}
__name(charClassOfNonAscii, "charClassOfNonAscii");
function charClassOf(rune) {
  if (rune <= MAX_ASCII) {
    return charClassOfAscii(rune);
  }
  return charClassOfNonAscii(rune);
}
__name(charClassOf, "charClassOf");
function bonusFor(prevClass, currClass) {
  if (prevClass === 0 && currClass !== 0) {
    return BONUS_BOUNDARY;
  } else if (prevClass === 1 && currClass === 2 || prevClass !== 4 && currClass === 4) {
    return BONUS_CAMEL_123;
  } else if (currClass === 0) {
    return BONUS_NON_WORD;
  }
  return 0;
}
__name(bonusFor, "bonusFor");
function bonusAt(input, idx) {
  if (idx === 0) {
    return BONUS_BOUNDARY;
  }
  return bonusFor(charClassOf(input[idx - 1]), charClassOf(input[idx]));
}
__name(bonusAt, "bonusAt");
function trySkip(input, caseSensitive, char, from) {
  let rest = input.slice(from);
  let idx = rest.indexOf(char);
  if (idx === 0) {
    return from;
  }
  if (!caseSensitive && char >= SMALL_A_RUNE && char <= SMALL_Z_RUNE) {
    if (idx > 0) {
      rest = rest.slice(0, idx);
    }
    const uidx = rest.indexOf(char - 32);
    if (uidx >= 0) {
      idx = uidx;
    }
  }
  if (idx < 0) {
    return -1;
  }
  return from + idx;
}
__name(trySkip, "trySkip");
function isAscii(runes) {
  for (const rune of runes) {
    if (rune >= 128) {
      return false;
    }
  }
  return true;
}
__name(isAscii, "isAscii");
function asciiFuzzyIndex(input, pattern, caseSensitive) {
  if (!isAscii(input)) {
    return 0;
  }
  if (!isAscii(pattern)) {
    return -1;
  }
  let firstIdx = 0, idx = 0;
  for (let pidx = 0; pidx < pattern.length; pidx++) {
    idx = trySkip(input, caseSensitive, pattern[pidx], idx);
    if (idx < 0) {
      return -1;
    }
    if (pidx === 0 && idx > 0) {
      firstIdx = idx - 1;
    }
    idx++;
  }
  return firstIdx;
}
__name(asciiFuzzyIndex, "asciiFuzzyIndex");
var fuzzyMatchV2 = /* @__PURE__ */ __name((caseSensitive, normalize, forward, input, pattern, withPos, slab2) => {
  const M = pattern.length;
  if (M === 0) {
    return [{ start: 0, end: 0, score: 0 }, createPosSet(withPos)];
  }
  const N = input.length;
  if (slab2 !== null && N * M > slab2.i16.length) {
    return fuzzyMatchV1(caseSensitive, normalize, forward, input, pattern, withPos);
  }
  const idx = asciiFuzzyIndex(input, pattern, caseSensitive);
  if (idx < 0) {
    return [{ start: -1, end: -1, score: 0 }, null];
  }
  let offset16 = 0, offset32 = 0, H0 = null, C0 = null, B = null, F = null;
  [offset16, H0] = alloc16(offset16, slab2, N);
  [offset16, C0] = alloc16(offset16, slab2, N);
  [offset16, B] = alloc16(offset16, slab2, N);
  [offset32, F] = alloc32(offset32, slab2, M);
  const [, T] = alloc32(offset32, slab2, N);
  for (let i = 0; i < T.length; i++) {
    T[i] = input[i];
  }
  let maxScore = toShort(0), maxScorePos = 0;
  let pidx = 0, lastIdx = 0;
  const pchar0 = pattern[0];
  let pchar = pattern[0], prevH0 = toShort(0), prevCharClass = 0, inGap = false;
  let Tsub = T.subarray(idx);
  let H0sub = H0.subarray(idx).subarray(0, Tsub.length), C0sub = C0.subarray(idx).subarray(0, Tsub.length), Bsub = B.subarray(idx).subarray(0, Tsub.length);
  for (let [off, char] of Tsub.entries()) {
    let charClass = null;
    if (char <= MAX_ASCII) {
      charClass = charClassOfAscii(char);
      if (!caseSensitive && charClass === 2) {
        char += 32;
      }
    } else {
      charClass = charClassOfNonAscii(char);
      if (!caseSensitive && charClass === 2) {
        char = String.fromCodePoint(char).toLowerCase().codePointAt(0);
      }
      if (normalize) {
        char = normalizeRune(char);
      }
    }
    Tsub[off] = char;
    const bonus = bonusFor(prevCharClass, charClass);
    Bsub[off] = bonus;
    prevCharClass = charClass;
    if (char === pchar) {
      if (pidx < M) {
        F[pidx] = toInt(idx + off);
        pidx++;
        pchar = pattern[Math.min(pidx, M - 1)];
      }
      lastIdx = idx + off;
    }
    if (char === pchar0) {
      const score = SCORE_MATCH + bonus * BONUS_FIRST_CHAR_MULTIPLIER;
      H0sub[off] = score;
      C0sub[off] = 1;
      if (M === 1 && (forward && score > maxScore || !forward && score >= maxScore)) {
        maxScore = score;
        maxScorePos = idx + off;
        if (forward && bonus === BONUS_BOUNDARY) {
          break;
        }
      }
      inGap = false;
    } else {
      if (inGap) {
        H0sub[off] = maxInt16(prevH0 + SCORE_GAP_EXTENTION, 0);
      } else {
        H0sub[off] = maxInt16(prevH0 + SCORE_GAP_START, 0);
      }
      C0sub[off] = 0;
      inGap = true;
    }
    prevH0 = H0sub[off];
  }
  if (pidx !== M) {
    return [{ start: -1, end: -1, score: 0 }, null];
  }
  if (M === 1) {
    const result = {
      start: maxScorePos,
      end: maxScorePos + 1,
      score: maxScore
    };
    if (!withPos) {
      return [result, null];
    }
    const pos2 = /* @__PURE__ */ new Set();
    pos2.add(maxScorePos);
    return [result, pos2];
  }
  const f0 = F[0];
  const width = lastIdx - f0 + 1;
  let H = null;
  [offset16, H] = alloc16(offset16, slab2, width * M);
  {
    const toCopy = H0.subarray(f0, lastIdx + 1);
    for (const [i, v] of toCopy.entries()) {
      H[i] = v;
    }
  }
  let [, C] = alloc16(offset16, slab2, width * M);
  {
    const toCopy = C0.subarray(f0, lastIdx + 1);
    for (const [i, v] of toCopy.entries()) {
      C[i] = v;
    }
  }
  const Fsub = F.subarray(1);
  const Psub = pattern.slice(1).slice(0, Fsub.length);
  for (const [off, f] of Fsub.entries()) {
    let inGap2 = false;
    const pchar2 = Psub[off], pidx2 = off + 1, row = pidx2 * width, Tsub2 = T.subarray(f, lastIdx + 1), Bsub2 = B.subarray(f).subarray(0, Tsub2.length), Csub = C.subarray(row + f - f0).subarray(0, Tsub2.length), Cdiag = C.subarray(row + f - f0 - 1 - width).subarray(0, Tsub2.length), Hsub = H.subarray(row + f - f0).subarray(0, Tsub2.length), Hdiag = H.subarray(row + f - f0 - 1 - width).subarray(0, Tsub2.length), Hleft = H.subarray(row + f - f0 - 1).subarray(0, Tsub2.length);
    Hleft[0] = 0;
    for (const [off2, char] of Tsub2.entries()) {
      const col = off2 + f;
      let s1 = 0, s2 = 0, consecutive = 0;
      if (inGap2) {
        s2 = Hleft[off2] + SCORE_GAP_EXTENTION;
      } else {
        s2 = Hleft[off2] + SCORE_GAP_START;
      }
      if (pchar2 === char) {
        s1 = Hdiag[off2] + SCORE_MATCH;
        let b = Bsub2[off2];
        consecutive = Cdiag[off2] + 1;
        if (b === BONUS_BOUNDARY) {
          consecutive = 1;
        } else if (consecutive > 1) {
          b = maxInt16(b, maxInt16(BONUS_CONSECUTIVE, B[col - consecutive + 1]));
        }
        if (s1 + b < s2) {
          s1 += Bsub2[off2];
          consecutive = 0;
        } else {
          s1 += b;
        }
      }
      Csub[off2] = consecutive;
      inGap2 = s1 < s2;
      const score = maxInt16(maxInt16(s1, s2), 0);
      if (pidx2 === M - 1 && (forward && score > maxScore || !forward && score >= maxScore)) {
        maxScore = score;
        maxScorePos = col;
      }
      Hsub[off2] = score;
    }
  }
  const pos = createPosSet(withPos);
  let j = f0;
  if (withPos && pos !== null) {
    let i = M - 1;
    j = maxScorePos;
    let preferMatch = true;
    while (true) {
      const I = i * width, j0 = j - f0, s = H[I + j0];
      let s1 = 0, s2 = 0;
      if (i > 0 && j >= F[i]) {
        s1 = H[I - width + j0 - 1];
      }
      if (j > F[i]) {
        s2 = H[I + j0 - 1];
      }
      if (s > s1 && (s > s2 || s === s2 && preferMatch)) {
        pos.add(j);
        if (i === 0) {
          break;
        }
        i--;
      }
      preferMatch = C[I + j0] > 1 || I + width + j0 + 1 < C.length && C[I + width + j0 + 1] > 0;
      j--;
    }
  }
  return [{ start: j, end: maxScorePos + 1, score: maxScore }, pos];
}, "fuzzyMatchV2");
function calculateScore(caseSensitive, normalize, text, pattern, sidx, eidx, withPos) {
  let pidx = 0, score = 0, inGap = false, consecutive = 0, firstBonus = toShort(0);
  const pos = createPosSet(withPos);
  let prevCharClass = 0;
  if (sidx > 0) {
    prevCharClass = charClassOf(text[sidx - 1]);
  }
  for (let idx = sidx; idx < eidx; idx++) {
    let rune = text[idx];
    const charClass = charClassOf(rune);
    if (!caseSensitive) {
      if (rune >= CAPITAL_A_RUNE && rune <= CAPITAL_Z_RUNE) {
        rune += 32;
      } else if (rune > MAX_ASCII) {
        rune = String.fromCodePoint(rune).toLowerCase().codePointAt(0);
      }
    }
    if (normalize) {
      rune = normalizeRune(rune);
    }
    if (rune === pattern[pidx]) {
      if (withPos && pos !== null) {
        pos.add(idx);
      }
      score += SCORE_MATCH;
      let bonus = bonusFor(prevCharClass, charClass);
      if (consecutive === 0) {
        firstBonus = bonus;
      } else {
        if (bonus === BONUS_BOUNDARY) {
          firstBonus = bonus;
        }
        bonus = maxInt16(maxInt16(bonus, firstBonus), BONUS_CONSECUTIVE);
      }
      if (pidx === 0) {
        score += bonus * BONUS_FIRST_CHAR_MULTIPLIER;
      } else {
        score += bonus;
      }
      inGap = false;
      consecutive++;
      pidx++;
    } else {
      if (inGap) {
        score += SCORE_GAP_EXTENTION;
      } else {
        score += SCORE_GAP_START;
      }
      inGap = true;
      consecutive = 0;
      firstBonus = 0;
    }
    prevCharClass = charClass;
  }
  return [score, pos];
}
__name(calculateScore, "calculateScore");
var fuzzyMatchV1 = /* @__PURE__ */ __name((caseSensitive, normalize, forward, text, pattern, withPos, slab2) => {
  if (pattern.length === 0) {
    return [{ start: 0, end: 0, score: 0 }, null];
  }
  if (asciiFuzzyIndex(text, pattern, caseSensitive) < 0) {
    return [{ start: -1, end: -1, score: 0 }, null];
  }
  let pidx = 0, sidx = -1, eidx = -1;
  const lenRunes = text.length;
  const lenPattern = pattern.length;
  for (let index = 0; index < lenRunes; index++) {
    let rune = text[indexAt(index, lenRunes, forward)];
    if (!caseSensitive) {
      if (rune >= CAPITAL_A_RUNE && rune <= CAPITAL_Z_RUNE) {
        rune += 32;
      } else if (rune > MAX_ASCII) {
        rune = String.fromCodePoint(rune).toLowerCase().codePointAt(0);
      }
    }
    if (normalize) {
      rune = normalizeRune(rune);
    }
    const pchar = pattern[indexAt(pidx, lenPattern, forward)];
    if (rune === pchar) {
      if (sidx < 0) {
        sidx = index;
      }
      pidx++;
      if (pidx === lenPattern) {
        eidx = index + 1;
        break;
      }
    }
  }
  if (sidx >= 0 && eidx >= 0) {
    pidx--;
    for (let index = eidx - 1; index >= sidx; index--) {
      const tidx = indexAt(index, lenRunes, forward);
      let rune = text[tidx];
      if (!caseSensitive) {
        if (rune >= CAPITAL_A_RUNE && rune <= CAPITAL_Z_RUNE) {
          rune += 32;
        } else if (rune > MAX_ASCII) {
          rune = String.fromCodePoint(rune).toLowerCase().codePointAt(0);
        }
      }
      const pidx_ = indexAt(pidx, lenPattern, forward);
      const pchar = pattern[pidx_];
      if (rune === pchar) {
        pidx--;
        if (pidx < 0) {
          sidx = index;
          break;
        }
      }
    }
    if (!forward) {
      const sidxTemp = sidx;
      sidx = lenRunes - eidx;
      eidx = lenRunes - sidxTemp;
    }
    const [score, pos] = calculateScore(
      caseSensitive,
      normalize,
      text,
      pattern,
      sidx,
      eidx,
      withPos
    );
    return [{ start: sidx, end: eidx, score }, pos];
  }
  return [{ start: -1, end: -1, score: 0 }, null];
}, "fuzzyMatchV1");
var exactMatchNaive = /* @__PURE__ */ __name((caseSensitive, normalize, forward, text, pattern, withPos, slab2) => {
  if (pattern.length === 0) {
    return [{ start: 0, end: 0, score: 0 }, null];
  }
  const lenRunes = text.length;
  const lenPattern = pattern.length;
  if (lenRunes < lenPattern) {
    return [{ start: -1, end: -1, score: 0 }, null];
  }
  if (asciiFuzzyIndex(text, pattern, caseSensitive) < 0) {
    return [{ start: -1, end: -1, score: 0 }, null];
  }
  let pidx = 0;
  let bestPos = -1, bonus = toShort(0), bestBonus = toShort(-1);
  for (let index = 0; index < lenRunes; index++) {
    const index_ = indexAt(index, lenRunes, forward);
    let rune = text[index_];
    if (!caseSensitive) {
      if (rune >= CAPITAL_A_RUNE && rune <= CAPITAL_Z_RUNE) {
        rune += 32;
      } else if (rune > MAX_ASCII) {
        rune = String.fromCodePoint(rune).toLowerCase().codePointAt(0);
      }
    }
    if (normalize) {
      rune = normalizeRune(rune);
    }
    const pidx_ = indexAt(pidx, lenPattern, forward);
    const pchar = pattern[pidx_];
    if (pchar === rune) {
      if (pidx_ === 0) {
        bonus = bonusAt(text, index_);
      }
      pidx++;
      if (pidx === lenPattern) {
        if (bonus > bestBonus) {
          bestPos = index;
          bestBonus = bonus;
        }
        if (bonus === BONUS_BOUNDARY) {
          break;
        }
        index -= pidx - 1;
        pidx = 0;
        bonus = 0;
      }
    } else {
      index -= pidx;
      pidx = 0;
      bonus = 0;
    }
  }
  if (bestPos >= 0) {
    let sidx = 0, eidx = 0;
    if (forward) {
      sidx = bestPos - lenPattern + 1;
      eidx = bestPos + 1;
    } else {
      sidx = lenRunes - (bestPos + 1);
      eidx = lenRunes - (bestPos - lenPattern + 1);
    }
    const [score] = calculateScore(caseSensitive, normalize, text, pattern, sidx, eidx, false);
    return [{ start: sidx, end: eidx, score }, null];
  }
  return [{ start: -1, end: -1, score: 0 }, null];
}, "exactMatchNaive");
var SLAB_16_SIZE = 100 * 1024;
var SLAB_32_SIZE = 2048;
function makeSlab(size16, size32) {
  return {
    i16: new Int16Array(size16),
    i32: new Int32Array(size32)
  };
}
__name(makeSlab, "makeSlab");
var slab = makeSlab(SLAB_16_SIZE, SLAB_32_SIZE);
var buildPatternForBasicMatch = /* @__PURE__ */ __name((query, casing, normalize) => {
  let caseSensitive = false;
  switch (casing) {
    case "smart-case":
      if (query.toLowerCase() !== query) {
        caseSensitive = true;
      }
      break;
    case "case-sensitive":
      caseSensitive = true;
      break;
    case "case-insensitive":
      query = query.toLowerCase();
      caseSensitive = false;
      break;
  }
  let queryRunes = strToRunes(query);
  if (normalize) {
    queryRunes = queryRunes.map(normalizeRune);
  }
  return {
    queryRunes,
    caseSensitive
  };
}, "buildPatternForBasicMatch");
function getResultFromScoreMap(scoreMap, limit) {
  const scoresInDesc = Object.keys(scoreMap).map((v) => parseInt(v, 10)).sort((a, b) => b - a);
  let result = [];
  for (const score of scoresInDesc) {
    result = result.concat(scoreMap[score]);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}
__name(getResultFromScoreMap, "getResultFromScoreMap");
function getBasicMatchIter(scoreMap, queryRunes, caseSensitive) {
  return (idx) => {
    const itemRunes = this.runesList[idx];
    if (queryRunes.length > itemRunes.length)
      return;
    let [match, positions] = this.algoFn(
      caseSensitive,
      this.opts.normalize,
      this.opts.forward,
      itemRunes,
      queryRunes,
      true,
      slab
    );
    if (match.start === -1)
      return;
    if (this.opts.fuzzy === false) {
      positions = /* @__PURE__ */ new Set();
      for (let position = match.start; position < match.end; ++position) {
        positions.add(position);
      }
    }
    const scoreKey = this.opts.sort ? match.score : 0;
    if (scoreMap[scoreKey] === void 0) {
      scoreMap[scoreKey] = [];
    }
    scoreMap[scoreKey].push({
      item: this.items[idx],
      ...match,
      positions: positions != null ? positions : /* @__PURE__ */ new Set()
    });
  };
}
__name(getBasicMatchIter, "getBasicMatchIter");
function basicMatch(query) {
  const { queryRunes, caseSensitive } = buildPatternForBasicMatch(
    query,
    this.opts.casing,
    this.opts.normalize
  );
  const scoreMap = {};
  const iter2 = getBasicMatchIter.bind(this)(
    scoreMap,
    queryRunes,
    caseSensitive
  );
  for (let i = 0, len = this.runesList.length; i < len; ++i) {
    iter2(i);
  }
  return getResultFromScoreMap(scoreMap, this.opts.limit);
}
__name(basicMatch, "basicMatch");
var isNode = typeof __require !== "undefined" && typeof window === "undefined";
function asyncMatcher(token, len, iter2, onFinish) {
  return new Promise((resolve, reject) => {
    const INCREMENT = 1e3;
    let i = 0, end = Math.min(INCREMENT, len);
    const step = /* @__PURE__ */ __name(() => {
      if (token.cancelled)
        return reject("search cancelled");
      for (; i < end; ++i) {
        iter2(i);
      }
      if (end < len) {
        end = Math.min(end + INCREMENT, len);
        isNode ? setImmediate(step) : setTimeout(step);
      } else {
        resolve(onFinish());
      }
    }, "step");
    step();
  });
}
__name(asyncMatcher, "asyncMatcher");
function asyncBasicMatch(query, token) {
  const { queryRunes, caseSensitive } = buildPatternForBasicMatch(
    query,
    this.opts.casing,
    this.opts.normalize
  );
  const scoreMap = {};
  return asyncMatcher(
    token,
    this.runesList.length,
    getBasicMatchIter.bind(this)(scoreMap, queryRunes, caseSensitive),
    () => getResultFromScoreMap(scoreMap, this.opts.limit)
  );
}
__name(asyncBasicMatch, "asyncBasicMatch");
var defaultOpts = {
  limit: Infinity,
  selector: /* @__PURE__ */ __name((v) => v, "selector"),
  casing: "smart-case",
  normalize: true,
  fuzzy: "v2",
  tiebreakers: [],
  sort: true,
  forward: true
};
var BaseFinder = class {
  static {
    __name(this, "BaseFinder");
  }
  constructor(list, ...optionsTuple) {
    this.opts = { ...defaultOpts, ...optionsTuple[0] };
    this.items = list;
    this.runesList = list.map((item) => strToRunes(this.opts.selector(item).normalize()));
    this.algoFn = exactMatchNaive;
    switch (this.opts.fuzzy) {
      case "v2":
        this.algoFn = fuzzyMatchV2;
        break;
      case "v1":
        this.algoFn = fuzzyMatchV1;
        break;
    }
  }
};
var syncDefaultOpts = {
  ...defaultOpts,
  match: basicMatch
};
var asyncDefaultOpts = {
  ...defaultOpts,
  match: asyncBasicMatch
};
var AsyncFinder = class extends BaseFinder {
  static {
    __name(this, "AsyncFinder");
  }
  constructor(list, ...optionsTuple) {
    super(list, ...optionsTuple);
    this.opts = { ...asyncDefaultOpts, ...optionsTuple[0] };
    this.token = { cancelled: false };
  }
  async find(query) {
    this.token.cancelled = true;
    this.token = { cancelled: false };
    if (query.length === 0 || this.items.length === 0)
      return this.items.slice(0, this.opts.limit).map(createResultItemWithEmptyPos);
    query = query.normalize();
    let result = await this.opts.match.bind(this)(query, this.token);
    return postProcessResultItems(result, this.opts);
  }
};
var createResultItemWithEmptyPos = /* @__PURE__ */ __name((item) => ({
  item,
  start: -1,
  end: -1,
  score: 0,
  positions: /* @__PURE__ */ new Set()
}), "createResultItemWithEmptyPos");
function postProcessResultItems(result, opts) {
  if (opts.sort) {
    const { selector } = opts;
    result.sort((a, b) => {
      if (a.score === b.score) {
        for (const tiebreaker of opts.tiebreakers) {
          const diff = tiebreaker(a, b, selector);
          if (diff !== 0) {
            return diff;
          }
        }
      }
      return 0;
    });
  }
  if (Number.isFinite(opts.limit)) {
    result.splice(opts.limit);
  }
  return result;
}
__name(postProcessResultItems, "postProcessResultItems");
var AsyncFzf = class {
  static {
    __name(this, "AsyncFzf");
  }
  constructor(list, ...optionsTuple) {
    this.finder = new AsyncFinder(list, ...optionsTuple);
    this.find = this.finder.find.bind(this.finder);
  }
};

// packages/core/src/utils/filesearch/fzfWorker.ts
if (!parentPort) {
  throw new Error("fzfWorker.ts must be loaded as a worker_threads worker");
}
var port = parentPort;
var fzf = null;
port.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "init") {
    try {
      fzf = new AsyncFzf(msg.files, msg.options);
      port.postMessage({ type: "ready" });
    } catch (err) {
      port.postMessage({
        type: "init-error",
        message: err instanceof Error ? err.message : String(err)
      });
    }
    return;
  }
  if (msg.type === "find") {
    if (!fzf) {
      port.postMessage({
        type: "find-error",
        reqId: msg.reqId,
        message: "fzf not initialized"
      });
      return;
    }
    fzf.find(msg.pattern).then((items) => {
      const limit = msg.limit ?? items.length;
      const trimmed = items.slice(0, limit).map((entry) => ({ item: entry.item }));
      port.postMessage({ type: "result", reqId: msg.reqId, items: trimmed });
    }).catch((err) => {
      port.postMessage({
        type: "find-error",
        reqId: msg.reqId,
        message: err instanceof Error ? err.message : String(err)
      });
    });
    return;
  }
  if (msg.type === "dispose") {
    fzf = null;
    port.close();
    return;
  }
});
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */
/*! Bundled license information:

fzf/dist/fzf.es.js:
  (** @license
   * fzf v0.5.2
   * Copyright (c) 2021 Ajit
   * Licensed under BSD 3-Clause
   *)
*/
