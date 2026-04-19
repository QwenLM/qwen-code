/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import stringWidth from 'string-width';

export type InlineMathSegment =
  | { type: 'text'; text: string }
  | { type: 'math'; text: string; raw: string };

interface MathBox {
  lines: string[];
  baseline: number;
  inline: string;
  kind?: 'largeOperator';
}

const SYMBOLS: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  varpi: 'ϖ',
  rho: 'ρ',
  varrho: 'ϱ',
  sigma: 'σ',
  varsigma: 'ς',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'ϕ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
  partial: '∂',
  nabla: '∇',
  infty: '∞',
  ell: 'ℓ',
  hbar: 'ℏ',
  imath: 'ı',
  jmath: 'ȷ',
  Re: 'ℜ',
  Im: 'ℑ',
  wp: '℘',
  emptyset: '∅',
  varnothing: '∅',
  forall: '∀',
  exists: '∃',
  nexists: '∄',
  neg: '¬',
  lnot: '¬',
  land: '∧',
  wedge: '∧',
  lor: '∨',
  vee: '∨',
  top: '⊤',
  bot: '⊥',
  in: '∈',
  notin: '∉',
  ni: '∋',
  subset: '⊂',
  supset: '⊃',
  subseteq: '⊆',
  supseteq: '⊇',
  nsubseteq: '⊄',
  nsupseteq: '⊅',
  cup: '∪',
  cap: '∩',
  setminus: '∖',
  smallsetminus: '∖',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  neq: '≠',
  ne: '≠',
  equiv: '≡',
  sim: '∼',
  simeq: '≃',
  approx: '≈',
  cong: '≅',
  propto: '∝',
  ll: '≪',
  gg: '≫',
  prec: '≺',
  succ: '≻',
  preceq: '≼',
  succeq: '≽',
  times: '×',
  div: '÷',
  cdot: '⋅',
  cdots: '⋯',
  ldots: '…',
  dots: '…',
  vdots: '⋮',
  ddots: '⋱',
  pm: '±',
  mp: '∓',
  ast: '∗',
  star: '⋆',
  circ: '∘',
  bullet: '•',
  opulus: '⊕',
  oplus: '⊕',
  otimes: '⊗',
  oslash: '⊘',
  odot: '⊙',
  sum: '∑',
  prod: '∏',
  coprod: '∐',
  int: '∫',
  iint: '∬',
  iiint: '∭',
  oint: '∮',
  lim: 'lim',
  limsup: 'lim sup',
  liminf: 'lim inf',
  min: 'min',
  max: 'max',
  sup: 'sup',
  inf: 'inf',
  sin: 'sin',
  cos: 'cos',
  tan: 'tan',
  cot: 'cot',
  sec: 'sec',
  csc: 'csc',
  sinh: 'sinh',
  cosh: 'cosh',
  tanh: 'tanh',
  log: 'log',
  ln: 'ln',
  exp: 'exp',
  det: 'det',
  dim: 'dim',
  ker: 'ker',
  deg: 'deg',
  mod: 'mod',
  gcd: 'gcd',
  Pr: 'Pr',
  to: '→',
  gets: '←',
  mapsto: '↦',
  rightarrow: '→',
  leftarrow: '←',
  leftrightarrow: '↔',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  Leftrightarrow: '⇔',
  longrightarrow: '⟶',
  longleftarrow: '⟵',
  Longrightarrow: '⟹',
  Longleftarrow: '⟸',
  hookrightarrow: '↪',
  hookleftarrow: '↩',
  uparrow: '↑',
  downarrow: '↓',
  updownarrow: '↕',
  Uparrow: '⇑',
  Downarrow: '⇓',
  Updownarrow: '⇕',
  langle: '⟨',
  rangle: '⟩',
  lceil: '⌈',
  rceil: '⌉',
  lfloor: '⌊',
  rfloor: '⌋',
  lbrace: '{',
  rbrace: '}',
  vert: '|',
  Vert: '‖',
  backslash: '\\',
};

const LARGE_OPERATORS = new Set([
  'sum',
  'prod',
  'coprod',
  'int',
  'iint',
  'iiint',
  'oint',
  'lim',
  'limsup',
  'liminf',
  'min',
  'max',
  'sup',
  'inf',
]);

