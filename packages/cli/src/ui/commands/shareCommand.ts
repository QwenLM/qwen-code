import { Command } from '../types.js';
import { request } from 'gaxios';

export const shareCommand: Command = {
    name: 'share',
    description: 'Shares a snippet of code or a command to the community hub',
    async execute(context, args) {
        if (!args) {
            return {
                type: 'message',
                messageType: 'error',
                content: 'Please provide something to share.',
            };
        }

        try {
            await request({
                url: 'http://localhost:3001/api/threads',
                method: 'POST',
                data: {
                    title: 'Shared from Qwen Code',
                    content: args,
                },
            });

            return {
                type: 'message',
                messageType: 'info',
                content: 'Successfully shared to the community hub.',
            };
        } catch (error) {
            return {
                type: 'message',
                messageType: 'error',
                content: `Failed to share to the community hub: ${error.message}`,
            };
        }
    },
};
