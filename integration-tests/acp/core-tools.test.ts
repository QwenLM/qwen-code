/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AcpTestRig } from './test-helper.js';

describe('core tools', () => {
  let rig: AcpTestRig;

  beforeEach(async () => {
    rig = new AcpTestRig();
  });

  afterEach(async () => {
    await rig.disconnect();
    await rig.cleanup();
  });

  describe('write_file', () => {
    it('should create a new file with content', async () => {
      await rig.setup('write-file-create', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      await rig.prompt([
        {
          type: 'text',
          text: 'Create a file called hello.txt with content "Hello World"',
        },
      ]);

      // Wait for write_file tool call
      const toolCall = await rig.waitForToolCall('write_file', 30000);
      expect(toolCall.status).toBe('success');

      // Verify file content
      const content = rig.readFile('hello.txt');
      expect(content.trim()).toBe('Hello World');
    });

    it('should create a file with JSON content', async () => {
      await rig.setup('write-file-json', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      await rig.prompt([
        {
          type: 'text',
          text: 'Create a file called data.json with the JSON content {"name": "test", "value": 42}',
        },
      ]);

      const toolCall = await rig.waitForToolCall('write_file', 30000);
      expect(toolCall.status).toBe('success');

      const content = rig.readFile('data.json');
      const json = JSON.parse(content);
      expect(json.name).toBe('test');
      expect(json.value).toBe(42);
    });

    it('should create a file in a subdirectory', async () => {
      await rig.setup('write-file-subdir', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      rig.mkdir('src');

      await rig.prompt([
        {
          type: 'text',
          text: 'Create a file at src/main.js with content "console.log(\\"hello\\")"',
        },
      ]);

      const toolCall = await rig.waitForToolCall('write_file', 30000);
      expect(toolCall.status).toBe('success');

      const content = rig.readFile('src/main.js');
      expect(content).toContain('console.log');
    });
  });

  describe('read_file', () => {
    it('should read file content', async () => {
      await rig.setup('read-file', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      // Create a file first
      rig.createFile('sample.txt', 'Sample content for reading');

      await rig.prompt([
        {
          type: 'text',
          text: 'Read the file sample.txt and tell me its content',
        },
      ]);

      const toolCall = await rig.waitForToolCall('read_file', 30000);
      expect(toolCall.status).toBe('success');
    });
  });

  describe('edit', () => {
    it('should replace text in a file', async () => {
      await rig.setup('edit-replace', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      // Create a file with initial content
      rig.createFile('to-edit.txt', 'Hello World, this is a test file.');

      await rig.prompt([
        {
          type: 'text',
          text: 'In the file to-edit.txt, replace "World" with "Universe"',
        },
      ]);

      const toolCall = await rig.waitForToolCall('edit', 30000);
      expect(toolCall.status).toBe('success');

      const content = rig.readFile('to-edit.txt');
      expect(content).toContain('Hello Universe');
    });

    it('should perform multi-line edits', async () => {
      await rig.setup('edit-multi-line', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      rig.createFile('multiline.txt', 'Line 1\nLine 2\nLine 3\nLine 4');

      await rig.prompt([
        {
          type: 'text',
          text: 'In the file multiline.txt, replace "Line 2\nLine 3" with "New Line 2\nNew Line 3"',
        },
      ]);

      const toolCall = await rig.waitForToolCall('edit', 30000);
      expect(toolCall.status).toBe('success');
    });
  });

  describe('glob', () => {
    it('should find files matching pattern', async () => {
      await rig.setup('glob-pattern', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      // Create some test files
      rig.createFile('src/file1.ts', 'content');
      rig.createFile('src/file2.ts', 'content');
      rig.createFile('src/file3.js', 'content');

      await rig.prompt([
        {
          type: 'text',
          text: 'Use glob to find all .ts files in the src directory',
        },
      ]);

      const toolCall = await rig.waitForToolCall('glob', 30000);
      expect(toolCall.status).toBe('success');
    });
  });

  describe('grep', () => {
    it('should search for text in files', async () => {
      await rig.setup('grep-search', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      // Create files with searchable content
      rig.createFile(
        'file-a.txt',
        'The quick brown fox jumps over the lazy dog',
      );
      rig.createFile('file-b.txt', 'The lazy dog sleeps all day');

      await rig.prompt([
        {
          type: 'text',
          text: 'Use grep to find files containing "lazy dog"',
        },
      ]);

      const toolCall = await rig.waitForToolCall('grep', 30000);
      expect(toolCall.status).toBe('success');
    });

    it('should support regex patterns', async () => {
      await rig.setup('grep-regex', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      rig.createFile('numbers.txt', 'Phone: 123-456-7890\nPhone: 987-654-3210');

      await rig.prompt([
        {
          type: 'text',
          text: 'Use grep with a regex pattern to find phone numbers',
        },
      ]);

      const toolCall = await rig.waitForToolCall('grep', 30000);
      expect(toolCall.status).toBe('success');
    });
  });

  describe('ls', () => {
    it('should list directory contents', async () => {
      await rig.setup('ls-directory', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      // Create directory structure
      rig.mkdir('test-dir');
      rig.createFile('test-dir/file1.txt', 'content1');
      rig.createFile('test-dir/file2.txt', 'content2');

      await rig.prompt([
        {
          type: 'text',
          text: 'List the contents of the test-dir directory',
        },
      ]);

      const toolCall = await rig.waitForToolCall('ls', 30000);
      expect(toolCall.status).toBe('success');
    });

    it('should list current directory when no path specified', async () => {
      await rig.setup('ls-current', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      rig.createFile('visible-file.txt', 'content');

      await rig.prompt([
        {
          type: 'text',
          text: 'List all files in the current directory',
        },
      ]);

      const toolCall = await rig.waitForToolCall('ls', 30000);
      expect(toolCall.status).toBe('success');
    });
  });

  describe('shell', () => {
    it('should execute a simple command', async () => {
      await rig.setup('shell-simple', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      await rig.prompt([
        {
          type: 'text',
          text: 'Run a shell command to echo "Hello from shell"',
        },
      ]);

      const toolCall = await rig.waitForToolCall('shell', 30000);
      expect(toolCall.status).toBe('success');
    });

    it('should capture command output', async () => {
      await rig.setup('shell-output', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      rig.createFile('test-file.txt', 'test content');

      await rig.prompt([
        {
          type: 'text',
          text: 'Run "cat test-file.txt" to read the file content',
        },
      ]);

      const toolCall = await rig.waitForToolCall('shell', 30000);
      expect(toolCall.status).toBe('success');
    });
  });

  describe('todoWrite', () => {
    it('should create a todo list', async () => {
      await rig.setup('todo-write', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      await rig.prompt([
        {
          type: 'text',
          text: 'Create a todo list with three items: plan, implement, test',
        },
      ]);

      const toolCall = await rig.waitForToolCall('todoWrite', 30000);
      expect(toolCall.status).toBe('success');
    });
  });

  describe('tool combination scenarios', () => {
    it('should use multiple tools in sequence', async () => {
      await rig.setup('multi-tool', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      await rig.prompt([
        {
          type: 'text',
          text: 'First list the current directory, then create a file called result.txt with the listing output',
        },
      ]);

      // Wait for ls tool
      const lsCall = await rig.waitForToolCall('ls', 30000);
      expect(lsCall.status).toBe('success');

      // Wait for write_file tool
      const writeCall = await rig.waitForToolCall('write_file', 30000);
      expect(writeCall.status).toBe('success');

      // Verify result file exists
      expect(rig.fileExists('result.txt')).toBe(true);
    });

    it('should handle file operations workflow', async () => {
      await rig.setup('file-workflow', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      // Create source file
      rig.createFile('source.txt', 'Original content that needs editing');

      await rig.prompt([
        {
          type: 'text',
          text: 'Read source.txt, then edit it to replace "Original" with "Updated", and finally read it again to confirm',
        },
      ]);

      // Wait for the read operation
      const readCall = await rig.waitForToolCall('read_file', 30000);
      expect(readCall.status).toBe('success');

      // Wait for the edit operation
      const editCall = await rig.waitForToolCall('edit', 30000);
      expect(editCall.status).toBe('success');
    });
  });
});
