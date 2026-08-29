// Neutral N-API addon fixture for node_repl tests. Not a real dependency —
// compiled on-demand by node-repl.napi.test.ts to prove the REPL can load a
// native .node addon via createRequire(import.meta.url).
#include <node_api.h>

static napi_value Add(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  double a = 0, b = 0;
  napi_get_value_double(env, argv[0], &a);
  napi_get_value_double(env, argv[1], &b);

  napi_value result;
  napi_create_double(env, a + b, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "add", NAPI_AUTO_LENGTH, Add, NULL, &fn);
  napi_set_named_property(env, exports, "add", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
