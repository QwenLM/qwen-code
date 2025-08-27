import { Command } from '../types.js';
import open from 'open';
import path from 'path';

export const learnCommand: Command = {
    name: 'learn',
    description: 'Opens the interactive learning platform',
    async execute() {
        const filePath = path.join(process.cwd(), 'enhancements', 'learning-platform', 'index.html');
        await open(filePath);
        return {
            type: 'exit',
            message: 'Opening the learning platform in your browser...',
        };
    },
};
