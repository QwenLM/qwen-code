#include <node_api.h>

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include <algorithm>
#include <cmath>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr size_t kMaxAccessibilityBytes = 32000;
constexpr size_t kMaxAccessibilityNodes = 1200;
constexpr size_t kMaxAccessibilityDepth = 12;
constexpr size_t kMaxChildrenPerNode = 200;
constexpr size_t kMaxAttributeBytes = 500;

struct WindowTarget {
  CGWindowID window_id;
  pid_t pid;
  CGRect bounds;
  std::string app_name;
  std::string bundle_identifier;
  std::string title;
};

struct TreeState {
  std::string text;
  size_t nodes = 0;
  bool truncated = false;
};

struct AsyncCaptureWork {
  napi_deferred deferred;
  napi_async_work work = nullptr;
  std::optional<WindowTarget> target;
  std::vector<uint8_t> screenshot;
  std::string accessibility_text;
  std::string error;
};

std::string ToUtf8(CFStringRef value) {
  if (value == nullptr) return {};
  const CFIndex length = CFStringGetLength(value);
  const CFIndex capacity =
      CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  if (capacity <= 1) return {};
  std::vector<char> buffer(static_cast<size_t>(capacity));
  if (!CFStringGetCString(value, buffer.data(), capacity,
                          kCFStringEncodingUTF8)) {
    return {};
  }
  return std::string(buffer.data());
}

std::string NormalizeText(std::string value, size_t maximum) {
  for (char& character : value) {
    if (character == '\n' || character == '\r' || character == '\t') {
      character = ' ';
    }
  }
  std::string normalized;
  normalized.reserve(std::min(value.size(), maximum));
  bool previous_space = false;
  for (const char character : value) {
    const bool is_space = character == ' ';
    if (is_space && previous_space) continue;
    if (normalized.size() >= maximum) break;
    normalized.push_back(character);
    previous_space = is_space;
  }
  return normalized;
}

std::string NSStringValue(NSString* value, size_t maximum) {
  if (value == nil) return {};
  return NormalizeText(std::string(value.UTF8String ?: ""), maximum);
}

std::optional<WindowTarget> FindForegroundWindow() {
  CFArrayRef window_info = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  if (window_info == nullptr) return std::nullopt;
  NSArray* windows = CFBridgingRelease(window_info);
  const pid_t own_pid = getpid();
  for (NSDictionary* window in windows) {
    NSNumber* layer = window[(__bridge NSString*)kCGWindowLayer];
    NSNumber* pid_value = window[(__bridge NSString*)kCGWindowOwnerPID];
    NSNumber* window_id = window[(__bridge NSString*)kCGWindowNumber];
    NSNumber* alpha = window[(__bridge NSString*)kCGWindowAlpha];
    NSNumber* sharing = window[(__bridge NSString*)kCGWindowSharingState];
    NSDictionary* bounds_value = window[(__bridge NSString*)kCGWindowBounds];
    if (layer.intValue != 0 || pid_value.intValue <= 0 ||
        pid_value.intValue == own_pid || window_id.unsignedIntValue == 0 ||
        alpha.doubleValue <= 0 || sharing.intValue == 0 ||
        ![bounds_value isKindOfClass:[NSDictionary class]]) {
      continue;
    }

    CGRect bounds = CGRectZero;
    if (!CGRectMakeWithDictionaryRepresentation(
            (__bridge CFDictionaryRef)bounds_value, &bounds) ||
        bounds.size.width < 80 || bounds.size.height < 80) {
      continue;
    }

    NSString* owner = window[(__bridge NSString*)kCGWindowOwnerName];
    NSString* title = window[(__bridge NSString*)kCGWindowName];
    const std::string app_name = NSStringValue(owner, 512);
    if (app_name.empty() || app_name == "Qwen Live Host" ||
        app_name == "Window Server" || app_name == "Dock") {
      continue;
    }

    NSRunningApplication* application =
        [NSRunningApplication runningApplicationWithProcessIdentifier:
                                  pid_value.intValue];
    const std::string localized_name =
        NSStringValue(application.localizedName, 512);
    const std::string bundle_identifier =
        NSStringValue(application.bundleIdentifier, 512);
    return WindowTarget{
        .window_id = static_cast<CGWindowID>(window_id.unsignedIntValue),
        .pid = static_cast<pid_t>(pid_value.intValue),
        .bounds = bounds,
        .app_name = localized_name.empty() ? app_name : localized_name,
        .bundle_identifier = bundle_identifier,
        .title = NSStringValue(title, 2048),
    };
  }
  return std::nullopt;
}

