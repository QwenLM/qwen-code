import { Command } from '../types.js';
import open from 'open';
import path from 'path';
import { request } from 'gaxios';

export const dashboardCommand: Command = {
    name: 'dashboard',
    description: 'Opens the usage analytics dashboard',
    async execute() {
        const filePath = path.join(process.cwd(), 'enhancements', 'analytics-dashboard', 'public', 'index.html');
        await open(filePath);

        try {
            await request({
                url: 'http://localhost:3003/api/users/user123/achievements',
                method: 'POST',
                data: {
                    achievementId: 'data-driven',
                },
            });
        } catch (error) {
            // Ignore error
        }

        return {
            type: 'exit',
            message: 'Opening the usage analytics dashboard in your browser...',
        };
    },
};
