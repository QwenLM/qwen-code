export const JSONRPC_VERSION = '2.0' as const;

export const AGENT_METHODS = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  session_new: 'session/new',
  session_prompt: 'session/prompt',
  session_cancel: 'session/cancel',
  session_set_mode: 'session/set_mode',
  session_set_model: 'session/set_model',
};

export const CLIENT_METHODS = {
  session_update: 'session/update',
  authenticate_update: 'authenticate/update',
  session_request_permission: 'session/request_permission',
  fs_read_text_file: 'fs/read_text_file',
  fs_write_text_file: 'fs/write_text_file',
};