CFTypeRef CopyAttribute(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef value = nullptr;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess) {
    return nullptr;
  }
  return value;
}

std::string StringAttribute(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef value = CopyAttribute(element, attribute);
  if (value == nullptr) return {};
  std::string result;
  if (CFGetTypeID(value) == CFStringGetTypeID()) {
    result = NormalizeText(ToUtf8(static_cast<CFStringRef>(value)),
                           kMaxAttributeBytes);
  }
  CFRelease(value);
  return result;
}

std::string ValueSummary(CFTypeRef value) {
  if (value == nullptr) return {};
  const CFTypeID type = CFGetTypeID(value);
  if (type == CFStringGetTypeID()) {
    return NormalizeText(ToUtf8(static_cast<CFStringRef>(value)),
                         kMaxAttributeBytes);
  }
  if (type == CFBooleanGetTypeID()) {
    return CFBooleanGetValue(static_cast<CFBooleanRef>(value)) ? "true"
                                                               : "false";
  }
  if (type == CFNumberGetTypeID()) {
    double number = 0;
    if (CFNumberGetValue(static_cast<CFNumberRef>(value), kCFNumberDoubleType,
                         &number)) {
      std::ostringstream stream;
      stream << number;
      return stream.str();
    }
  }
  if (type == AXValueGetTypeID()) {
    const AXValueType value_type = AXValueGetType(static_cast<AXValueRef>(value));
    std::ostringstream stream;
    if (value_type == kAXValueCGPointType) {
      CGPoint point = CGPointZero;
      if (AXValueGetValue(static_cast<AXValueRef>(value), value_type, &point)) {
        stream << std::lround(point.x) << ',' << std::lround(point.y);
        return stream.str();
      }
    }
    if (value_type == kAXValueCGSizeType) {
      CGSize size = CGSizeZero;
      if (AXValueGetValue(static_cast<AXValueRef>(value), value_type, &size)) {
        stream << std::lround(size.width) << 'x' << std::lround(size.height);
        return stream.str();
      }
    }
  }
  return {};
}

void AppendLine(TreeState& state, size_t depth, const std::string& line) {
  if (state.text.size() >= kMaxAccessibilityBytes) {
    state.truncated = true;
    return;
  }
  std::string rendered(depth * 2, ' ');
  rendered += "- ";
  rendered += line;
  rendered += '\n';
  if (state.text.size() + rendered.size() > kMaxAccessibilityBytes) {
    state.truncated = true;
    return;
  }
  state.text += rendered;
}

