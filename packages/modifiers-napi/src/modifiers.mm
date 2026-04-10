#import <napi.h>
#import <CoreGraphics/CoreGraphics.h>

/**
 * Check if a specific modifier key is currently pressed.
 * Uses CGEventSourceFlagsState to read the current HID state
 * of modifier keys without requiring accessibility permissions.
 *
 * Supported modifiers: "shift", "control", "option", "command"
 */
static Napi::Boolean IsModifierPressed(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "Expected a string argument (modifier name)")
        .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  std::string modifier = info[0].As<Napi::String>().Utf8Value();

  CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState);

  bool pressed = false;

  if (modifier == "shift") {
    pressed = (flags & kCGEventFlagMaskShift) != 0;
  } else if (modifier == "control") {
    pressed = (flags & kCGEventFlagMaskControl) != 0;
  } else if (modifier == "option") {
    pressed = (flags & kCGEventFlagMaskAlternate) != 0;
  } else if (modifier == "command") {
    pressed = (flags & kCGEventFlagMaskCommand) != 0;
  }

  return Napi::Boolean::New(env, pressed);
}

/**
 * Pre-warm: a no-op that forces the native module to be loaded into memory.
 * This ensures the first real call to isModifierPressed doesn't have
 * module-loading latency.
 */
static Napi::Value Prewarm(const Napi::CallbackInfo& info) {
  return info.Env().Undefined();
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isModifierPressed",
              Napi::Function::New(env, IsModifierPressed, "isModifierPressed"));
  exports.Set("prewarm",
              Napi::Function::New(env, Prewarm, "prewarm"));
  return exports;
}

NODE_API_MODULE(modifiers_napi, Init)
