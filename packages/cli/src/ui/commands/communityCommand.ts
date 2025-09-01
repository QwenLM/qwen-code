import { Command } from '../types.js';
import open from 'open';

export const communityCommand: Command = {
    name: 'community',
    description: 'Opens the community hub',
    async execute() {
        const url = 'http://localhost:3001';
        await open(url);
        return {
            type: 'exit',
            message: `Opening the community hub in your browser: ${url}`,
        };
    },
};