void AppendElement(AXUIElementRef element, size_t depth, TreeState& state) {
  if (element == nullptr || depth > kMaxAccessibilityDepth ||
      state.nodes >= kMaxAccessibilityNodes || state.truncated) {
    state.truncated = true;
    return;
  }
  state.nodes += 1;
  std::string role = StringAttribute(element, kAXRoleAttribute);
  std::string subrole = StringAttribute(element, kAXSubroleAttribute);
  std::string title = StringAttribute(element, kAXTitleAttribute);
  std::string description = StringAttribute(element, kAXDescriptionAttribute);
  std::string identifier = StringAttribute(element, kAXIdentifierAttribute);

  CFTypeRef value = CopyAttribute(element, kAXValueAttribute);
  std::string value_summary = ValueSummary(value);
  if (value != nullptr) CFRelease(value);
  CFTypeRef position = CopyAttribute(element, kAXPositionAttribute);
  std::string position_summary = ValueSummary(position);
  if (position != nullptr) CFRelease(position);
  CFTypeRef size = CopyAttribute(element, kAXSizeAttribute);
  std::string size_summary = ValueSummary(size);
  if (size != nullptr) CFRelease(size);

  std::ostringstream line;
  line << (role.empty() ? "AXElement" : role);
  if (!subrole.empty()) line << '/' << subrole;
  if (!title.empty()) line << " title=\"" << title << '"';
  if (!description.empty() && description != title) {
    line << " description=\"" << description << '"';
  }
  if (!value_summary.empty() && value_summary != title &&
      value_summary != description) {
    line << " value=\"" << value_summary << '"';
  }
  if (!identifier.empty()) line << " id=\"" << identifier << '"';
  if (!position_summary.empty() || !size_summary.empty()) {
    line << " [" << position_summary;
    if (!position_summary.empty() && !size_summary.empty()) line << ' ';
    line << size_summary << ']';
  }
  AppendLine(state, depth, line.str());

  CFTypeRef children_value = CopyAttribute(element, kAXChildrenAttribute);
  if (children_value == nullptr) return;
  if (CFGetTypeID(children_value) == CFArrayGetTypeID()) {
    CFArrayRef children = static_cast<CFArrayRef>(children_value);
    const CFIndex count = std::min<CFIndex>(
        CFArrayGetCount(children), static_cast<CFIndex>(kMaxChildrenPerNode));
    for (CFIndex index = 0; index < count && !state.truncated; index += 1) {
      CFTypeRef child = CFArrayGetValueAtIndex(children, index);
      if (child != nullptr && CFGetTypeID(child) == AXUIElementGetTypeID()) {
        AppendElement(static_cast<AXUIElementRef>(const_cast<void*>(child)),
                      depth + 1, state);
      }
    }
    if (CFArrayGetCount(children) > count) state.truncated = true;
  }
  CFRelease(children_value);
}

std::string CaptureAccessibilityTree(const WindowTarget& target) {
  AXUIElementRef application = AXUIElementCreateApplication(target.pid);
  if (application == nullptr) return {};
  AXUIElementSetMessagingTimeout(application, 3.0f);
  AXUIElementRef root = nullptr;
  CFTypeRef focused = CopyAttribute(application, kAXFocusedWindowAttribute);
  if (focused != nullptr && CFGetTypeID(focused) == AXUIElementGetTypeID()) {
    root = static_cast<AXUIElementRef>(focused);
  } else if (focused != nullptr) {
    CFRelease(focused);
  }
  if (root == nullptr) {
    CFTypeRef windows_value = CopyAttribute(application, kAXWindowsAttribute);
    if (windows_value != nullptr &&
        CFGetTypeID(windows_value) == CFArrayGetTypeID() &&
        CFArrayGetCount(static_cast<CFArrayRef>(windows_value)) > 0) {
      CFTypeRef first =
          CFArrayGetValueAtIndex(static_cast<CFArrayRef>(windows_value), 0);
      if (first != nullptr && CFGetTypeID(first) == AXUIElementGetTypeID()) {
        root = static_cast<AXUIElementRef>(const_cast<void*>(first));
        CFRetain(root);
      }
    }
    if (windows_value != nullptr) CFRelease(windows_value);
  }

  TreeState state;
  std::ostringstream application_line;
  application_line << "Application \"" << target.app_name << '"';
  if (!target.bundle_identifier.empty()) {
    application_line << " (" << target.bundle_identifier << ')';
  }
  AppendLine(state, 0, application_line.str());
  if (root != nullptr) {
    AppendElement(root, 1, state);
    CFRelease(root);
  }
  CFRelease(application);
  if (state.truncated && state.text.size() + 16 <= kMaxAccessibilityBytes) {
    state.text += "- [truncated]\n";
  }
  return state.text;
}

