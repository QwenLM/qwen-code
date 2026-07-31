/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { safeJsonStringify } from './safeJsonStringify.js';

describe('safeJsonStringify', () => {
  it('should stringify normal objects without issues', () => {
    const obj = { name: 'test', value: 42 };
    const result = safeJsonStringify(obj);
    expect(result).toBe('{"name":"test","value":42}');
  });

  it('should handle circular references by replacing them with [Circular]', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: any = { name: 'test' };
    obj.circular = obj; // Create circular reference

    const result = safeJsonStringify(obj);
    expect(result).toBe('{"name":"test","circular":"[Circular]"}');
  });

  it('should handle complex circular structures like HttpsProxyAgent', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agent: any = {
      sockets: {},
      options: { host: 'example.com' },
    };
    agent.sockets['example.com'] = [{ agent }];

    const result = safeJsonStringify(agent);
    expect(result).toContain('[Circular]');
    expect(result).toContain('example.com');
  });

  it('should respect the space parameter for formatting', () => {
    const obj = { name: 'test', value: 42 };
    const result = safeJsonStringify(obj, 2);
    expect(result).toBe('{\n  "name": "test",\n  "value": 42\n}');
  });

  it('should handle circular references with formatting', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: any = { name: 'test' };
    obj.circular = obj;

    const result = safeJsonStringify(obj, 2);
    expect(result).toBe('{\n  "name": "test",\n  "circular": "[Circular]"\n}');
  });

  it('should handle arrays with circular references', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arr: any[] = [{ id: 1 }];
    arr[0].parent = arr; // Create circular reference

    const result = safeJsonStringify(arr);
    expect(result).toBe('[{"id":1,"parent":"[Circular]"}]');
  });

  it('should handle null and undefined values', () => {
    expect(safeJsonStringify(null)).toBe('null');
    expect(safeJsonStringify(undefined)).toBe(undefined);
  });

  it('should handle primitive values', () => {
    expect(safeJsonStringify('test')).toBe('"test"');
    expect(safeJsonStringify(42)).toBe('42');
    expect(safeJsonStringify(true)).toBe('true');
  });

  it('should preserve duplicate sibling references as full copies', () => {
    // The same object referenced from two sibling properties is not a cycle:
    // both branches must serialize in full, matching native JSON.stringify.
    const shared = { name: 'shared', n: 1 };
    const obj = { a: shared, b: shared };

    const result = safeJsonStringify(obj);
    expect(result).toBe(
      '{"a":{"name":"shared","n":1},"b":{"name":"shared","n":1}}',
    );
    expect(result).not.toContain('[Circular]');
  });

  it('should preserve duplicate references repeated in an array', () => {
    const shared = { id: 1 };
    const arr = [shared, shared, shared];

    const result = safeJsonStringify(arr);
    expect(result).toBe('[{"id":1},{"id":1},{"id":1}]');
    expect(result).not.toContain('[Circular]');
  });

  it('should preserve a shared leaf appearing on multiple branches', () => {
    const leaf = { kind: 'leaf' };
    const tree = { left: { sub: leaf }, right: { sub: leaf } };

    const result = safeJsonStringify(tree);
    expect(result).toBe(
      '{"left":{"sub":{"kind":"leaf"}},"right":{"sub":{"kind":"leaf"}}}',
    );
    expect(result).not.toContain('[Circular]');
  });

  it('should detect indirect cycles via an intermediate object', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parent: any = { name: 'parent' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const child: any = { name: 'child' };
    parent.child = child;
    child.parent = parent;

    const result = safeJsonStringify(parent);
    expect(result).toBe(
      '{"name":"parent","child":{"name":"child","parent":"[Circular]"}}',
    );
  });

  it('should preserve a shared subtree alongside a real cycle', () => {
    const shared = { tag: 'shared' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root: any = { a: shared, b: shared };
    root.self = root;

    const result = safeJsonStringify(root);
    expect(result).toBe(
      '{"a":{"tag":"shared"},"b":{"tag":"shared"},"self":"[Circular]"}',
    );
  });

  it('should preserve a shared leaf reached through deep ancestor chains', () => {
    // Forces the unwind loop to pop five frames between the deep branch and
    // the sibling branch. Without the pop, the second occurrence of `shared`
    // would still see `shared` on the stack and emit [Circular].
    const shared = { tag: 'shared' };
    const root = {
      l1: { l2: { l3: { l4: { l5: { leaf: shared } } } } },
      sibling: { leaf: shared },
    };

    const result = safeJsonStringify(root);
    expect(result).toBe(
      '{"l1":{"l2":{"l3":{"l4":{"l5":{"leaf":{"tag":"shared"}}}}}},"sibling":{"leaf":{"tag":"shared"}}}',
    );
    expect(result).not.toContain('[Circular]');
  });

  it('should detect a real cycle through deep ancestor chains', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root: any = { l1: { l2: { l3: { l4: { l5: { back: null } } } } } };
    root.l1.l2.l3.l4.l5.back = root;

    const result = safeJsonStringify(root);
    expect(result).toBe(
      '{"l1":{"l2":{"l3":{"l4":{"l5":{"back":"[Circular]"}}}}}}',
    );
  });

  it('should preserve a shared object returned by toJSON from sibling positions', () => {
    // JSON.stringify calls toJSON() before invoking the replacer, so the
    // replacer sees the post-toJSON value. Two siblings whose toJSON returns
    // the same object are duplicate refs, not a cycle.
    const shared = { tag: 'shared' };
    const root = {
      a: { toJSON: () => shared },
      b: { toJSON: () => shared },
    };

    const result = safeJsonStringify(root);
    expect(result).toBe('{"a":{"tag":"shared"},"b":{"tag":"shared"}}');
    expect(result).not.toContain('[Circular]');
  });

  it('should detect a cycle when toJSON returns an ancestor', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root: any = { name: 'root' };
    root.child = { toJSON: () => root };

    const result = safeJsonStringify(root);
    expect(result).toBe('{"name":"root","child":"[Circular]"}');
  });
});