const SPACING_COMMANDS: Record<string, string> = {
  ',': ' ',
  ':': ' ',
  ';': ' ',
  ' ': ' ',
  quad: '    ',
  qquad: '        ',
  enspace: ' ',
  thinspace: ' ',
  medspace: ' ',
  thickspace: ' ',
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
  a: 'ᵃ',
  b: 'ᵇ',
  c: 'ᶜ',
  d: 'ᵈ',
  e: 'ᵉ',
  f: 'ᶠ',
  g: 'ᵍ',
  h: 'ʰ',
  j: 'ʲ',
  k: 'ᵏ',
  l: 'ˡ',
  m: 'ᵐ',
  o: 'ᵒ',
  p: 'ᵖ',
  r: 'ʳ',
  s: 'ˢ',
  t: 'ᵗ',
  u: 'ᵘ',
  v: 'ᵛ',
  w: 'ʷ',
  x: 'ˣ',
  y: 'ʸ',
  z: 'ᶻ',
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

const DELIMITER_MAP: Record<string, string> = {
  '.': '',
  '\\{': '{',
  '\\}': '}',
  '\\lbrace': '{',
  '\\rbrace': '}',
  '\\langle': '⟨',
  '\\rangle': '⟩',
  '\\lceil': '⌈',
  '\\rceil': '⌉',
  '\\lfloor': '⌊',
  '\\rfloor': '⌋',
  '\\vert': '|',
  '\\Vert': '‖',
};

function visibleWidth(text: string): number {
  return stringWidth(text);
}

function spaces(width: number): string {
  return ' '.repeat(Math.max(0, width));
}

function textBox(text: string, kind?: MathBox['kind']): MathBox {
  return { lines: [text], baseline: 0, inline: text, kind };
}

function emptyBox(): MathBox {
  return textBox('');
}

function boxWidth(box: MathBox): number {
  return box.lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}

function padRight(line: string, width: number): string {
  return line + spaces(width - visibleWidth(line));
}

function centerLine(line: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(line));
  const left = Math.floor(padding / 2);
  return spaces(left) + line + spaces(padding - left);
}

function hJoin(boxes: MathBox[], gap = ''): MathBox {
  const visibleBoxes = boxes.filter((box) => box.lines.length > 0);
  if (visibleBoxes.length === 0) return emptyBox();

  const baseline = Math.max(...visibleBoxes.map((box) => box.baseline));
  const below = Math.max(
    ...visibleBoxes.map((box) => box.lines.length - box.baseline - 1),
  );
  const height = baseline + below + 1;
  const widths = visibleBoxes.map((box) => boxWidth(box));
  const lines: string[] = [];

  for (let row = 0; row < height; row++) {
    const pieces = visibleBoxes.map((box, index) => {
      const boxRow = row - (baseline - box.baseline);
      if (boxRow < 0 || boxRow >= box.lines.length) {
        return spaces(widths[index]!);
      }
      return padRight(box.lines[boxRow]!, widths[index]!);
    });
    lines.push(pieces.join(gap));
  }

  return {
    lines,
    baseline,
    inline: visibleBoxes.map((box) => box.inline).join(gap),
  };
}

function vStack(boxes: MathBox[]): MathBox {
  const lines = boxes.flatMap((box) => box.lines);
  if (lines.length === 0) return emptyBox();
  return {
    lines,
    baseline: Math.floor(lines.length / 2),
    inline: boxes.map((box) => box.inline).join('; '),
  };
}

function fractionBox(numerator: MathBox, denominator: MathBox): MathBox {
  const width = Math.max(boxWidth(numerator), boxWidth(denominator), 1);
  const bar = '─'.repeat(width);
  return {
    lines: [
      ...numerator.lines.map((line) => centerLine(line, width)),
      bar,
      ...denominator.lines.map((line) => centerLine(line, width)),
    ],
    baseline: numerator.lines.length,
    inline: `(${numerator.inline})/(${denominator.inline})`,
  };
}

function sqrtBox(radical: MathBox, degree?: MathBox): MathBox {
  const degreeText = degree?.inline ?? '';
  const prefix = degreeText
    ? `${toSuperscript(degreeText) ?? degreeText}√`
    : '√';
  const box = hJoin([textBox(prefix), wrapFence(radical, '(', ')')]);
  return { ...box, inline: `${prefix}(${radical.inline})` };
}

