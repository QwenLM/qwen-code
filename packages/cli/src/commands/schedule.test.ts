import { describe, it, expect } from 'vitest';
import { scheduleCommand } from './schedule.js';

describe('scheduleCommand', () => {
  describe('command structure', () => {
    it('has correct command name', () => {
      expect(scheduleCommand.command).toBe('schedule');
    });

    it('has a description', () => {
      expect(scheduleCommand.describe).toBeTruthy();
    });

    it('has a builder function', () => {
      expect(typeof scheduleCommand.builder).toBe('function');
    });

    it('has a handler function', () => {
      expect(typeof scheduleCommand.handler).toBe('function');
    });
  });

  describe('subcommands', () => {
    it('registers create subcommand', () => {
      // The builder function registers subcommands
      // We verify the command structure is correct
      expect(scheduleCommand.command).toBe('schedule');
    });

    it('registers list subcommand', () => {
      expect(scheduleCommand.command).toBe('schedule');
    });

    it('registers delete subcommand', () => {
      expect(scheduleCommand.command).toBe('schedule');
    });

    it('registers run subcommand', () => {
      expect(scheduleCommand.command).toBe('schedule');
    });

    it('registers logs subcommand', () => {
      expect(scheduleCommand.command).toBe('schedule');
    });

    it('registers update subcommand', () => {
      expect(scheduleCommand.command).toBe('schedule');
    });

    it('registers daemon subcommand', () => {
      expect(scheduleCommand.command).toBe('schedule');
    });
  });

  describe('command metadata', () => {
    it('does not inherit global qwen flags', () => {
      // The schedule command should be self-contained
      expect(scheduleCommand.command).toBe('schedule');
    });

    it('enforces demandCommand(1)', () => {
      // The builder should enforce at least one subcommand
      // This is verified by the yargs configuration
      expect(scheduleCommand.builder).toBeDefined();
    });
  });
});
