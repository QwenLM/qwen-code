import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const TOP_LEVEL_KEYS = new Set([
  'id',
  'description',
  'terminal',
  'timeoutMs',
  'input',
  'env',
  'commands',
  'compareParams',
  'thresholds',
  'expectBaseFailure',
  'proves',
  'doesNotProve',
]);
const INTEGER_THRESHOLD_KEYS = [
  'maxFullScreenClears',
  'maxPartialScreenErases',
  'maxLineErases',
  'maxDuplicateEvents',
  'maxDec2026Unbalanced',
];
const BOOLEAN_THRESHOLD_KEYS = [
  'requireSync',
  'requireEventMarkers',
  'requireExitCodeZero',
];
const SIDE_OBJECT_KEYS = new Set(['argv', 'pty']);
const SIDE_PTY_MODES = new Set(['fixture', 'wrapped']);
const SHARED_SCENARIO_KEYS = new Set([
  'id',
  'description',
  'terminal',
  'timeoutMs',
  'input',
  'env',
  'commands',
  'compareParams',
  'thresholds',
  'proves',
  'doesNotProve',
]);
const COMPARE_PARAM_RE = /^--[A-Za-z0-9][A-Za-z0-9-]*$/;
const TERMINAL_PARAM_TO_DIMENSION = {
  '--rows': 'rows',
  '--lines': 'rows',
  '--columns': 'columns',
  '--cols': 'columns',
};

export function extractFlagValues(argv, flag) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === flag) {
      values.push(argv[i + 1] ?? '');
      i += 1;
    } else if (typeof token === 'string' && token.startsWith(`${flag}=`)) {
      values.push(token.slice(flag.length + 1));
    }
  }
  return values;
}

export function validateCompareParams(
  compareParams,
  base,
  fixed,
  terminal,
  problems,
) {
  for (const flag of compareParams) {
    const baseValues = extractFlagValues(base.argv, flag);
    const fixedValues = extractFlagValues(fixed.argv, flag);
    if (baseValues.length === 0 && fixedValues.length === 0) {
      problems.push(
        `compareParams: "${flag}" is missing from commands.base and commands.fixed`,
      );
      continue;
    }
    if (baseValues.length === 0) {
      problems.push(`compareParams: "${flag}" is missing from commands.base`);
      continue;
    }
    if (fixedValues.length === 0) {
      problems.push(`compareParams: "${flag}" is missing from commands.fixed`);
      continue;
    }
    if (JSON.stringify(baseValues) !== JSON.stringify(fixedValues)) {
      problems.push(
        `compareParams: "${flag}" differs between base (${baseValues.join(', ')}) ` +
          `and fixed (${fixedValues.join(', ')}); declared comparison ` +
          'parameters must be equal on both sides',
      );
      continue;
    }
    const dimension = TERMINAL_PARAM_TO_DIMENSION[flag];
    if (dimension) {
      for (const value of baseValues) {
        if (
          !/^\d+$/.test(value) ||
          Number.parseInt(value, 10) !== terminal[dimension]
        ) {
          problems.push(
            `compareParams: "${flag}" value "${value}" does not match ` +
              `terminal.${dimension} (${terminal[dimension]})`,
          );
          break;
        }
      }
    }
  }
}

// Checks only the terminal-size flags present in argv, independent of
// compareParams. Used to bind override-supplied argv to the capture geometry.
export function validateTerminalFlags(argv, terminal, label, problems) {
  for (const [flag, dimension] of Object.entries(TERMINAL_PARAM_TO_DIMENSION)) {
    for (const value of extractFlagValues(argv, flag)) {
      if (
        !/^\d+$/.test(value) ||
        Number.parseInt(value, 10) !== terminal[dimension]
      ) {
        problems.push(
          `${label}: "${flag}" value "${value}" does not match ` +
            `terminal.${dimension} (${terminal[dimension]})`,
        );
        break;
      }
    }
  }
}