CGImageRef CaptureWithScreenCaptureKit(const WindowTarget& target) {
  if (@available(macOS 14.0, *)) {
    dispatch_semaphore_t content_semaphore = dispatch_semaphore_create(0);
    __block SCShareableContent* shareable_content = nil;
    [SCShareableContent
        getShareableContentExcludingDesktopWindows:YES
                               onScreenWindowsOnly:YES
                                  completionHandler:^(SCShareableContent* content,
                                                      NSError*) {
                                    shareable_content = content;
                                    dispatch_semaphore_signal(
                                        content_semaphore);
                                  }];
    if (dispatch_semaphore_wait(
            content_semaphore,
            dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) != 0 ||
        shareable_content == nil) {
      return nullptr;
    }

    SCWindow* selected_window = nil;
    for (SCWindow* window in shareable_content.windows) {
      if (window.windowID == target.window_id) {
        selected_window = window;
        break;
      }
    }
    if (selected_window == nil) return nullptr;

    SCContentFilter* filter =
        [[SCContentFilter alloc] initWithDesktopIndependentWindow:selected_window];
    SCStreamConfiguration* configuration = [[SCStreamConfiguration alloc] init];
    const CGFloat longest_edge =
        std::max(selected_window.frame.size.width,
                 selected_window.frame.size.height);
    const CGFloat scale = longest_edge > 1920 ? 3840 / longest_edge : 2;
    configuration.width = static_cast<size_t>(std::max<CGFloat>(
        1, std::round(selected_window.frame.size.width * scale)));
    configuration.height = static_cast<size_t>(std::max<CGFloat>(
        1, std::round(selected_window.frame.size.height * scale)));
    configuration.showsCursor = NO;
    configuration.capturesAudio = NO;
    configuration.ignoreShadowsSingleWindow = YES;

    dispatch_semaphore_t capture_semaphore = dispatch_semaphore_create(0);
    NSLock* capture_lock = [[NSLock alloc] init];
    __block BOOL accepting_capture = YES;
    __block CGImageRef captured_image = nullptr;
    [SCScreenshotManager
        captureImageWithFilter:filter
                 configuration:configuration
              completionHandler:^(CGImageRef image, NSError*) {
                [capture_lock lock];
                if (accepting_capture && image != nullptr) {
                  captured_image = CGImageRetain(image);
                }
                [capture_lock unlock];
                dispatch_semaphore_signal(capture_semaphore);
              }];
    if (dispatch_semaphore_wait(
            capture_semaphore,
            dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
      [capture_lock lock];
      accepting_capture = NO;
      if (captured_image != nullptr) CGImageRelease(captured_image);
      captured_image = nullptr;
      [capture_lock unlock];
      return nullptr;
    }
    return captured_image;
  }
  return nullptr;
}

std::vector<uint8_t> CapturePng(const WindowTarget& target) {
  CGImageRef image = nullptr;
  if (@available(macOS 14.0, *)) {
    image = CaptureWithScreenCaptureKit(target);
  } else {
    image = CGWindowListCreateImage(
        CGRectNull, kCGWindowListOptionIncludingWindow, target.window_id,
        kCGWindowImageBoundsIgnoreFraming | kCGWindowImageBestResolution);
  }
  if (image == nullptr) return {};
  CFMutableDataRef data = CFDataCreateMutable(kCFAllocatorDefault, 0);
  CGImageDestinationRef destination = CGImageDestinationCreateWithData(
      data, CFSTR("public.png"), 1, nullptr);
  if (destination == nullptr) {
    CFRelease(data);
    CGImageRelease(image);
    return {};
  }
  CGImageDestinationAddImage(destination, image, nullptr);
  const bool finalized = CGImageDestinationFinalize(destination);
  std::vector<uint8_t> bytes;
  if (finalized) {
    const CFIndex length = CFDataGetLength(data);
    const UInt8* pointer = CFDataGetBytePtr(data);
    if (length > 0 && pointer != nullptr) {
      bytes.assign(pointer, pointer + length);
    }
  }
  CFRelease(destination);
  CFRelease(data);
  CGImageRelease(image);
  return bytes;
}

napi_value Boolean(napi_env env, bool value) {
  napi_value result = nullptr;
  napi_get_boolean(env, value, &result);
  return result;
}

napi_value String(napi_env env, const std::string& value) {
  napi_value result = nullptr;
  napi_create_string_utf8(env, value.data(), value.size(), &result);
  return result;
}

void Set(napi_env env, napi_value object, const char* key, napi_value value) {
  napi_set_named_property(env, object, key, value);
}

napi_value GetPermissionState(napi_env env, napi_callback_info) {
  napi_value result = nullptr;
  napi_create_object(env, &result);
  Set(env, result, "accessibility", Boolean(env, AXIsProcessTrusted()));
  Set(env, result, "screenRecording",
      Boolean(env, CGPreflightScreenCaptureAccess()));
  return result;
}

napi_value RequestAccessibility(napi_env env, napi_callback_info) {
  NSDictionary* options = @{
    (__bridge NSString*)kAXTrustedCheckOptionPrompt : @YES,
  };
  return Boolean(env, AXIsProcessTrustedWithOptions(
                          (__bridge CFDictionaryRef)options));
}

napi_value RequestScreenRecording(napi_env env, napi_callback_info) {
  return Boolean(env, CGRequestScreenCaptureAccess());
}

void ExecuteCapture(napi_env, void* data) {
  AsyncCaptureWork* work = static_cast<AsyncCaptureWork*>(data);
  @autoreleasepool {
    if (!AXIsProcessTrusted()) {
      work->error =
          "Qwen Live Host needs Accessibility permission for Appshot.";
      return;
    }
    if (!CGPreflightScreenCaptureAccess()) {
      work->error =
          "Qwen Live Host needs Screen Recording permission for Appshot.";
      return;
    }
    work->target = FindForegroundWindow();
    if (!work->target.has_value()) {
      work->error = "No foreground application window found.";
      return;
    }
    work->accessibility_text = CaptureAccessibilityTree(*work->target);
    if (work->accessibility_text.empty()) {
      work->error = "The native Appshot accessibility capture failed.";
      return;
    }
    work->screenshot = CapturePng(*work->target);
    if (work->screenshot.empty()) {
      work->error = "The native Appshot screenshot failed.";
    }
  }
}

void CompleteCapture(napi_env env, napi_status status, void* data) {
  AsyncCaptureWork* work = static_cast<AsyncCaptureWork*>(data);
  if (status != napi_ok && work->error.empty()) {
    work->error = "The native Appshot worker failed.";
  }
  if (!work->error.empty() || !work->target.has_value()) {
    napi_value message = String(
        env, work->error.empty() ? "The native Appshot capture failed."
                                 : work->error);
    napi_value error = nullptr;
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, work->deferred, error);
    napi_delete_async_work(env, work->work);
    delete work;
    return;
  }

  const WindowTarget& target = *work->target;
  napi_value result = nullptr;
  napi_create_object(env, &result);
  Set(env, result, "appName", String(env, target.app_name));
  if (!target.bundle_identifier.empty()) {
    Set(env, result, "bundleIdentifier",
        String(env, target.bundle_identifier));
  }
  if (!target.title.empty()) {
    Set(env, result, "windowTitle", String(env, target.title));
  }
  Set(env, result, "accessibilityText", String(env, work->accessibility_text));
  napi_value window_id = nullptr;
  napi_create_uint32(env, target.window_id, &window_id);
  Set(env, result, "windowId", window_id);
  napi_value screenshot_buffer = nullptr;
  napi_create_buffer_copy(env, work->screenshot.size(), work->screenshot.data(),
                          nullptr, &screenshot_buffer);
  Set(env, result, "screenshot", screenshot_buffer);
  napi_resolve_deferred(env, work->deferred, result);
  napi_delete_async_work(env, work->work);
  delete work;
}

