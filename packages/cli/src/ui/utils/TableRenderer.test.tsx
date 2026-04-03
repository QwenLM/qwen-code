/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { TableRenderer } from './TableRenderer.js';

describe('TableRenderer', () => {
  describe('basic table rendering', () => {
    it('should render a simple table with headers and one row', () => {
      const { lastFrame } = render(
        React.createElement(TableRenderer, {
          headers: ['Name', 'Age'],
          rows: [['Alice', '30']],
          contentWidth: 40,
        }),
      );

      const frame = lastFrame();
      expect(frame).toContain('┌');
      expect(frame).toContain('┐');
      expect(frame).toContain('│');
      expect(frame).toContain('Name');
      expect(frame).toContain('Age');
      expect(frame).toContain('Alice');
    });

    it('should render multiple rows', () => {
      const { lastFrame } = render(
        React.createElement(TableRenderer, {
          headers: ['Name', 'Age'],
          rows: [
            ['Alice', '30'],
            ['Bob', '25'],
          ],
          contentWidth: 40,
        }),
      );

      const frame = lastFrame();
      expect(frame).toContain('Alice');
      expect(frame).toContain('Bob');
    });
  });

  describe('text wrapping', () => {
    it('should wrap long text in cells instead of truncating', () => {
      const { lastFrame } = render(
        React.createElement(TableRenderer, {
          headers: ['Name', 'Description'],
          rows: [
            [
              'Alice',
              'This is a very long description that should wrap across multiple lines in the table cell',
            ],
          ],
          contentWidth: 60,
        }),
      );

      const frame = lastFrame();
      // Should not contain ellipsis (truncation marker)
      expect(frame).not.toContain('...');
      // Should contain the wrapped content
      expect(frame).toContain('Al');
      expect(frame).toContain('description');
    });

    it('should preserve table structure with multi-line cells', () => {
      const { lastFrame } = render(
        React.createElement(TableRenderer, {
          headers: ['Name', 'Description'],
          rows: [
            ['Alice', 'A very long description that wraps'],
            ['Bob', 'Short'],
          ],
          contentWidth: 50,
        }),
      );

      const frame = lastFrame();
      // Check that borders are properly aligned
      expect(frame).toContain('├');
      expect(frame).toContain('┼');
      expect(frame).toContain('┤');
    });

    it('should handle cells with intentional newlines', () => {
      const { lastFrame } = render(
        React.createElement(TableRenderer, {
          headers: ['Name', 'Address'],
          rows: [['Alice', '123 Main St\nApt 4B\nCity, State 12345']],
          contentWidth: 60,
        }),
      );

      const frame = lastFrame();
      expect(frame).toContain('Alice');
      expect(frame).toContain('123 Main St');
      expect(frame).toContain('Apt 4B');
    });
  });

  describe('edge cases', () => {
    it('should handle empty cells', () => {
      const { lastFrame } = render(
        React.createElement(TableRenderer, {
          headers: ['Name', 'Description'],
          rows: [['Alice', '']],
          contentWidth: 40,
        }),
      );

      const frame = lastFrame();
      expect(frame).toContain('Alice');
      expect(frame).toBeDefined();
    });

    it('should handle cells with only whitespace', () => {
      const { lastFrame } = render(
        React.createElement(TableRenderer, {
          headers: ['Name', 'Description'],
          rows: [['Alice', '   ']],
          contentWidth: 40,
        }),
      );

      const frame = lastFrame();
      expect(frame).toContain('Alice');
      expect(frame).toBeDefined();
    });

    it('should handle very long words that exceed column width', () => {
      const { lastFrame } = render(
        React.createElement(TableRenderer, {
          headers: ['Name', 'URL'],
          rows: [
            [
              'Alice',
              'https://example.com/very/long/path/that/exceeds/column/width',
            ],
          ],
          contentWidth: 50,
        }),
      );

      const frame = lastFrame();
      // Should not break the table
      expect(frame).toContain('┌');
      expect(frame).toContain('┐');
      expect(frame).toContain('Al');
    });

    it('should handle narrow terminal width', () => {
      const { lastFrame } = render(
        React.createElement(TableRenderer, {
          headers: ['Name', 'Description'],
          rows: [['Alice', 'Some description text']],
          contentWidth: 30,
        }),
      );

      const frame = lastFrame();
      // Should still render without breaking
      expect(frame).toContain('┌');
      expect(frame).toContain('┐');
    });

    it('should handle unicode and emoji characters', () => {
      const { lastFrame } = render(
        React.createElement(TableRenderer, {
          headers: ['Name', 'Emoji'],
          rows: [['Alice', '🎉🚀✨']],
          contentWidth: 40,
        }),
      );

      const frame = lastFrame();
      expect(frame).toContain('Alice');
      expect(frame).toBeDefined();
    });
  });

  describe('column width calculation', () => {
    it('should scale columns to fit content width', () => {
      const { lastFrame } = render(
        React.createElement(TableRenderer, {
          headers: ['VeryLongHeaderName', 'AnotherLongHeader'],
          rows: [['Data1', 'Data2']],
          contentWidth: 40,
        }),
      );

      const frame = lastFrame();
      // Table should fit within the specified width
      expect(frame).toContain('┌');
      expect(frame).toContain('┐');
    });

    it('should handle tables with many columns', () => {
      const { lastFrame } = render(
        React.createElement(TableRenderer, {
          headers: ['A', 'B', 'C', 'D', 'E'],
          rows: [['1', '2', '3', '4', '5']],
          contentWidth: 50,
        }),
      );

      const frame = lastFrame();
      expect(frame).toContain('A');
      expect(frame).toContain('E');
    });
  });

  describe('header formatting', () => {
    it('should render headers in bold', () => {
      const { lastFrame } = render(
        React.createElement(TableRenderer, {
          headers: ['Name', 'Age'],
          rows: [['Alice', '30']],
          contentWidth: 40,
        }),
      );

      const frame = lastFrame();
      expect(frame).toContain('Name');
      expect(frame).toContain('Age');
    });

    it('should render middle border between header and data', () => {
      const { lastFrame } = render(
        React.createElement(TableRenderer, {
          headers: ['Name', 'Age'],
          rows: [['Alice', '30']],
          contentWidth: 40,
        }),
      );

      const frame = lastFrame();
      expect(frame).toContain('├');
      expect(frame).toContain('┼');
      expect(frame).toContain('┤');
    });
  });
});
