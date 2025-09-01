import { Command } from '../types.js';
import { request } from 'gaxios';

export const pluginsCommand: Command = {
    name: 'plugins',
    description: 'Manage plugins',
    subCommands: [
        {
            name: 'list',
            description: 'List all available plugins',
            async execute() {
                try {
                    const response = await request<{ plugins: any[] }>({
                        url: 'http://localhost:3002/api/plugins',
                        method: 'GET',
                    });

                    const plugins = response.data.plugins;
                    let content = 'Available plugins:\n';
                    plugins.forEach(p => {
                        content += `\n- ${p.name} (${p.id})\n  ${p.description}\n  by ${p.author}\n`;
                    });

                    return {
                        type: 'message',
                        messageType: 'info',
                        content,
                    };
                } catch (error) {
                    return {
                        type: 'message',
                        messageType: 'error',
                        content: `Failed to fetch plugins: ${error.message}`,
                    };
                }
            },
        },
        {
            name: 'install',
            description: 'Install a plugin',
            async execute(context, args) {
                if (!args) {
                    return {
                        type: 'message',
                        messageType: 'error',
                        content: 'Please provide a plugin id to install.',
                    };
                }

                try {
                    await request({
                        url: 'http://localhost:3003/api/users/user123/achievements',
                        method: 'POST',
                        data: {
                            achievementId: 'plugin-enthusiast',
                        },
                    });
                } catch (error) {
                    // Ignore error
                }

                return {
                    type: 'message',
                    messageType: 'info',
                    content: `Installing plugin ${args}... (Not implemented in this MVP)`,
                };
            },
        },
        {
            name: 'uninstall',
            description: 'Uninstall a plugin',
            async execute(context, args) {
                if (!args) {
                    return {
                        type: 'message',
                        messageType: 'error',
                        content: 'Please provide a plugin id to uninstall.',
                    };
                }

                return {
                    type: 'message',
                    messageType: 'info',
                    content: `Uninstalling plugin ${args}... (Not implemented in this MVP)`,
                };
            },
        },
    ],
};
