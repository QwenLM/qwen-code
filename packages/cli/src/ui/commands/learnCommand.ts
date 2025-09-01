import { Command } from '../types.js';
import open from 'open';
import path from 'path';
import { request } from 'gaxios';

export const learnCommand: Command = {
    name: 'learn',
    description: 'Opens the interactive learning platform',
    async execute() {
        const filePath = path.join(process.cwd(), 'enhancements', 'learning-platform', 'index.html');
        await open(filePath);

        try {
            await request({
                url: 'http://localhost:3003/api/users/user123/achievements',
                method: 'POST',
                data: {
                    achievementId: 'knowledge-seeker',
                },
            });
        } catch (error) {
            // Ignore error
        }

        return {
            type: 'exit',
            message: 'Opening the learning platform in your browser...',
        };
    },
};