napi_value CaptureAppshot(napi_env env, napi_callback_info) {
  AsyncCaptureWork* work = new AsyncCaptureWork{};
  napi_value promise = nullptr;
  if (napi_create_promise(env, &work->deferred, &promise) != napi_ok) {
    delete work;
    napi_throw_error(env, nullptr, "Could not create the Appshot promise.");
    return nullptr;
  }
  napi_value resource_name = String(env, "QwenLiveAppshot");
  if (napi_create_async_work(env, nullptr, resource_name, ExecuteCapture,
                             CompleteCapture, work, &work->work) != napi_ok ||
      napi_queue_async_work(env, work->work) != napi_ok) {
    if (work->work != nullptr) napi_delete_async_work(env, work->work);
    delete work;
    napi_throw_error(env, nullptr, "Could not start the Appshot worker.");
    return nullptr;
  }
  return promise;
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"getPermissionState", nullptr, GetPermissionState, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"requestAccessibility", nullptr, RequestAccessibility, nullptr, nullptr,
       nullptr, napi_default, nullptr},
      {"requestScreenRecording", nullptr, RequestScreenRecording, nullptr,
       nullptr, nullptr, napi_default, nullptr},
      {"captureAppshot", nullptr, CaptureAppshot, nullptr, nullptr, nullptr,
       napi_default, nullptr},
  };
  napi_define_properties(env, exports,
                         sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}

NAPI_MODULE_INIT() { return Initialize(env, exports); }
