/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const COMMAND_REPLACEMENTS: Record<string, string> = {
  '\\alpha': 'α',
  '\\beta': 'β',
  '\\gamma': 'γ',
  '\\delta': 'δ',
  '\\epsilon': 'ε',
  '\\varepsilon': 'ε',
  '\\theta': 'θ',
  '\\lambda': 'λ',
  '\\mu': 'μ',
  '\\pi': 'π',
  '\\rho': 'ρ',
  '\\sigma': 'σ',
  '\\tau': 'τ',
  '\\phi': 'φ',
  '\\varphi': 'φ',
  '\\omega': 'ω',
  '\\Gamma': 'Γ',
  '\\Delta': 'Δ',
  '\\Theta': 'Θ',
  '\\Lambda': 'Λ',
  '\\Pi': 'Π',
  '\\Sigma': 'Σ',
  '\\Phi': 'Φ',
  '\\Omega': 'Ω',
  '\\sum': 'Σ',
  '\\prod': '∏',
  '\\int': '∫',
  '\\infty': '∞',
  '\\partial': '∂',
  '\\sqrt': '√',
  '\\times': '×',
  '\\cdot': '·',
  '\\pm': '±',
  '\\leq': '≤',
  '\\geq': '≥',
  '\\neq': '≠',
  '\\approx': '≈',
  '\\rightarrow': '→',
  '\\to': '→',
  '\\leftarrow': '←',
  '\\Rightarrow': '⇒',
  '\\Leftarrow': '⇐',
};
const COMMAND_REPLACEMENT_REGEX = new RegExp(
  Object.keys(COMMAND_REPLACEMENTS)
    .sort((a, b) => b.length - a.length)
    .map((command) => command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g',
);
const MAX_RENDER_DEPTH = 10;

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  n: 'ⁿ',
  i: 'ⁱ',
};

const SUBSCRIPT: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  h: 'ₕ',
  i: 'ᵢ',
  j: 'ⱼ',
  k: 'ₖ',
  l: 'ₗ',
  m: 'ₘ',
  n: 'ₙ',
  o: 'ₒ',
  p: 'ₚ',
  r: 'ᵣ',
  s: 'ₛ',
  t: 'ₜ',
  u: 'ᵤ',
  v: 'ᵥ',
  x: 'ₓ',
};

function convertScript(value: string, map: Record<string, string>): string {
  return [...value].map((char) => map[char] ?? char).join('');
}

function findBalancedGroup(
  input: string,
  openBraceIndex: number,
): { value: string; end: number } | null {
  if (input[openBraceIndex] !== '{') {
    return null;
  }

  let depth = 0;
  for (let index = openBraceIndex; index < input.length; index++) {
    const char = input[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char !== '}') {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return {
        value: input.slice(openBraceIndex + 1, index),
        end: index + 1,
      };
    }
  }

  return null;
}

function replaceBraceCommand(
  input: string,
  command: string,
  groupCount: number,
  render: (groups: string[]) => string,
): string {
  const marker = `\\${command}`;
  let output = '';
  let index = 0;

  while (index < input.length) {
    if (!input.startsWith(marker, index)) {
      output += input[index];
      index += 1;
      continue;
    }

    const groups: string[] = [];
    let cursor = index + marker.length;
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
      const group = findBalancedGroup(input, cursor);
      if (!group) {
        groups.length = 0;
        break;
      }
      groups.push(group.value);
      cursor = group.end;
    }

    if (groups.length !== groupCount) {
      output += input[index];
      index += 1;
      continue;
    }

    output += render(groups);
    index = cursor;
  }

  return output;
}

export function renderInlineLatex(input: string, depth = 0): string {
  let output = input.trim();
  if (depth > MAX_RENDER_DEPTH) {
    return output;
  }

  output = replaceBraceCommand(
    output,
    'frac',
    2,
    ([numerator, denominator]) =>
      `${renderInlineLatex(numerator ?? '', depth + 1)}/${renderInlineLatex(
        denominator ?? '',
        depth + 1,
      )}`,
  );

  output = replaceBraceCommand(
    output,
    'sqrt',
    1,
    ([radicand]) => `√(${renderInlineLatex(radicand ?? '', depth + 1)})`,
  );

  output = output.replace(
    /\^\{([^{}]+)\}|\^([A-Za-z0-9+\-=()])/g,
    (_match, braced: string | undefined, single: string | undefined) =>
      convertScript(braced ?? single ?? '', SUPERSCRIPT),
  );

  output = output.replace(
    /_\{([^{}]+)\}|_([A-Za-z0-9+\-=()])/g,
    (_match, braced: string | undefined, single: string | undefined) =>
      convertScript(braced ?? single ?? '', SUBSCRIPT),
  );

  output = output.replace(
    COMMAND_REPLACEMENT_REGEX,
    (command) => COMMAND_REPLACEMENTS[command] ?? command,
  );

  return output
    .replace(/\\(?:left|right)\./g, '')
    .replace(/\\left|\\right/g, '')
    .replace(/\\,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
