/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRuntimeError } from './errors.js';
import {
  isDirectlyTypable,
  keyDescription,
  MODIFIER_BITS,
  modifierMask,
  modifierName,
  mouseButton,
  mouseButtonMask,
  type CdpModifier,
  type CdpMouseButton,
  type KeyCombination,
  type KeyDescription,
} from './input.js';
import type { SupportedCommand } from './schemas.js';

export type CdpInputSender<TTab> = (
  tab: TTab,
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export type CoordinateInputCommand = Extract<SupportedCommand, `cua.${string}`>;

interface HeldKey {
  description: KeyDescription;
  modifier?: CdpModifier;
}

interface InputState {
  buttons: number;
  pointerButton?: CdpMouseButton;
  pointerModifiers: number;
  heldKeys: Map<string, HeldKey>;
  modifiers: number;
}

/** Owns CDP coordinate input sequences and the held input state for each tab. */
export class InputController<TTab, TTarget> {
  private readonly states = new Map<TTab, InputState>();

  constructor(
    private readonly send: CdpInputSender<TTab>,
    private readonly completionBarrier: (
      tab: TTab,
      target: TTarget,
    ) => Promise<void>,
    private readonly presentationBarrier: (
      tab: TTab,
      target: TTarget,
    ) => Promise<void>,
  ) {}

  hasPointerDown(tab: TTab): boolean {
    return (this.states.get(tab)?.buttons ?? 0) !== 0;
  }

  hasKeysDown(tab: TTab): boolean {
    return (this.states.get(tab)?.heldKeys.size ?? 0) !== 0;
  }

  clear(tab: TTab): void {
    this.states.delete(tab);
  }

  async executeCoordinate(
    method: CoordinateInputCommand,
    tab: TTab,
    args: Readonly<Record<string, unknown>>,
    target: TTarget,
  ): Promise<null> {
    switch (method) {
      case 'cua.click':
        await this.mouseClick(
          tab,
          numberArg(args, 'x'),
          numberArg(args, 'y'),
          {
            button: mouseButton(args.button),
            modifiers: modifierMask(args.keypress as unknown[] | undefined),
            clicks: typeof args.clickCount === 'number' ? args.clickCount : 1,
          },
          target,
        );
        return null;
      case 'cua.double_click':
        await this.mouseClick(
          tab,
          numberArg(args, 'x'),
          numberArg(args, 'y'),
          {
            button: 'left',
            modifiers: modifierMask(args.keypress as unknown[] | undefined),
            clicks: 2,
          },
          target,
        );
        return null;
      case 'cua.move':
        await this.mouseMove(
          tab,
          numberArg(args, 'x'),
          numberArg(args, 'y'),
          args.keys === undefined
            ? undefined
            : modifierMask(args.keys as unknown[]),
        );
        return null;
      case 'cua.scroll':
        await this.send(tab, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: numberArg(args, 'x'),
          y: numberArg(args, 'y'),
          deltaX: numberArg(args, 'scrollX'),
          deltaY: numberArg(args, 'scrollY'),
          modifiers: modifierMask(args.keypress as unknown[] | undefined),
        });
        await this.presentationBarrier(tab, target);
        return null;
      case 'cua.drag':
        await this.drag(
          tab,
          args.path as ReadonlyArray<{ x: number; y: number }>,
          modifierMask(args.keys as unknown[] | undefined),
          target,
        );
        return null;
      case 'cua.keypress':
        await this.keypressSequence(tab, (args.keys as unknown[]).map(String));
        return null;
      case 'cua.type':
        await this.typeText(tab, stringArg(args, 'text'));
        await this.completionBarrier(tab, target);
        return null;
      case 'cua.mouse_down':
        await this.mouseDown(
          tab,
          numberArg(args, 'x'),
          numberArg(args, 'y'),
          mouseButton(args.button),
          modifierMask(args.modifiers as unknown[] | undefined),
        );
        return null;
      case 'cua.mouse_up':
        await this.mouseUp(
          tab,
          numberArg(args, 'x'),
          numberArg(args, 'y'),
          args.button === undefined ? undefined : mouseButton(args.button),
          args.modifiers === undefined
            ? undefined
            : modifierMask(args.modifiers as unknown[]),
          target,
        );
        return null;
      case 'cua.key_down':
        await this.keyDown(
          tab,
          stringArg(args, 'key'),
          modifierMask(args.modifiers as unknown[] | undefined),
        );
        return null;
      case 'cua.key_up':
        await this.keyUp(
          tab,
          stringArg(args, 'key'),
          modifierMask(args.modifiers as unknown[] | undefined),
        );
        return null;
      case 'cua.hold_key':
        await this.holdKeys(
          tab,
          (args.keys as unknown[]).map(String),
          numberArg(args, 'durationMs'),
        );
        return null;
      default:
        throw new BrowserRuntimeError(
          'UNKNOWN_METHOD',
          `Unknown coordinate input method: ${method}`,
        );
    }
  }

  async mouseClick(
    tab: TTab,
    x: number,
    y: number,
    options: { button: CdpMouseButton; modifiers: number; clicks: number },
    target: TTarget,
  ): Promise<void> {
    const buttons = mouseButtonMask(options.button);
    await this.send(tab, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      modifiers: options.modifiers,
    });
    for (let clickCount = 1; clickCount <= options.clicks; clickCount += 1) {
      const press = {
        type: 'mousePressed',
        x,
        y,
        button: options.button,
        buttons,
        clickCount,
        modifiers: options.modifiers,
      };
      const release = {
        type: 'mouseReleased',
        x,
        y,
        button: options.button,
        buttons: 0,
        clickCount,
        modifiers: options.modifiers,
      };
      try {
        // Treat a rejected press as uncertain: Chrome may have applied it
        // before the transport reported the failure.
        await this.send(tab, 'Input.dispatchMouseEvent', press);
        await this.send(tab, 'Input.dispatchMouseEvent', release);
      } catch (error) {
        await this.send(tab, 'Input.dispatchMouseEvent', release).catch(
          () => undefined,
        );
        throw error;
      }
    }
    await this.completionBarrier(tab, target);
  }

  async keypressSequence(tab: TTab, keys: readonly string[]): Promise<void> {
    const modifiers = keys.flatMap((key) => {
      const modifier = modifierName(key);
      return modifier === undefined ? [] : [modifier];
    });
    const ordinaryKeys = keys
      .filter((key) => modifierName(key) === undefined)
      .map(keyDescription);
    await this.dispatchKeyChord(tab, modifiers, ordinaryKeys);
  }

  async pressCombination(
    tab: TTab,
    combination: KeyCombination,
  ): Promise<void> {
    await this.dispatchKeyChord(
      tab,
      combination.modifiers,
      combination.key === undefined ? [] : [combination.key],
    );
  }

  private async dispatchKeyChord(
    tab: TTab,
    modifiersToPress: readonly CdpModifier[],
    ordinaryKeys: readonly KeyDescription[],
  ): Promise<void> {
    let modifiers = 0;
    const pressedModifiers: CdpModifier[] = [];
    let pressedKey: Omit<KeyDescription, 'text'> | undefined;
    let operationError: unknown;
    try {
      for (const modifier of modifiersToPress) {
        modifiers |= MODIFIER_BITS[modifier];
        pressedModifiers.push(modifier);
        await this.send(tab, 'Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          ...keyDescription(modifier),
          modifiers,
        });
      }
      for (const description of ordinaryKeys) {
        const { text, ...key } = description;
        const emitText =
          text !== undefined && (modifiers & ~MODIFIER_BITS.Shift) === 0;
        const commands = editingCommands(modifiers, key);
        pressedKey = key;
        await this.send(tab, 'Input.dispatchKeyEvent', {
          type: emitText ? 'keyDown' : 'rawKeyDown',
          ...key,
          modifiers,
          ...(emitText ? { text, unmodifiedText: text } : {}),
          ...(commands === undefined ? {} : { commands }),
        });
        await this.send(tab, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          ...key,
          modifiers,
        });
        pressedKey = undefined;
      }
    } catch (error) {
      operationError = error;
    }
    let releaseError: unknown;
    if (pressedKey !== undefined) {
      try {
        await this.send(tab, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          ...pressedKey,
          modifiers,
        });
      } catch (error) {
        releaseError = error;
      }
    }
    for (const modifier of pressedModifiers.reverse()) {
      modifiers &= ~MODIFIER_BITS[modifier];
      try {
        await this.send(tab, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          ...keyDescription(modifier),
          modifiers,
        });
      } catch (error) {
        releaseError ??= error;
      }
    }
    if (operationError !== undefined) throw operationError;
    if (releaseError !== undefined) throw releaseError;
  }

  async typeText(tab: TTab, text: string): Promise<void> {
    for (const character of text) {
      if (character === '\n' || character === '\r' || character === '\t') {
        await this.pressCombination(tab, {
          modifiers: [],
          key: keyDescription(character),
        });
        continue;
      }
      if (!isDirectlyTypable(character)) {
        await this.send(tab, 'Input.insertText', { text: character });
        continue;
      }
      await this.pressCombination(tab, {
        modifiers: [],
        key: keyDescription(character),
      });
    }
  }

  private state(tab: TTab): InputState {
    let state = this.states.get(tab);
    if (state === undefined) {
      state = {
        buttons: 0,
        pointerModifiers: 0,
        heldKeys: new Map(),
        modifiers: 0,
      };
      this.states.set(tab, state);
    }
    return state;
  }

  private prune(tab: TTab, state: InputState): void {
    if (state.buttons === 0 && state.heldKeys.size === 0)
      this.states.delete(tab);
  }

  private async mouseMove(
    tab: TTab,
    x: number,
    y: number,
    requestedModifiers: number | undefined,
  ): Promise<void> {
    const state = this.states.get(tab);
    const buttons = state?.buttons ?? 0;
    const modifiers = requestedModifiers ?? state?.pointerModifiers ?? 0;
    await this.send(tab, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      modifiers,
      ...(buttons === 0 ? {} : { button: state?.pointerButton, buttons }),
    });
  }

  private async mouseDown(
    tab: TTab,
    x: number,
    y: number,
    button: CdpMouseButton,
    modifiers: number,
  ): Promise<void> {
    const state = this.state(tab);
    const mask = mouseButtonMask(button);
    if ((state.buttons & mask) !== 0) {
      throw new BrowserRuntimeError(
        'CONCURRENT_TAB_OPERATION',
        `The ${button} mouse button is already held on this tab`,
      );
    }
    await this.mouseMove(tab, x, y, modifiers);
    const buttons = state.buttons | mask;
    try {
      await this.send(tab, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        buttons,
        clickCount: 1,
        modifiers,
      });
    } catch (error) {
      await this.send(tab, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button,
        buttons: state.buttons,
        clickCount: 1,
        modifiers,
      }).catch(() => undefined);
      this.prune(tab, state);
      throw error;
    }
    state.buttons = buttons;
    state.pointerButton = button;
    state.pointerModifiers = modifiers;
  }

  private async mouseUp(
    tab: TTab,
    x: number,
    y: number,
    requestedButton: CdpMouseButton | undefined,
    requestedModifiers: number | undefined,
    target: TTarget,
  ): Promise<void> {
    const state = this.state(tab);
    const button = requestedButton ?? state.pointerButton ?? 'left';
    const modifiers = requestedModifiers ?? state.pointerModifiers;
    const buttons = state.buttons & ~mouseButtonMask(button);
    try {
      await this.send(tab, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button,
        buttons,
        clickCount: 1,
        modifiers,
      });
    } catch (error) {
      this.prune(tab, state);
      throw error;
    }
    state.buttons = buttons;
    if (buttons === 0) {
      delete state.pointerButton;
      state.pointerModifiers = 0;
    }
    this.prune(tab, state);
    await this.completionBarrier(tab, target);
  }

  private async drag(
    tab: TTab,
    path: ReadonlyArray<{ x: number; y: number }>,
    modifiers: number,
    target: TTarget,
  ): Promise<void> {
    const first = path[0];
    const last = path.at(-1);
    if (first === undefined || last === undefined)
      throw new BrowserRuntimeError('INVALID_ARGUMENT', 'Drag requires a path');
    await this.mouseDown(tab, first.x, first.y, 'left', modifiers);
    let operationError: unknown;
    try {
      for (const point of path.slice(1))
        await this.mouseMove(tab, point.x, point.y, modifiers);
    } catch (error) {
      operationError = error;
    }
    let releaseError: unknown;
    try {
      await this.mouseUp(tab, last.x, last.y, 'left', modifiers, target);
    } catch (error) {
      this.clear(tab);
      releaseError = error;
    }
    if (operationError !== undefined) throw operationError;
    if (releaseError !== undefined) throw releaseError;
  }

  private async keyDown(
    tab: TTab,
    value: string,
    explicitModifiers: number,
  ): Promise<void> {
    const state = this.state(tab);
    const description = keyDescription(value);
    const modifier = modifierName(value);
    const id = keyIdentity(description);
    if (state.heldKeys.has(id)) {
      throw new BrowserRuntimeError(
        'CONCURRENT_TAB_OPERATION',
        `The ${description.key} key is already held on this tab`,
      );
    }
    const modifiers =
      state.modifiers |
      explicitModifiers |
      (modifier === undefined ? 0 : MODIFIER_BITS[modifier]);
    const { text, ...key } = description;
    const emitText =
      text !== undefined && (modifiers & ~MODIFIER_BITS.Shift) === 0;
    try {
      await this.send(tab, 'Input.dispatchKeyEvent', {
        type: emitText ? 'keyDown' : 'rawKeyDown',
        ...key,
        modifiers,
        ...(emitText ? { text, unmodifiedText: text } : {}),
      });
    } catch (error) {
      await this.send(tab, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        ...key,
        modifiers:
          modifiers & ~(modifier === undefined ? 0 : MODIFIER_BITS[modifier]),
      }).catch(() => undefined);
      this.prune(tab, state);
      throw error;
    }
    state.heldKeys.set(id, {
      description,
      ...(modifier === undefined ? {} : { modifier }),
    });
    state.modifiers = modifiers;
  }

  private async keyUp(
    tab: TTab,
    value: string,
    explicitModifiers: number,
  ): Promise<void> {
    const state = this.state(tab);
    const supplied = keyDescription(value);
    const id = keyIdentity(supplied);
    const held = state.heldKeys.get(id);
    const description = held?.description ?? supplied;
    const modifier = held?.modifier ?? modifierName(value);
    const modifiers =
      (state.modifiers | explicitModifiers) &
      ~(modifier === undefined ? 0 : MODIFIER_BITS[modifier]);
    const { text: _text, ...key } = description;
    try {
      await this.send(tab, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        ...key,
        modifiers,
      });
    } catch (error) {
      this.prune(tab, state);
      throw error;
    }
    state.heldKeys.delete(id);
    state.modifiers = modifiers;
    this.prune(tab, state);
  }

  private async holdKeys(
    tab: TTab,
    keys: readonly string[],
    durationMs: number,
  ): Promise<void> {
    const pressed: string[] = [];
    let operationError: unknown;
    try {
      for (const key of [...keys].sort(
        (left, right) =>
          Number(modifierName(right) !== undefined) -
          Number(modifierName(left) !== undefined),
      )) {
        await this.keyDown(tab, key, 0);
        pressed.push(key);
      }
      await delay(durationMs);
    } catch (error) {
      operationError = error;
    }
    let releaseError: unknown;
    for (const key of pressed.reverse()) {
      try {
        await this.keyUp(tab, key, 0);
      } catch (error) {
        releaseError ??= error;
      }
    }
    if (operationError !== undefined) throw operationError;
    if (releaseError !== undefined) {
      this.clear(tab);
      throw releaseError;
    }
  }
}

/** CDP does not consistently apply native editing accelerators on macOS. */
function editingCommands(
  modifiers: number,
  key: KeyDescription,
): string[] | undefined {
  const primary =
    process.platform === 'darwin' ? MODIFIER_BITS.Meta : MODIFIER_BITS.Control;
  if (modifiers !== primary) return undefined;
  if (key.code === 'KeyA') return ['selectAll'];
  return undefined;
}

function keyIdentity(description: KeyDescription): string {
  return `${description.code}\u0000${description.key}`;
}

function numberArg(
  args: Readonly<Record<string, unknown>>,
  name: string,
): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BrowserRuntimeError(
      'INVALID_ARGUMENT',
      `${name} must be a finite number`,
    );
  }
  return value;
}

function stringArg(
  args: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = args[name];
  if (typeof value !== 'string')
    throw new BrowserRuntimeError(
      'INVALID_ARGUMENT',
      `${name} must be a string`,
    );
  return value;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
