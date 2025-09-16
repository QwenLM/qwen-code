/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule, Argv } from 'yargs';
import { listSessions, deleteSession, sessionExists, loadSession } from '../utils/sessionManager.js';

const listCommand: CommandModule = {
  command: 'list',
  aliases: ['ls'],
  describe: 'List all available sessions',
  handler: async () => {
    try {
      const sessions = await listSessions();
      if (sessions.length === 0) {
        console.log('No sessions found.');
        return;
      }

      console.log('Available sessions:');
      console.log('===================');
      for (const session of sessions) {
        const createdDate = new Date(session.createdAt).toLocaleString();
        const updatedDate = new Date(session.lastUpdated).toLocaleString();
        const historyCount = session.history.length;
        
        console.log(`\nSession ID: ${session.sessionId}`);
        console.log(`  Created: ${createdDate}`);
        console.log(`  Last Updated: ${updatedDate}`);
        console.log(`  Messages: ${historyCount}`);
        console.log(`  Project: ${session.projectRoot}`);
      }
    } catch (error) {
      console.error('Error listing sessions:', error);
      process.exit(1);
    }
  },
};

const deleteCommand: CommandModule = {
  command: 'delete <sessionId>',
  aliases: ['rm'],
  describe: 'Delete a specific session',
  builder: (yargs) =>
    yargs.positional('sessionId', {
      describe: 'Session ID to delete',
      type: 'string',
      demandOption: true,
    }),
  handler: async (argv) => {
    const sessionId = argv['sessionId'] as string;
    try {
      const exists = await sessionExists(sessionId);
      if (!exists) {
        console.error(`Session '${sessionId}' not found.`);
        process.exit(1);
      }

      const success = await deleteSession(sessionId);
      if (success) {
        console.log(`Session '${sessionId}' deleted successfully.`);
      } else {
        console.error(`Failed to delete session '${sessionId}'.`);
        process.exit(1);
      }
    } catch (error) {
      console.error('Error deleting session:', error);
      process.exit(1);
    }
  },
};

const infoCommand: CommandModule = {
  command: 'info <sessionId>',
  describe: 'Show detailed information about a specific session',
  builder: (yargs) =>
    yargs.positional('sessionId', {
      describe: 'Session ID to show info for',
      type: 'string',
      demandOption: true,
    }),
  handler: async (argv) => {
    const sessionId = argv['sessionId'] as string;
    try {
      const session = await loadSession(sessionId);
      
      if (!session) {
        console.error(`Session '${sessionId}' not found.`);
        process.exit(1);
      }

      const createdDate = new Date(session.createdAt).toLocaleString();
      const updatedDate = new Date(session.lastUpdated).toLocaleString();
      
      console.log(`Session Information:`);
      console.log(`===================`);
      console.log(`Session ID: ${session.sessionId}`);
      console.log(`Created: ${createdDate}`);
      console.log(`Last Updated: ${updatedDate}`);
      console.log(`Project Root: ${session.projectRoot}`);
      console.log(`Message Count: ${session.history.length}`);
      
      if (session.history.length > 0) {
        console.log(`\nConversation History:`);
        console.log(`--------------------`);
        session.history.forEach((message, index) => {
          const role = message.role === 'user' ? 'User' : 'Assistant';
          const parts = message.parts || [];
          const textParts = parts.filter(part => 'text' in part && part.text);
          if (textParts.length > 0) {
            const text = textParts.map(part => 'text' in part ? part.text : '').join(' ');
            const preview = text.length > 100 ? text.substring(0, 100) + '...' : text;
            console.log(`${index + 1}. ${role}: ${preview}`);
          }
        });
      }
    } catch (error) {
      console.error('Error showing session info:', error);
      process.exit(1);
    }
  },
};

export const sessionCommand: CommandModule = {
  command: 'session',
  describe: 'Manage conversation sessions',
  builder: (yargs: Argv) =>
    yargs
      .command(listCommand)
      .command(deleteCommand)
      .command(infoCommand)
      .demandCommand(1, 'You need at least one subcommand before continuing.')
      .version(false),
  handler: () => {
    // yargs will automatically show help if no subcommand is provided
    // thanks to demandCommand(1) in the builder.
  },
};