export function parseSideCommand(name, raw, problems) {
  if (raw === undefined) {
    problems.push(`commands.${name} is required`);
    return null;
  }
  if (Array.isArray(raw)) {
    if (
      raw.length === 0 ||
      !raw.every((part) => typeof part === 'string' && part.length > 0)
    ) {
      problems.push(
        `commands.${name} must be a non-empty array of non-empty strings`,
      );
      return null;
    }
    return { argv: raw, pty: 'native' };
  }
  if (typeof raw === 'object' && raw !== null) {
    for (const key of Object.keys(raw)) {
      if (SIDE_OBJECT_KEYS.has(key)) continue;
      if (SHARED_SCENARIO_KEYS.has(key)) {
        problems.push(
          `commands.${name} may not define "${key}": ` +
            'base and fixed share all scenario parameters',
        );
      } else {
        problems.push(`unknown commands.${name} key "${key}"`);
      }
    }
    const argv = raw.argv;
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((part) => typeof part === 'string' && part.length > 0)
    ) {
      problems.push(
        `commands.${name}.argv must be a non-empty array of non-empty strings`,
      );
      return null;
    }
    let pty = 'native';
    if (raw.pty !== undefined) {
      if (!SIDE_PTY_MODES.has(raw.pty)) {
        problems.push(
          `commands.${name}.pty must be "fixture" or "wrapped" ` +
            '(plain argv arrays always capture through a native PTY)',
        );
      } else {
        pty = raw.pty;
      }
    }
    return { argv, pty };
  }
  problems.push(
    `commands.${name} must be an argv array or an object with "argv" and optional "pty"`,
  );
  return null;
}

