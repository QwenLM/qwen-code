/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Vendored from ink-gradient v3.0.0 (https://github.com/sindresorhus/ink-gradient),
 * modified by the Qwen Team to use the CLI's vendored Ink. The runtime
 * propTypes were dropped because React 19 no longer checks them; the same
 * constraints are enforced by the Props type and the runtime errors below.
 *
 * MIT License
 *
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

import type { FC, ReactNode } from 'react';
import { Transform } from 'ink';
import gradientString from 'gradient-string';
import stripAnsi from 'strip-ansi';

export type GradientName =
  | 'cristal'
  | 'teen'
  | 'mind'
  | 'morning'
  | 'vice'
  | 'passion'
  | 'fruit'
  | 'instagram'
  | 'atlas'
  | 'retro'
  | 'summer'
  | 'pastel'
  | 'rainbow';

export type GradientColors = Array<string | Record<string, unknown>>;

export type Props = {
  readonly children: ReactNode;
  /**
   * The name of a [built-in gradient](https://github.com/bokub/gradient-string#available-built-in-gradients).
   *
   * Mutually exclusive with `colors`.
   */
  readonly name?: GradientName;
  /**
   * [Colors to use to make the gradient.](https://github.com/bokub/gradient-string#initialize-a-gradient)
   *
   * Mutually exclusive with `name`.
   */
  readonly colors?: GradientColors;
};

const Gradient: FC<Props> = (props) => {
  if (props.name && props.colors) {
    throw new Error('The `name` and `colors` props are mutually exclusive');
  }

  let gradient: gradientString.Gradient;
  if (props.name) {
    gradient = gradientString[props.name];
  } else if (props.colors) {
    // Upstream passes the colors through untyped (TODO: Make stronger type).
    gradient = gradientString(props.colors as string[]);
  } else {
    throw new Error('Either `name` or `colors` prop must be provided');
  }

  const applyGradient = (text: string) => gradient.multiline(stripAnsi(text));

  return <Transform transform={applyGradient}>{props.children}</Transform>;
};

export default Gradient;