function applyOverline(box: MathBox): MathBox {
  const width = Math.max(boxWidth(box), 1);
  return {
    lines: [
      '─'.repeat(width),
      ...box.lines.map((line) => centerLine(line, width)),
    ],
    baseline: box.baseline + 1,
    inline: `${box.inline}\u0304`,
  };
}

function applyAccent(command: string, box: MathBox): MathBox {
  const combining: Record<string, string> = {
    hat: '\u0302',
    widehat: '\u0302',
    bar: '\u0304',
    vec: '\u20d7',
    dot: '\u0307',
    ddot: '\u0308',
    tilde: '\u0303',
    widetilde: '\u0303',
  };
  const mark = combining[command];
  if (!mark) return box;
  const accented = box.inline + mark;
  return textBox(accented);
}

function toScript(text: string, map: Record<string, string>): string | null {
  const normalized = text.replace(/\s+/g, '');
  if (!normalized) return '';
  let result = '';
  for (const char of normalized) {
    const mapped = map[char];
    if (mapped === undefined) return null;
    result += mapped;
  }
  return result;
}

function toSuperscript(text: string): string | null {
  return toScript(text, SUPERSCRIPT);
}

function toSubscript(text: string): string | null {
  return toScript(text, SUBSCRIPT);
}

function applyScripts(base: MathBox, sub?: MathBox, sup?: MathBox): MathBox {
  const subText = sub?.inline;
  const supText = sup?.inline;
  const compactSup = supText === undefined ? '' : toSuperscript(supText);
  const compactSub = subText === undefined ? '' : toSubscript(subText);

  if (
    base.kind !== 'largeOperator' &&
    base.lines.length === 1 &&
    (supText === undefined || compactSup !== null) &&
    (subText === undefined || compactSub !== null)
  ) {
    return textBox(`${base.inline}${compactSub ?? ''}${compactSup ?? ''}`);
  }

  if (base.kind === 'largeOperator') {
    const scriptBoxes = [
      sup ? textBox(sup.inline) : undefined,
      base,
      sub ? textBox(sub.inline) : undefined,
    ].filter((box): box is MathBox => box !== undefined);
    const width = Math.max(...scriptBoxes.map((box) => boxWidth(box)), 1);
    const lines = [
      ...(sup ? [centerLine(sup.inline, width)] : []),
      ...base.lines.map((line) => centerLine(line, width)),
      ...(sub ? [centerLine(sub.inline, width)] : []),
    ];
    return {
      lines,
      baseline: sup ? base.baseline + 1 : base.baseline,
      inline: `${base.inline}${subText ? `_${subText}` : ''}${
        supText ? `^${supText}` : ''
      }`,
      kind: base.kind,
    };
  }

  const suffix = `${subText ? `_{${subText}}` : ''}${
    supText ? `^{${supText}}` : ''
  }`;
  return textBox(`${base.inline}${suffix}`);
}

function fenceGlyphs(
  delimiter: string,
  height: number,
  side: 'left' | 'right',
): string[] {
  if (height <= 1) return [delimiter];
  const table: Record<string, [string, string, string]> = {
    '(': side === 'left' ? ['⎛', '⎜', '⎝'] : ['⎞', '⎟', '⎠'],
    ')': side === 'left' ? ['⎛', '⎜', '⎝'] : ['⎞', '⎟', '⎠'],
    '[': side === 'left' ? ['⎡', '⎢', '⎣'] : ['⎤', '⎥', '⎦'],
    ']': side === 'left' ? ['⎡', '⎢', '⎣'] : ['⎤', '⎥', '⎦'],
    '{': side === 'left' ? ['⎧', '⎨', '⎩'] : ['⎫', '⎬', '⎭'],
    '}': side === 'left' ? ['⎧', '⎨', '⎩'] : ['⎫', '⎬', '⎭'],
    '|': ['│', '│', '│'],
    '‖': ['║', '║', '║'],
  };
  const glyphs = table[delimiter];
  if (!glyphs) return Array.from({ length: height }, () => delimiter);
  return Array.from({ length: height }, (_, index) => {
    if (index === 0) return glyphs[0];
    if (index === height - 1) return glyphs[2];
    return glyphs[1];
  });
}