export function validateScenario(input, label = 'scenario') {
  const problems = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`scenario ${label}: must be a JSON object`);
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      problems.push(`unknown top-level key "${key}"`);
    }
  }
  if (typeof input.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(input.id)) {
    problems.push('id must be a kebab-case string ([a-z0-9-])');
  }
  if (typeof input.description !== 'string' || input.description.length === 0) {
    problems.push('description is required');
  }
  if (typeof input.proves !== 'string' || input.proves.length === 0) {
    problems.push('proves is required (what this scenario proves)');
  }
  if (
    typeof input.doesNotProve !== 'string' ||
    input.doesNotProve.length === 0
  ) {
    problems.push(
      'doesNotProve is required (what this scenario does not prove)',
    );
  }

  const terminal = input.terminal;
  let rows = 24;
  let columns = 80;
  if (typeof terminal !== 'object' || terminal === null) {
    problems.push('terminal with rows and columns is required');
  } else {
    for (const key of Object.keys(terminal)) {
      if (key !== 'rows' && key !== 'columns')
        problems.push(`unknown terminal key "${key}"`);
    }
    if (
      !Number.isInteger(terminal.rows) ||
      terminal.rows < 1 ||
      terminal.rows > 1000
    ) {
      problems.push('terminal.rows must be an integer in 1..1000');
    } else rows = terminal.rows;
    if (
      !Number.isInteger(terminal.columns) ||
      terminal.columns < 1 ||
      terminal.columns > 1000
    ) {
      problems.push('terminal.columns must be an integer in 1..1000');
    } else columns = terminal.columns;
  }

  let timeoutMs = 10000;
  if (input.timeoutMs !== undefined) {
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      problems.push('timeoutMs must be a positive integer');
    } else timeoutMs = input.timeoutMs;
  }

  let scenarioInput = [];
  if (input.input !== undefined) {
    if (!Array.isArray(input.input)) problems.push('input must be an array');
    else {
      scenarioInput = input.input;
      input.input.forEach((step, index) => {
        if (typeof step !== 'object' || step === null) {
          problems.push(`input[${index}] must be an object`);
          return;
        }
        if (typeof step.data !== 'string') {
          problems.push(`input[${index}].data must be a string`);
        }
        if (
          step.delayMs !== undefined &&
          (!Number.isInteger(step.delayMs) || step.delayMs < 0)
        ) {
          problems.push(`input[${index}].delayMs must be an integer >= 0`);
        }
      });
    }
  }

  let env = {};
  if (input.env !== undefined) {
    if (typeof input.env !== 'object' || input.env === null) {
      problems.push('env must be an object of strings');
    } else {
      env = input.env;
      for (const [key, value] of Object.entries(input.env)) {
        if (typeof value !== 'string')
          problems.push(`env.${key} must be a string`);
      }
    }
  }

  let commands = { base: null, fixed: null };
  if (typeof input.commands !== 'object' || input.commands === null) {
    problems.push('commands with base and fixed argv is required');
  } else {
    for (const key of Object.keys(input.commands)) {
      if (key !== 'base' && key !== 'fixed')
        problems.push(`unknown commands key "${key}"`);
    }
    commands = {
      base: parseSideCommand('base', input.commands.base, problems),
      fixed: parseSideCommand('fixed', input.commands.fixed, problems),
    };
  }

  let compareParams = [];
  if (input.compareParams !== undefined) {
    if (!Array.isArray(input.compareParams)) {
      problems.push('compareParams must be an array of "--flag" strings');
    } else {
      compareParams = input.compareParams;
      for (const flag of compareParams) {
        if (typeof flag !== 'string' || !COMPARE_PARAM_RE.test(flag)) {
          problems.push(
            `compareParams entries must be strings matching --<flag> (got ${JSON.stringify(flag)})`,
          );
        }
      }
    }
  }
  if (
    commands.base &&
    commands.fixed &&
    compareParams.length > 0 &&
    compareParams.every(
      (flag) => typeof flag === 'string' && COMPARE_PARAM_RE.test(flag),
    )
  ) {
    validateCompareParams(
      compareParams,
      commands.base,
      commands.fixed,
      { rows, columns },
      problems,
    );
  }

  let thresholds = {};
  if (input.thresholds !== undefined) {
    if (typeof input.thresholds !== 'object' || input.thresholds === null) {
      problems.push('thresholds must be an object');
    } else {
      thresholds = input.thresholds;
      for (const [key, value] of Object.entries(input.thresholds)) {
        if (INTEGER_THRESHOLD_KEYS.includes(key)) {
          if (!Number.isInteger(value) || value < 0) {
            problems.push(`thresholds.${key} must be an integer >= 0`);
          }
        } else if (BOOLEAN_THRESHOLD_KEYS.includes(key)) {
          if (typeof value !== 'boolean') {
            problems.push(`thresholds.${key} must be a boolean`);
          }
        } else {
          problems.push(`unknown thresholds key "${key}"`);
        }
      }
    }
  }

  let expectBaseFailure = false;
  if (input.expectBaseFailure !== undefined) {
    if (typeof input.expectBaseFailure !== 'boolean') {
      problems.push('expectBaseFailure must be a boolean');
    } else {
      expectBaseFailure = input.expectBaseFailure;
    }
  }

  if (problems.length > 0) {
    throw new Error(`scenario ${label}: ${problems.join('; ')}`);
  }
  return {
    id: input.id,
    description: input.description,
    terminal: { rows, columns },
    timeoutMs,
    input: scenarioInput,
    env,
    commands,
    compareParams,
    thresholds,
    expectBaseFailure,
    proves: input.proves,
    doesNotProve: input.doesNotProve,
  };
}

export async function loadScenarioFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`scenario ${file}: ${err.message}`);
  }
  return validateScenario(parsed, file);
}

export async function loadScenarios(paths) {
  const loaded = [];
  for (const p of paths) {
    const info = await stat(p);
    if (info.isDirectory()) {
      const entries = (await readdir(p))
        .filter((name) => name.endsWith('.scenario.json'))
        .sort();
      if (entries.length === 0) {
        throw new Error(`no *.scenario.json files found in ${p}`);
      }
      for (const name of entries) {
        const file = join(p, name);
        loaded.push({ file, scenario: await loadScenarioFile(file) });
      }
    } else {
      loaded.push({ file: p, scenario: await loadScenarioFile(p) });
    }
  }
  return loaded;
}
