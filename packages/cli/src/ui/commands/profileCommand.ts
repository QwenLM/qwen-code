import { Command } from '../types.js';
import { request } from 'gaxios';

export const profileCommand: Command = {
    name: 'profile',
    description: 'Displays your gamification profile',
    async execute() {
        try {
            const profileResponse = await request<{ points: number, achievements: string[] }>({
                url: 'http://localhost:3003/api/users/user123',
                method: 'GET',
            });

            const leaderboardResponse = await request<any[]>({
                url: 'http://localhost:3003/api/leaderboard',
                method: 'GET',
            });

            const profile = profileResponse.data;
            const leaderboard = leaderboardResponse.data;
            const rank = leaderboard.findIndex(u => u.username === 'user123') + 1;

            let content = `Your Profile:\n\n`;
            content += `Points: ${profile.points}\n`;
            content += `Rank: ${rank > 0 ? rank : 'Unranked'}\n`;
            content += `Achievements: \n- ${profile.achievements.join('\n- ')}\n`;

            return {
                type: 'message',
                messageType: 'info',
                content,
            };
        } catch (error) {
            return {
                type: 'message',
                messageType: 'error',
                content: `Failed to fetch your profile: ${error.message}`,
            };
        }
    },
};
