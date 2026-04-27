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
  '\\theta': 'θ',
  '\\lambda': 'λ',
  '\\mu': 'μ',
  '\\pi': 'π',
  '\\rho': 'ρ',
  '\\sigma': 'σ',
  '\\tau': 'τ',
  '\\phi': 'φ',
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
  '\\leftarrow': '←',
  '\\Rightarrow': '⇒',
  '\\Leftarrow': '⇐',
};

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

export function renderInlineLatex(input: string): string {
  let output = input.trim();

  output = output.replace(
    /\\frac\{([^{}]+)\}\{([^{}]+)\}/g,
    (_match, numerator: string, denominator: string) =>
      `${renderInlineLatex(numerator)}/${renderInlineLatex(denominator)}`,
  );

  output = output.replace(
    /\\sqrt\{([^{}]+)\}/g,
    (_match, radicand: string) => `√(${renderInlineLatex(radicand)})`,
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

  for (const [command, replacement] of Object.entries(COMMAND_REPLACEMENTS)) {
    output = output.split(command).join(replacement);
  }

  return output
    .replace(/\\left|\\right/g, '')
    .replace(/\\,/g, ' ')
    .replace(/\\([A-Za-z]+)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
