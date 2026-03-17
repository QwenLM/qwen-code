/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { stdin, stdout } from 'node:process';
import { t } from '../../i18n/index.js';

/**
 * Represents an option in the interactive selector
 */
interface Option<T> {
  value: T;
  label: string;
  description?: string;
}

/**
 * Interactive selector that allows users to navigate with arrow keys
 */
export class InteractiveSelector<T> {
  private selectedIndex = 0;
  private isListening = false;

  constructor(
    private options: Array<Option<T>>,
    private prompt: string = t('Select an option:'),
  ) {}

  /**
   * Shows the interactive menu and waits for user selection
   */
  async select(): Promise<T> {
    return new Promise((resolve, reject) => {
      this.isListening = true;

      // Display initial menu
      this.renderMenu();

      // Check if stdin supports raw mode
      if (!stdin.setRawMode) {
        // Fallback to readline if raw mode is not available (e.g., when piped)
        reject(
          new Error(
            t('Raw mode not available. Please run in an interactive terminal.'),
          ),
        );
        return;
      }

      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');

      const onData = (chunk: string) => {
        if (!this.isListening) return;

        for (const char of chunk) {
          switch (char) {
            case '\x03': // Ctrl+C
              stdin.removeListener('data', onData);
              stdin.setRawMode(wasRaw);
              reject(new Error('Interrupted'));
              return;
            case '\r': // Enter
            case '\n': // Newline
              stdin.removeListener('data', onData);
              stdin.setRawMode(wasRaw);
              resolve(this.options[this.selectedIndex].value);
              return;
            case '\x1B': // ESC sequence
              // Next character will be [, then A, B, C, or D
              break;
            default:
              // Handle other characters if needed
              break;
          }
        }

        // Handle escape sequences
        if (chunk.startsWith('\x1B')) {
          if (chunk === '\x1B[A') {
            // Arrow up
            this.moveUp();
          } else if (chunk === '\x1B[B') {
            // Arrow down
            this.moveDown();
          } else if (chunk === '\x1B[C') {
            // Arrow right
            // Do nothing for now
          } else if (chunk === '\x1B[D') {
            // Arrow left
            // Do nothing for now
          }
        }
      };

      stdin.on('data', onData);
    });
  }

  /**
   * Renders the menu to stdout
   */
  private renderMenu(): void {
    // Calculate how many lines we need to clear
    const totalLines = this.calculateTotalLines();

    // Clear the screen area we'll be using
    if (totalLines > 0) {
      stdout.write(`\x1B[${totalLines}A\x1B[J`); // Move up and clear from cursor down
    }

    // Write the prompt
    stdout.write(`${this.prompt}\n\n`);

    // Write each option - combine label and description on same line
    this.options.forEach((option, index) => {
      const isSelected = index === this.selectedIndex;
      const indicator = isSelected ? '> ' : '  ';
      const color = isSelected ? '\x1B[36m' : '\x1B[0m'; // Cyan for selected, default for others
      const reset = '\x1B[0m';

      // Combine label and description in one line
      let line = `${indicator}${color}${option.label}`;
      if (option.description) {
        line += ` - ${option.description}`;
      }
      line += `${reset}\n`;

      stdout.write(line);
    });

    // Add instructions
    stdout.write(
      `\n${t('(Use ↑ ↓ arrows to navigate, Enter to select, Ctrl+C to exit)\n')}`,
    );
  }

  /**
   * Calculates the total number of lines to clear
   */
  private calculateTotalLines(): number {
    // Lines for: prompt (1) + empty line (1) + options (each option takes 1 line) + empty line (1) + instructions (1)
    return 4 + this.options.length;
  }

  /**
   * Moves selection up
   */
  private moveUp(): void {
    this.selectedIndex =
      (this.selectedIndex - 1 + this.options.length) % this.options.length;
    this.renderMenu();
  }

  /**
   * Moves selection down
   */
  private moveDown(): void {
    this.selectedIndex = (this.selectedIndex + 1) % this.options.length;
    this.renderMenu();
  }
}
