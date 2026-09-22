// Force strict mode and setup for ESM
"use strict";
import {
  require_extension,
  require_permessage_deflate,
  require_receiver,
  require_sender,
  require_stream,
  require_subprotocol,
  require_websocket,
  require_websocket_server
} from "./chunk-RVIGZBIT.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __toESM
} from "./chunk-J2S4EL5Y.js";

// node_modules/ws/wrapper.mjs
init_esbuild_shims();
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);
var wrapper_default = import_websocket.default;

export {
  import_stream,
  import_extension,
  import_permessage_deflate,
  import_receiver,
  import_sender,
  import_subprotocol,
  import_websocket,
  import_websocket_server,
  wrapper_default
};
