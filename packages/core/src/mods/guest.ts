/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Executed only inside QuickJS. The factory's handles stay private to the host.
export const MOD_GUEST_FACTORY = String.raw`
(emitLog => {
  const parse = JSON.parse.bind(JSON);
  const stringify = JSON.stringify.bind(JSON);
  const keys = Object.keys;
  const freeze = Object.freeze;
  const hooks = [];
  const commands = new Map();
  let registering = false;
  let starting = false;

  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const checkKeys = (value, allowed, label) => {
    if (!object(value) || keys(value).some(key => !allowed.includes(key))) {
      throw new Error('Unsupported ' + label + ' fields');
    }
  };
  const frozen = value => {
    if (value && typeof value === 'object') {
      for (const key of keys(value)) frozen(value[key]);
      freeze(value);
    }
    return value;
  };
  const equal = (a, b) => a === b || (object(a) && object(b) &&
    keys(a).length === keys(b).length && keys(a).every(key => Object.hasOwn(b, key) && equal(a[key], b[key])));
  const unsupported = label => new Proxy({}, {
    get: (_, key) => { throw new Error('Mod API not supported: ' + label + '.' + String(key)); }
  });
  const api = new Proxy({
    command: new Proxy({
      register: async spec => {
        if (!starting) throw new Error('Register Mod commands during session.start');
        checkKeys(spec, ['name', 'description', 'argumentHint'], 'command.register');
        if (typeof spec.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(spec.name) ||
            typeof spec.description !== 'string' || !spec.description.trim() ||
            spec.description.length > 2000 ||
            (spec.argumentHint !== undefined && typeof spec.argumentHint !== 'string')) {
          throw new Error('Invalid Mod command specification');
        }
        if (!commands.has(spec.name) && commands.size >= 64) throw new Error('Too many Mod commands');
        commands.set(spec.name, parse(stringify(spec)));
        return { command: spec.name };
      }
    }, { get: (target, key) => {
      if (!Object.hasOwn(target, key)) throw new Error('Mod API not supported: $.command.' + String(key));
      return target[key];
    }}),
    ui: new Proxy({
      log: (text, options = {}) => {
        checkKeys(options, ['to'], 'ui.log');
        const to = options.to === undefined ? 'transcript' : options.to;
        if (typeof text !== 'string' || text.length > 10000 || !['debug', 'transcript'].includes(to)) {
          throw new Error('Invalid or oversized Mod log');
        }
        emitLog(text, to);
      }
    }, { get: (target, key) => {
      if (!Object.hasOwn(target, key)) throw new Error('Mod API not supported: $.ui.' + String(key));
      return target[key];
    }})
  }, { get: (target, key) => Object.hasOwn(target, key) ? target[key] : unsupported('$.' + String(key)) });

  const on = (event, matcher, handler) => {
    if (!registering) throw new Error('on() is only available during register()');
    if (typeof matcher === 'function' && handler === undefined) {
      handler = matcher;
      matcher = undefined;
    }
    if (!['session.start', 'session.end', 'command.run'].includes(event)) {
      throw new Error('Mod event not supported: ' + event);
    }
    if (typeof handler !== 'function') throw new Error('Mod hook must be a function');
    if (event === 'command.run') {
      checkKeys(matcher, ['command'], 'command.run matcher');
      if (typeof matcher.command !== 'string') throw new Error('An exact own-command matcher is required');
      matcher = freeze({ command: matcher.command });
    } else if (matcher !== undefined) {
      throw new Error('Lifecycle matchers are not supported yet');
    }
    if (hooks.some(h => h.event === event && stringify(h.matcher) === stringify(matcher))) {
      throw new Error('Duplicate Mod hook registration');
    }
    if (hooks.length >= 128) throw new Error('Too many Mod hooks');
    hooks.push({ event, matcher, handler });
    return freeze({ catch: () => { throw new Error('Mod registration.catch is not supported yet'); } });
  };

  const dispatch = async (event, input) => {
    const pinned = event === 'command.run' ? { ...input, args: '' } : input;
    const invoke = async (index, e) => {
      if (!object(e) || !equal(event === 'command.run' ? { ...e, args: '' } : e, pinned) ||
          (event === 'command.run' && typeof e.args !== 'string')) {
        throw new Error('Mod hook changed pinned event fields');
      }
      const h = hooks[index];
      if (!h) {
        if (event === 'session.start') return { cwd: e.cwd };
        if (event === 'session.end') return { sessionId: e.sessionId };
        throw new Error('No Mod hook answered /' + e.command);
      }
      if (h.event !== event || (h.matcher && h.matcher.command !== e.command)) return invoke(index + 1, e);
      const next = Object.assign(nextInput => invoke(index + 1, nextInput), { event });
      const result = await h.handler(api, frozen(e), next);
      if (event === 'command.run') {
        checkKeys(result, ['text'], 'command.run result');
        if (result.text !== undefined && typeof result.text !== 'string') throw new Error('Invalid Mod command text');
      } else if (!object(result)) throw new Error('Mod hooks must return a result');
      return result;
    };
    return invoke(0, input);
  };

  return {
    load: async (register, cwd) => {
      if (typeof register !== 'function') throw new Error('Mod must export register(on, options)');
      registering = true;
      try { await register(on, freeze({})); } finally { registering = false; }
      starting = true;
      try { await dispatch('session.start', { cwd, surface: null, isInteractive: false }); }
      finally { starting = false; }
      for (const hook of hooks) {
        if (hook.event === 'command.run' && !commands.has(hook.matcher.command)) {
          throw new Error('A Mod can currently hook only its own registered commands');
        }
      }
      return stringify([...commands.values()]);
    },
    dispatch: async json => {
      const request = parse(json);
      const result = request.type === 'command'
        ? await dispatch('command.run', {
          command: request.command, args: request.args,
          origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 }
        })
        : await dispatch('session.end', {
          reason: request.reason, sessionId: request.sessionId, resume: { id: request.sessionId }
        });
      return stringify(result);
    }
  };
})
`;
