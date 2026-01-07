import type { JSONSchema7 } from 'json-schema';

export const lspSettingsSchema: JSONSchema7 = {
  type: 'object',
  properties: {
    'lsp.enabled': {
      type: 'boolean',
      default: true,
      description: '启用 LSP 语言服务器协议支持'
    },
    'lsp.allowed': {
      type: 'array',
      items: {
        type: 'string'
      },
      default: [],
      description: '允许运行的 LSP 服务器列表'
    },
    'lsp.excluded': {
      type: 'array',
      items: {
        type: 'string'
      },
      default: [],
      description: '禁止运行的 LSP 服务器列表'
    },
    'lsp.autoDetect': {
      type: 'boolean',
      default: true,
      description: '自动检测项目语言并启动相应 LSP 服务器'
    },
    'lsp.serverTimeout': {
      type: 'number',
      default: 10000,
      description: 'LSP 服务器启动超时时间（毫秒）'
    }
  }
};