function wrapFence(box: MathBox, left: string, right: string): MathBox {
  if (!left && !right) return box;
  const width = boxWidth(box);
  const leftGlyphs = left ? fenceGlyphs(left, box.lines.length, 'left') : [];
  const rightGlyphs = right
    ? fenceGlyphs(right, box.lines.length, 'right')
    : [];
  const lines = box.lines.map((line, index) => {
    const leftPart = left ? `${leftGlyphs[index]} ` : '';
    const rightPart = right ? ` ${rightGlyphs[index]}` : '';
    return `${leftPart}${padRight(line, width)}${rightPart}`;
  });
  return {
    lines,
    baseline: box.baseline,
    inline: `${left}${box.inline}${right}`,
  };
}

function readBalanced(
  input: string,
  start: number,
  open: string,
  close: string,
): { content: string; end: number } | null {
  if (input[start] !== open) return null;
  let depth = 1;
  for (let index = start + 1; index < input.length; index++) {
    const char = input[index]!;
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === open) depth++;
    if (char === close) depth--;
    if (depth === 0) {
      return { content: input.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

function splitRows(input: string): string[] {
  const rows: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let bracketDepth = 0;

  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (char === '\\') {
      if (input[index + 1] === '\\' && braceDepth === 0 && bracketDepth === 0) {
        rows.push(input.slice(start, index));
        index++;
        start = index + 1;
      } else {
        index++;
      }
      continue;
    }
    if (char === '{') braceDepth++;
    if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    if (char === '[') bracketDepth++;
    if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
  }
  rows.push(input.slice(start));
  return rows;
}

function splitCells(input: string): string[] {
  const cells: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let bracketDepth = 0;

  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '{') braceDepth++;
    if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    if (char === '[') bracketDepth++;
    if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    if (char === '&' && braceDepth === 0 && bracketDepth === 0) {
      cells.push(input.slice(start, index));
      start = index + 1;
    }
  }
  cells.push(input.slice(start));
  return cells;
}

function padBox(box: MathBox, width: number): MathBox {
  return {
    ...box,
    lines: box.lines.map((line) => padRight(line, width)),
  };
}

function renderEnvironment(name: string, rawContent: string): MathBox {
  const normalizedName = name.replace(/\*$/, '');
  const rows = splitRows(rawContent)
    .map((row) => row.trim())
    .filter((row) => row.length > 0);

  if (rows.length === 0) return emptyBox();

  if (normalizedName === 'cases') {
    const rowBoxes = rows.map((row) => {
      const cells = splitCells(row).map((cell) => renderMathToBox(cell));
      return hJoin(cells, '  ');
    });
    return wrapFence(vStack(rowBoxes), '{', '');
  }

  const cellRows = rows.map((row) =>
    splitCells(row).map((cell) => renderMathToBox(cell.trim())),
  );
  const columnCount = Math.max(...cellRows.map((row) => row.length));
  const columnWidths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(
      ...cellRows.map((row) => (row[column] ? boxWidth(row[column]) : 0)),
      0,
    ),
  );
  const rowBoxes = cellRows.map((row) =>
    hJoin(
      Array.from({ length: columnCount }, (_, column) =>
        padBox(row[column] ?? emptyBox(), columnWidths[column]!),
      ),
      '  ',
    ),
  );
  let body = vStack(rowBoxes);

  const fences: Record<string, [string, string]> = {
    pmatrix: ['(', ')'],
    bmatrix: ['[', ']'],
    Bmatrix: ['{', '}'],
    vmatrix: ['|', '|'],
    Vmatrix: ['‖', '‖'],
  };
  const fence = fences[normalizedName];
  if (fence) body = wrapFence(body, fence[0], fence[1]);

  return body;
}

class TeXParser {
  private position = 0;

  constructor(private readonly input: string) {}

  parse(): MathBox {
    return this.parseSequence();
  }

  private parseSequence(stopChar?: string): MathBox {
    const boxes: MathBox[] = [];
    let lastWasSpace = false;

    while (this.position < this.input.length) {
      const char = this.input[this.position]!;
      if (stopChar && char === stopChar) break;

      if (/\s/.test(char)) {
        this.position++;
        if (!lastWasSpace && boxes.length > 0) {
          boxes.push(textBox(' '));
          lastWasSpace = true;
        }
        continue;
      }

      boxes.push(this.parseAtomWithScripts());
      lastWasSpace = false;
    }

    return hJoin(boxes);
  }

