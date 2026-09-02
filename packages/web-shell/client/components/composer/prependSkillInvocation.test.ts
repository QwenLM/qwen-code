import { describe, expect, it } from 'vitest';
import { computePrependSkillTransaction } from './prependSkillInvocation';

describe('computePrependSkillTransaction', () => {
  it('empty doc: inserts "<invocation> " and puts the cursor after it', () => {
    expect(computePrependSkillTransaction('', '/review')).toEqual({
      changes: { from: 0, to: 0, insert: '/review ' },
      selection: { anchor: '/review '.length },
      scrollIntoView: true,
    });
  });

  it('non-empty doc: prepends without touching the existing draft', () => {
    expect(computePrependSkillTransaction('foo bar', '/review')).toEqual({
      changes: { from: 0, to: 0, insert: '/review ' },
      selection: { anchor: '/review '.length },
      scrollIntoView: true,
    });
  });

  it('is idempotent when the doc already starts with the invocation', () => {
    expect(computePrependSkillTransaction('/review foo', '/review')).toBeNull();
  });

  it('is idempotent when the doc is exactly the invocation', () => {
    expect(computePrependSkillTransaction('/review', '/review')).toBeNull();
  });

  it('does not treat text glued to the invocation as already prepended', () => {
    expect(
      computePrependSkillTransaction('/reviewfoo', '/review'),
    ).not.toBeNull();
  });

  it('does not treat a longer skill sharing the prefix as prepended', () => {
    expect(
      computePrependSkillTransaction('/reviewer foo', '/review'),
    ).not.toBeNull();
  });
});
