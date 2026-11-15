/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import { UiRuntime } from './app/runtime.js';
import type { InputValues, UiPatch } from './app/runtime-contract.js';
import type { ShowInput } from './contracts.js';

const INPUT_TYPES = new Set(['text', 'number', 'range', 'checkbox', 'radio']);
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE =
  /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

let modulePromise: Promise<QuickJSWASMModule> | undefined;

function decode(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    if (!result.has(name))
      result.set(name, decode(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return result;
}

function rangeDefault(attrs: Map<string, string>): string {
  const min = Number(attrs.get('min') ?? 0);
  const max = Number(attrs.get('max') ?? 100);
  const low = Number.isFinite(min) ? min : 0;
  const high = Number.isFinite(max) && max >= low ? max : Math.max(low, 100);
  return String(low + (high - low) / 2);
}

interface Markup {
  ids: Set<string>;
  controls: Set<string>;
  inputs: InputValues;
  problem?: string;
}

/**
 * Approximates the browser's view of generated markup without a DOM: element
 * IDs, the form controls and their initial values. It flags the markup rules
 * the browser surface enforces, so the model hears about them before display.
 */
export function readMarkup(html: string): Markup {
  const ids = new Set<string>();
  const controls = new Set<string>();
  const inputs: InputValues = {};
  let problem: string | undefined;
  let select: { id: string; first?: string; selected?: string } | undefined;
  let option: { value?: string; selected: boolean; text: string } | undefined;
  let textarea: { id: string; start: number } | undefined;
  const closeOption = () => {
    if (!select || !option) return;
    const value = option.value ?? option.text.trim();
    select.first ??= value;
    if (option.selected) select.selected = value;
    option = undefined;
  };
  for (const match of html.matchAll(TAG)) {
    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    if (textarea) {
      if (closing && tag === 'textarea') {
        inputs[textarea.id] = {
          value: decode(html.slice(textarea.start, match.index)),
          checked: false,
        };
        textarea = undefined;
      }
      continue;
    }
    if (closing) {
      if (tag === 'option') closeOption();
      if (tag === 'select' && select) {
        closeOption();
        inputs[select.id] = {
          value: select.selected ?? select.first ?? '',
          checked: false,
        };
        select = undefined;
      }
      continue;
    }
    const attrs = attributes(match[3]);
    const id = attrs.get('id');
    if (id !== undefined) {
      if (!ID.test(id)) {
        problem ??= `Element ID "${id.slice(0, 64)}" must start with an ASCII letter and use only letters, digits, "_" or "-".`;
      } else if (ids.has(id)) {
        problem ??= `Element ID "${id}" is used more than once.`;
      }
      ids.add(id);
    }
    if (tag === 'option') {
      closeOption();
      option = {
        value: attrs.get('value'),
        selected: attrs.has('selected'),
        text: '',
      };
      const end = (match.index ?? 0) + match[0].length;
      const next = html.indexOf('<', end);
      option.text = decode(html.slice(end, next < 0 ? undefined : next));
      continue;
    }
    if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') continue;
    if (!id) {
      problem ??= `Every <${tag}> needs a unique id.`;
      continue;
    }
    controls.add(id);
    if (tag === 'select') {
      if (attrs.has('multiple'))
        problem ??= `<select id="${id}"> cannot use multiple.`;
      select = { id };
    } else if (tag === 'textarea') {
      textarea = { id, start: (match.index ?? 0) + match[0].length };
    } else {
      const type = (attrs.get('type') ?? 'text').toLowerCase();
      if (!INPUT_TYPES.has(type)) {
        problem ??= `<input id="${id}"> uses unsupported type "${type}"; use text, number, range, checkbox or radio.`;
      }
      const value =
        attrs.get('value') ??
        (type === 'checkbox' || type === 'radio'
          ? 'on'
          : type === 'range'
            ? rangeDefault(attrs)
            : '');
      inputs[id] = { value, checked: attrs.has('checked') };
    }
  }
  return { ids, controls, inputs, problem };
}

function loadModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant).catch(
    (error: unknown) => {
      modulePromise = undefined;
      throw error;
    },
  );
  return modulePromise;
}

function checkPatches(patches: UiPatch[], markup: Markup): string | undefined {
  for (const patch of patches) {
    if (!markup.ids.has(patch.id)) {
      return `The initial calculation updates "#${patch.id}", but no element has that id.`;
    }
    if (patch.kind === 'value' && !markup.controls.has(patch.id)) {
      return `ui.value("${patch.id}", …) targets an element that is not an input, select or textarea.`;
    }
    if (patch.kind === 'html') {
      const inner = readMarkup(patch.value);
      if (inner.problem) return inner.problem;
      for (const id of inner.ids) markup.ids.add(id);
      for (const id of inner.controls) markup.controls.add(id);
    }
  }
  return undefined;
}

/**
 * Runs the generated script's initialization in the same bounded interpreter
 * the view uses, with a stand-in `ui` and the markup's initial input values.
 * Source gets no host access here either. Returns a model-facing problem, or
 * undefined when the view should start. Runtime failures that only appear
 * after user input are not detected.
 */
export async function checkDocument(
  input: ShowInput,
): Promise<string | undefined> {
  const markup = readMarkup(input.html);
  if (markup.problem) return markup.problem;
  let module: QuickJSWASMModule;
  try {
    module = await loadModule();
  } catch {
    // The view runtime still validates at display time.
    return undefined;
  }
  const runtime = new UiRuntime(module);
  try {
    const patches = runtime.initialize(input.javascript, markup.inputs);
    return checkPatches(patches, markup);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    runtime.dispose();
  }
}