  private parseAtomWithScripts(): MathBox {
    let base = this.parseAtom();
    let sub: MathBox | undefined;
    let sup: MathBox | undefined;

    while (this.position < this.input.length) {
      const char = this.input[this.position]!;
      if (char !== '_' && char !== '^') break;
      this.position++;
      const script = this.parseScriptArgument();
      if (char === '_') {
        sub = script;
      } else {
        sup = script;
      }
    }

    if (sub || sup) {
      base = applyScripts(base, sub, sup);
    }
    return base;
  }

  private parseAtom(): MathBox {
    if (this.position >= this.input.length) return emptyBox();

    const char = this.input[this.position]!;
    if (char === '{') {
      this.position++;
      const group = this.parseSequence('}');
      if (this.input[this.position] === '}') this.position++;
      return group;
    }
    if (char === '\\') {
      return this.parseCommand();
    }
    if (char === '^' || char === '_') {
      this.position++;
      return textBox(char);
    }

    this.position++;
    return textBox(char);
  }

  private parseCommand(): MathBox {
    this.position++;
    if (this.position >= this.input.length) return textBox('\\');

    const commandStart = this.position;
    let command = '';
    if (/[A-Za-z]/.test(this.input[this.position]!)) {
      while (
        this.position < this.input.length &&
        /[A-Za-z]/.test(this.input[this.position]!)
      ) {
        this.position++;
      }
      command = this.input.slice(commandStart, this.position);
      if (this.input[this.position] === '*') {
        command += '*';
        this.position++;
      }
    } else {
      command = this.input[this.position]!;
      this.position++;
    }

    const spacing = SPACING_COMMANDS[command];
    if (spacing !== undefined) return textBox(spacing);

    switch (command) {
      case '!':
      case 'displaystyle':
      case 'textstyle':
      case 'scriptstyle':
      case 'scriptscriptstyle':
      case 'nonumber':
      case 'notag':
        return emptyBox();
      case 'frac':
      case 'dfrac':
      case 'tfrac':
      case 'binom': {
        const numerator = this.parseRequiredArgument();
        const denominator = this.parseRequiredArgument();
        const fraction = fractionBox(numerator, denominator);
        return command === 'binom' ? wrapFence(fraction, '(', ')') : fraction;
      }
      case 'sqrt': {
        const degree = this.parseOptionalBracketArgument();
        const radical = this.parseRequiredArgument();
        return sqrtBox(radical, degree);
      }
      case 'text':
      case 'textrm':
      case 'mathrm':
      case 'mathbf':
      case 'mathit':
      case 'operatorname':
        return textBox(this.readRequiredGroupText());
      case 'overline':
        return applyOverline(this.parseRequiredArgument());
      case 'underline':
        return this.parseRequiredArgument();
      case 'hat':
      case 'widehat':
      case 'bar':
      case 'vec':
      case 'dot':
      case 'ddot':
      case 'tilde':
      case 'widetilde':
        return applyAccent(command, this.parseRequiredArgument());
      case 'left':
      case 'right':
        return textBox(this.readDelimiter());
      case 'begin': {
        const environmentName = this.readRequiredGroupText();
        const content = this.readEnvironmentContent(environmentName);
        return renderEnvironment(environmentName, content);
      }
      default:
        break;
    }

    const symbol = SYMBOLS[command];
    if (symbol !== undefined) {
      return textBox(
        symbol,
        LARGE_OPERATORS.has(command) ? 'largeOperator' : undefined,
      );
    }

    return textBox(command.length === 1 ? command : `\\${command}`);
  }

  private parseScriptArgument(): MathBox {
    this.skipSpaces();
    if (this.position >= this.input.length) return emptyBox();
    if (this.input[this.position] === '{') {
      return this.parseAtom();
    }
    if (this.input[this.position] === '\\') {
      return this.parseCommand();
    }
    const char = this.input[this.position]!;
    this.position++;
    return textBox(char);
  }

  private parseRequiredArgument(): MathBox {
    this.skipSpaces();
    if (this.position >= this.input.length) return emptyBox();
    return this.parseAtom();
  }

  private parseOptionalBracketArgument(): MathBox | undefined {
    this.skipSpaces();
    if (this.input[this.position] !== '[') return undefined;
    const result = readBalanced(this.input, this.position, '[', ']');
    if (!result) return undefined;
    this.position = result.end;
    return renderMathToBox(result.content);
  }

  private readRequiredGroupText(): string {
    this.skipSpaces();
    const result = readBalanced(this.input, this.position, '{', '}');
    if (!result) return '';
    this.position = result.end;
    return result.content;
  }

