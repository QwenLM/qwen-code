import { describe, expect, it } from 'vitest';

import { AlertDialogContent, AlertDialogOverlay } from './alert-dialog';
import { Button } from './button';
import { DialogContent, DialogOverlay } from './dialog';
import { Input } from './input';
import { SelectTrigger } from './select';

const FORWARD_REF_TYPE = Symbol.for('react.forward_ref');

describe('React 18 ref compatibility', () => {
  it.each([
    ['AlertDialogContent', AlertDialogContent],
    ['AlertDialogOverlay', AlertDialogOverlay],
    ['Button', Button],
    ['DialogContent', DialogContent],
    ['DialogOverlay', DialogOverlay],
    ['Input', Input],
    ['SelectTrigger', SelectTrigger],
  ])('%s forwards refs', (_name, Component) => {
    expect(Component).toHaveProperty('$$typeof', FORWARD_REF_TYPE);
  });
});
