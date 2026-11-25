/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Children, cloneElement, isValidElement, type ReactNode } from 'react';
import { Text, type TextProps } from 'ink';
import tinygradient from 'tinygradient';
import { theme } from '../semantic-colors.js';

/** Preserve the original child styling when a theme has no selection gradient. */
export function SelectionGradient({
  colors,
  children,
}: {
  colors?: string[];
  children: ReactNode;
}) {
  if (!colors || colors.length < 2) return <>{children}</>;

  // Like the header logo, use native Text colors: the cell renderer does not
  // apply ink-gradient's Transform. Sampling code points only determines hue;
  // Ink still owns all text measurement, wrapping and truncation.
  const gradient = tinygradient(colors);
  const paint = (node: ReactNode): ReactNode => {
    if (typeof node === 'string' || typeof node === 'number') {
      const characters = Array.from(String(node));
      return characters.map((character, index) => (
        <Text
          key={index}
          color={gradient
            .rgbAt(index / Math.max(1, characters.length - 1))
            .toHexString()}
        >
          {character}
        </Text>
      ));
    }
    if (isValidElement<{ children?: ReactNode }>(node)) {
      return cloneElement(
        node,
        undefined,
        Children.map(node.props.children, paint),
      );
    }
    return node;
  };
  return <>{Children.map(children, paint)}</>;
}

export function SelectionText({
  children,
  color,
  ...props
}: Omit<TextProps, 'color'> & { color?: string }) {
  const selectionColor = theme.ui.selection ?? theme.status.success;
  return (
    <SelectionGradient
      colors={
        color && color !== selectionColor
          ? undefined
          : theme.ui.selectionGradient
      }
    >
      <Text color={color ?? selectionColor} {...props}>
        {children}
      </Text>
    </SelectionGradient>
  );
}
