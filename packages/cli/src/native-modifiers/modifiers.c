/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

#include <CoreGraphics/CoreGraphics.h>
#include <node_api.h>
#include <stdbool.h>
#include <string.h>

static CGEventFlags current_flags(void) {
  return CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
}

static bool modifier_mask(const char *name, CGEventFlags *mask) {
  if (strcmp(name, "shift") == 0) {
    *mask = kCGEventFlagMaskShift;
    return true;
  }
  if (strcmp(name, "ctrl") == 0) {
    *mask = kCGEventFlagMaskControl;
    return true;
  }
  if (strcmp(name, "alt") == 0) {
    *mask = kCGEventFlagMaskAlternate;
    return true;
  }
  if (strcmp(name, "cmd") == 0) {
    *mask = kCGEventFlagMaskCommand;
    return true;
  }
  return false;
}

static napi_value is_modifier_pressed(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 1) {
    napi_throw_type_error(env, NULL, "Expected one modifier name");
    return NULL;
  }

  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) {
    napi_throw_type_error(env, NULL, "Modifier name must be a string");
    return NULL;
  }

  char name[16];
  size_t length = 0;
  if (napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &length) !=
      napi_ok) {
    napi_throw_error(env, NULL, "Could not read modifier name");
    return NULL;
  }

  CGEventFlags mask = 0;
  if (!modifier_mask(name, &mask)) {
    napi_throw_range_error(env, NULL, "Unknown modifier name");
    return NULL;
  }

  napi_value result;
  napi_get_boolean(env, (current_flags() & mask) != 0, &result);
  return result;
}

static void set_modifier_property(napi_env env, napi_value object,
                                  const char *name, CGEventFlags flags,
                                  CGEventFlags mask) {
  napi_value value;
  napi_get_boolean(env, (flags & mask) != 0, &value);
  napi_set_named_property(env, object, name, value);
}

static napi_value get_modifiers(napi_env env, napi_callback_info info) {
  (void)info;
  CGEventFlags flags = current_flags();
  napi_value result;
  napi_create_object(env, &result);
  set_modifier_property(env, result, "shift", flags, kCGEventFlagMaskShift);
  set_modifier_property(env, result, "ctrl", flags, kCGEventFlagMaskControl);
  set_modifier_property(env, result, "alt", flags, kCGEventFlagMaskAlternate);
  set_modifier_property(env, result, "cmd", flags, kCGEventFlagMaskCommand);
  return result;
}

static napi_value prewarm(napi_env env, napi_callback_info info) {
  (void)info;
  (void)current_flags();
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"isModifierPressed", NULL, is_modifier_pressed, NULL, NULL, NULL,
       napi_default, NULL},
      {"getModifiers", NULL, get_modifiers, NULL, NULL, NULL, napi_default,
       NULL},
      {"prewarm", NULL, prewarm, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(
      env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(modifiers, initialize)
