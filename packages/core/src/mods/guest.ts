/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Executed only inside QuickJS. The factory's handles stay private to the host.
export const MOD_GUEST_FACTORY = String.raw`
((bridge, status) => {
  const parse = JSON.parse.bind(JSON);
  const stringify = JSON.stringify.bind(JSON);
  const keys = Object.keys;
  const freeze = Object.freeze;
  const hasOwn = Object.hasOwn;
  const hooks = [];
  const runs = new Map();
  const events = ['session.start', 'session.end', 'command.run', 'command.register', 'ui.log', 'tool.call', 'tool.check'];
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
    if (typeof event !== 'string' || event === '!*' || event.startsWith('!!') ||
        !events.some(e => patternMatches(event, e)) ||
        !events.includes(event.replace(/^!/, '')) && !/^!?([a-z]+\.\*|\*)$/.test(event)) {
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
  const call = (id, frames, kind, value) => bridge(id, kind, stringify({ value, frames })).then(json => {
    const envelope = parse(json);
    return frozen(envelope.voidValue ? {value: undefined} : envelope.value);
  });
  const api = (id, frames) => {
    const invoke = (name, value) => call(id, frames, name, value);
    const namespaces = {
      command: { register: spec => invoke('command.register', spec) },
      ui: { log: (text, options = {}) => {
        if (!object(options) || keys(options).some(k => k !== 'to')) throw new Error('Invalid Mod log');
        void invoke('ui.log', { text: String(text), to: options.to ?? 'transcript' }).catch(() => {});
      }}
    };
    const unsupported = label => new Proxy({}, { get: (_, key) => { throw new Error('Mod API not supported: ' + label + '.' + String(key)); } });
    for (const key of keys(namespaces)) namespaces[key] = new Proxy(namespaces[key], {
      get: (target, name) => {
        if (!hasOwn(target, name)) throw new Error('Mod API not supported: $.' + key + '.' + String(name));
        return target[name];
      }
    });
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
          status(run.id, 'validate', stringify(e));
          const result = await invoke(index + 1, frozen(e), nested);
          if (!result) throw new Error('Mod hook returned no result');
          return result;
        });
        return hook.handler(api(run.id, nested), frozen(input), next);
      };
      return stringify(await invoke(0, run.input, []));
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
          if (answer !== undefined || used) return stringify(answer);
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