  private readEnvironmentContent(environmentName: string): string {
    const endToken = `\\end{${environmentName}}`;
    const end = this.input.indexOf(endToken, this.position);
    if (end === -1) {
      const content = this.input.slice(this.position);
      this.position = this.input.length;
      return content;
    }
    const content = this.input.slice(this.position, end);
    this.position = end + endToken.length;
    return content;
  }

  private readDelimiter(): string {
    this.skipSpaces();
    if (this.position >= this.input.length) return '';

    if (this.input[this.position] === '\\') {
      const start = this.position;
      this.position++;
      while (
        this.position < this.input.length &&
        /[A-Za-z]/.test(this.input[this.position]!)
      ) {
        this.position++;
      }
      if (this.position === start + 1 && this.position < this.input.length) {
        this.position++;
      }
      const raw = this.input.slice(start, this.position);
      return DELIMITER_MAP[raw] ?? SYMBOLS[raw.slice(1)] ?? raw.slice(1);
    }

    const delimiter = this.input[this.position]!;
    this.position++;
    return DELIMITER_MAP[delimiter] ?? delimiter;
  }

  private skipSpaces(): void {
    while (
      this.position < this.input.length &&
      /\s/.test(this.input[this.position]!)
    ) {
      this.position++;
    }
  }
}

function renderMathToBox(source: string): MathBox {
  return new TeXParser(source.trim()).parse();
}

export function renderTerminalMathInline(source: string): string {
  return renderMathToBox(source).inline.replace(/\s+/g, ' ').trim();
}

export function renderTerminalMathBlock(source: string): string[] {
  const box = renderMathToBox(source);
  return box.lines.length > 0 ? box.lines : [''];
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function isProbablyMath(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed || trimmed !== content) return false;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return false;
  if (/^[A-Z_][A-Z0-9_]*$/.test(trimmed)) return false;
  return /\\|[\^_{}=+\-*/<>]|[α-ωΑ-Ω∂∑∫∞≤≥≈≠]/u.test(trimmed);
}

function findClosingDollar(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    if (text[index] !== '$' || isEscaped(text, index)) continue;
    if (text[index + 1] === '$') continue;
    return index;
  }
  return -1;
}

export function splitInlineMathSegments(text: string): InlineMathSegment[] {
  const segments: InlineMathSegment[] = [];
  let cursor = 0;

  const pushText = (value: string) => {
    if (!value) return;
    const previous = segments[segments.length - 1];
    if (previous?.type === 'text') {
      previous.text += value;
    } else {
      segments.push({ type: 'text', text: value });
    }
  };

  while (cursor < text.length) {
    const dollarIndex = text.indexOf('$', cursor);
    const parenIndex = text.indexOf('\\(', cursor);
    const nextCandidates = [dollarIndex, parenIndex].filter(
      (index) => index >= 0,
    );
    if (nextCandidates.length === 0) {
      pushText(text.slice(cursor));
      break;
    }

    const start = Math.min(...nextCandidates);
    if (start > cursor) pushText(text.slice(cursor, start));

    if (text.startsWith('\\(', start) && !isEscaped(text, start)) {
      const end = text.indexOf('\\)', start + 2);
      if (end >= 0) {
        const content = text.slice(start + 2, end);
        if (isProbablyMath(content)) {
          segments.push({
            type: 'math',
            text: content,
            raw: text.slice(start, end + 2),
          });
        } else {
          pushText(text.slice(start, end + 2));
        }
        cursor = end + 2;
        continue;
      }
    }

    if (
      text[start] === '$' &&
      !isEscaped(text, start) &&
      text[start + 1] !== '$'
    ) {
      const end = findClosingDollar(text, start + 1);
      if (end >= 0) {
        const content = text.slice(start + 1, end);
        if (isProbablyMath(content)) {
          segments.push({
            type: 'math',
            text: content,
            raw: text.slice(start, end + 1),
          });
        } else {
          pushText(text.slice(start, end + 1));
        }
        cursor = end + 1;
        continue;
      }
    }

    pushText(text[start]!);
    cursor = start + 1;
  }

  return segments;
}

export function renderInlineMathInText(text: string): string {
  return splitInlineMathSegments(text)
    .map((segment) =>
      segment.type === 'math'
        ? renderTerminalMathInline(segment.text)
        : segment.text,
    )
    .join('');
}
