/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CLAUDE_CODE_EVENTS } from './claude-events.js';
import { INVALIDATABLE_EVENTS, TERMINAL_ELEMENTS } from './render-tree.js';
import { MOD_MAX_DEPTH } from './types.js';

// Executed only inside QuickJS. The factory's handles stay private to the host.
export const MOD_GUEST_FACTORY = String.raw`
((bridge, status, identity) => {
  const parse = JSON.parse.bind(JSON);
  const stringify = JSON.stringify.bind(JSON);
  const Depths = Map;
  const { get: depthOf, set: setDepth } = Depths.prototype;
  const apply = Reflect.apply;
  // Stops before nesting deep enough to exhaust the host's native stack. The
  // Map methods are held here so a Mod that patches them cannot turn it off.
  const encode = value => {
    const depths = new Depths();
    return stringify(value, function (key, item) {
      if (item !== null && typeof item === 'object') {
        const depth = (apply(depthOf, depths, [this]) ?? 0) + 1;
        if (depth > ${MOD_MAX_DEPTH}) throw new Error('Mod value nests deeper than ${MOD_MAX_DEPTH} levels.');
        apply(setDepth, depths, [item, depth]);
      }
      return item;
    });
  };
  const keys = Object.keys;
  const freeze = Object.freeze;
  const hasOwn = Object.hasOwn;
  const plugin = freeze(parse(identity));
  const hooks = [];
  const runs = new Map();
  const known = new Set(${JSON.stringify(CLAUDE_CODE_EVENTS)});
  const knownNamespaces = new Set([...known].map(e => e.slice(0, e.indexOf('.'))));
  let registering = false;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const frozen = value => {
    if (value && typeof value === 'object') {
      for (const key of keys(value)) frozen(value[key]);
      freeze(value);
    }
    return value;
  };
  const patternMatches = (pattern, event) => {
    if (pattern[0] === '!') return !patternMatches(pattern.slice(1), event);
    return pattern === '*' || pattern === event || (pattern.endsWith('.*') && event.startsWith(pattern.slice(0, -1)));
  };
  const copyMatcher = value => {
    let nodes = 0;
    const copy = (v, depth) => {
      if (++nodes > 256 || depth > 8) throw new Error('Mod matcher is too large or deep');
      if (typeof v === 'string' && v.length > 65536) throw new Error('Mod matcher string is too long');
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return v;
      if (v instanceof RegExp) {
        if (/[gy]/.test(v.flags)) throw new Error('Stateful Mod matcher regex is not supported');
        if (/\([^()]*[+*?}]\)\s*[+*{]/.test(v.source)) throw new Error('Nested quantifiers in Mod matcher regex are not supported');
        return new RegExp(v.source, v.flags);
      }
      if (Array.isArray(v)) return freeze(v.map(item => copy(item, depth + 1)));
      if (!object(v) || ![null, Object.prototype].includes(Object.getPrototypeOf(v))) throw new Error('Invalid Mod matcher');
      const out = Object.create(null);
      for (const key of keys(v)) {
        if (key === '__proto__' || key === '$$regex') throw new Error('Invalid Mod matcher key');
        out[key] = copy(v[key], depth + 1);
      }
      return freeze(out);
    };
    if (!object(value) || value instanceof RegExp) throw new Error('Mod matcher must be an object');
    return copy(value, 0);
  };
  // Elements are frozen plain data, built as Claude Code's constructors and
  // its JSX factory build them; the host draws them.
  const flatten = (children, out = []) => {
    for (const child of children) {
      if (child === null || child === undefined || typeof child === 'boolean') continue;
      if (Array.isArray(child)) flatten(child, out);
      else out.push(typeof child === 'number' ? String(child) : child);
    }
    return out;
  };
  const build = (type, props, children) => {
    const own = {};
    let hover;
    for (const key of keys(object(props) ? props : {})) {
      const value = props[key];
      if (key === 'ref' || key === 'children' || value === null || value === undefined) continue;
      if (key === 'hover') { if (object(value)) hover = { ...value }; continue; }
      if (key === 'key') {
        if (type === 'Box' && (typeof value === 'string' || typeof value === 'number')) own.key = String(value);
        continue;
      }
      own[key] = value;
    }
    const kids = flatten(children);
    return frozen({
      type,
      ...(keys(own).length ? { props: own } : {}),
      ...(hover ? { hover } : {}),
      ...(kids.length ? { children: kids } : {})
    });
  };
  const elementTags = ${JSON.stringify(TERMINAL_ELEMENTS)};
  const h = (tag, props, ...children) => {
    // A component, as in Claude Code, gets its children flattened, always an array.
    if (typeof tag === 'function') return tag({ ...(object(props) ? props : {}), children: flatten(children) });
    if (tag === 'Box' || tag === 'Text') return build(tag, props, children);
    throw new TypeError('JSX element <' + String(tag) + '> is not an element: a render hook draws with the table $.ui.resolve(e) returns, not by tag name');
  };
  const Fragment = props => build('Box', { flexDirection: 'column' }, [object(props) ? props.children : undefined]);
  for (const [name, value] of [['h', h], ['Fragment', Fragment]])
    Object.defineProperty(globalThis, name, { value: freeze(value), writable: false, configurable: false });
  const terminal = Object.create(null);
  for (const tag of elementTags) terminal[tag] = freeze(props => {
    const { children, ...rest } = object(props) ? props : {};
    const element = build(tag, rest, Array.isArray(children) ? children : [children]);
    if (!object(element)) throw new TypeError('the element constructor did not build an element');
    return element;
  });
  freeze(terminal);
  const invalidatable = new Set(${JSON.stringify(INVALIDATABLE_EVENTS)});
  const matches = (m, e) => {
    if (Array.isArray(m)) return m.some(v => matches(v, e));
    if (Array.isArray(e)) return e.some(v => matches(m, v));
    if (m instanceof RegExp) return String(e).length > 65536 || m.test(String(e));
    if (object(m)) return object(e) && keys(m).every(k => hasOwn(e, k) && matches(m[k], e[k]));
    return m === e;
  };
  const on = (event, matcher, handler) => {
    if (!registering) throw new Error('on() is only available during register()');
    if (typeof matcher === 'function' && handler === undefined) { handler = matcher; matcher = undefined; }
    const name = typeof event === 'string' ? event.replace(/^!/, '') : '';
    // A known event Qwen does not run yet registers without ever matching.
    if (typeof event !== 'string' || event === '!*' || event.startsWith('!!') ||
        !known.has(name) && name !== '*' && !(/^[a-z]+\.\*$/.test(name) && knownNamespaces.has(name.slice(0, -2)))) {
      throw new Error('Mod event not supported: ' + event);
    }
    if (typeof handler !== 'function') throw new Error('Mod hook must be a function');
    if (matcher !== undefined) matcher = copyMatcher(matcher);
    if (hooks.some(h => h.event === event && (event.includes('*') || event[0] === '!' || h.matcher === undefined && matcher === undefined))) {
      throw new Error('Duplicate Mod hook registration');
    }
    if (hooks.length >= 128) throw new Error('Too many Mod hooks');
    const hook = { event, matcher, handler, caught: undefined, id: hooks.length };
    hooks.push(hook);
    return freeze({ catch: handler => {
      if (!registering || hook.caught || typeof handler !== 'function') throw new Error('Invalid Mod .catch registration');
      hook.caught = handler;
    }});
  };
  const call = (id, frames, kind, value) => bridge(id, kind, encode({ value, frames })).then(json => {
    const envelope = parse(json);
    return frozen(envelope.voidValue ? {value: undefined} : envelope.value);
  });
  const api = (id, frames) => {
    const invoke = (name, value) => call(id, frames, name, value);
    const namespaces = {
      command: { register: spec => invoke('command.register', spec) },
      session: {
        cwd: () => invoke('session.cwd', {}),
        id: () => invoke('session.id', {}),
        model: () => invoke('session.model', {}),
        root: () => invoke('session.root', {}),
        surface: () => invoke('session.surface', {}),
        surfaces: () => invoke('session.surfaces', {}),
        turns: () => invoke('session.turns', {}),
        usage: (args = {}) => invoke('session.usage', args),
        version: () => invoke('session.version', {})
      },
      clock: {
        now: () => invoke('clock.now', {}),
        // The signal stays here: aborting it rejects the wait at once.
        sleep: (ms, options = {}) => {
          if (!object(options) || keys(options).some(k => k !== 'signal')) return Promise.reject(new Error('Invalid Mod sleep options'));
          const { signal } = options;
          if (signal !== undefined && (!object(signal) || typeof signal.addEventListener !== 'function')) return Promise.reject(new Error('Invalid Mod sleep signal'));
          if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Mod sleep aborted'));
          const waiting = invoke('clock.sleep', { ms });
          if (!signal) return waiting;
          return new Promise((resolve, reject) => {
            const abort = () => reject(signal.reason ?? new Error('Mod sleep aborted'));
            signal.addEventListener('abort', abort);
            waiting.then(resolve, reject).finally(() => signal.removeEventListener?.('abort', abort));
          });
        }
      },
      turn: { abort: input => invoke('turn.abort', input) },
      ui: {
        log: (text, options = {}) => {
          if (!object(options) || keys(options).some(k => k !== 'to')) throw new Error('Invalid Mod log');
          void invoke('ui.log', { text: String(text), to: options.to ?? 'transcript' }).catch(() => {});
        },
        // A read of the table, not a dispatch.
        resolve: e => {
          if (!object(e) || e.surface !== 'terminal') throw new TypeError('$.ui.resolve takes a ui.render event drawn on a surface this host draws');
          return terminal;
        },
        invalidate: event => {
          if (!invalidatable.has(event)) throw new TypeError('$.ui.invalidate takes ui.render or a cached-answer event, not ' + String(event));
          void invoke('ui.invalidate', { event }).catch(() => {});
        }
      }
    };
    const unsupported = label => new Proxy({}, { get: (_, key) => { throw new Error('Mod API not supported: ' + label + '.' + String(key)); } });
    for (const key of keys(namespaces)) namespaces[key] = new Proxy(namespaces[key], {
      get: (target, name) => {
        if (!hasOwn(target, name)) throw new Error('Mod API not supported: $.' + key + '.' + String(name));
        return target[name];
      }
    });
    // Data, not methods: it stays the frozen plain object JSON and await expect.
    namespaces.plugin = plugin;
    return new Proxy(namespaces, { get: (target, key) => hasOwn(target, key) ? target[key] : unsupported('$.' + String(key)) });
  };
  const signalFor = run => ({
    get aborted() { return run.aborted || status(run.id, 'aborted'); },
    get reason() { return this.aborted ? new Error('Mod event abandoned') : undefined; },
    onabort: null,
    addEventListener: (type, fn) => { if (type === 'abort' && typeof fn === 'function') run.listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'abort') run.listeners.delete(fn); },
    throwIfAborted() { if (this.aborted) throw this.reason; }
  });
  const nextFor = (run, action, caught) => {
    const signal = run.signal;
    const next = e => action(e);
    Object.assign(next, {
      event: run.event,
      is: pattern => patternMatches(pattern, run.event),
      origin: frozen(run.origin),
      signal,
      to: () => { throw new Error('Mod next.to requires managed tiers, which are not supported'); },
      ...(caught || {})
    });
    Object.defineProperty(next, 'budget', {get: () => freeze({ms:status(run.id, 'ms'), remainingMs:status(run.id, 'remainingMs')})});
    return freeze(next);
  };
  return {
    load: async (register, options) => {
      if (typeof register !== 'function') throw new Error('Mod must export register(on, options)');
      registering = true;
      try { await register(on, frozen(parse(options))); } finally { registering = false; }
      return stringify(hooks.map(h => h.event));
    },
    run: async json => {
      const run = parse(json);
      run.input = frozen(run.input);
      run.inputs = new Map();
      run.listeners = new Set();
      run.aborted = false;
      run.signal = signalFor(run);
      runs.set(run.id, run);
      run.selected = hooks.filter(h => patternMatches(h.event, run.event) && !run.leftOut.includes(h.id));
      const invoke = async (index, input, frames) => {
        const hook = run.selected[index];
        if (!hook) return call(run.id, frames, 'next', input);
        run.inputs.set(hook.id, input);
        if (hook.matcher !== undefined && !matches(hook.matcher, input)) return invoke(index + 1, input, frames);
        const nested = [...frames, hook.id];
        const next = nextFor(run, async e => {
          status(run.id, 'validate', encode(e));
          const result = await invoke(index + 1, frozen(e), nested);
          if (!result) throw new Error('Mod hook returned no result');
          return result;
        });
        return hook.handler(api(run.id, nested), frozen(input), next);
      };
      return encode(await invoke(0, run.input, []));
    },
    recover: async json => {
      const recovery = parse(json);
      const previous = runs.get(recovery.previous);
      if (!previous) return undefined;
      const run = { ...previous, id: recovery.id, aborted: false, listeners: new Set() };
      run.signal = signalFor(run);
      runs.set(run.id, run);
      let error;
      let replay;
      for (const hook of run.selected) {
        const input = run.inputs.get(hook.id) ?? run.input;
        if (!hook.caught || hook.matcher !== undefined && !matches(hook.matcher, input)) continue;
        let used = false;
        const next = nextFor(run, e => { used = true; return replay ??= call(run.id, [hook.id], 'next', recovery.called ? undefined : e); }, {
          error: frozen(recovery.error), called: recovery.called
        });
        try {
          const answer = await hook.caught(api(run.id, [hook.id]), input, next);
          if (answer !== undefined || used) return encode(answer);
        } catch (caught) {
          if (used) throw caught;
          error = caught;
        }
      }
      if (error) throw error;
      return undefined;
    },
    abort: id => {
      const run = runs.get(id);
      if (!run || run.aborted) return;
      run.aborted = true;
      for (const listener of [...run.listeners, run.signal.onabort]) {
        try { if (typeof listener === 'function') listener.call(run.signal, {type:'abort',target:run.signal}); } catch {}
      }
      run.listeners.clear();
    },
    finish: id => { runs.delete(id); }
  };
})
`;
