//! Raw FFI bindings to the macOS Accessibility API (AXUIElement).
//!
//! We call the C-level AX API directly rather than using a crate wrapper,
//! because most available crates are incomplete or unmaintained.

#![allow(
    non_upper_case_globals,
    non_camel_case_types,
    non_snake_case,
    dead_code
)]

use core_foundation::{
    array::CFArrayRef,
    base::{CFRelease, CFRetain, CFTypeID, CFTypeRef},
    string::CFStringRef,
};
use std::os::raw::{c_int, c_void};

// ── AXUIElement opaque type ──────────────────────────────────────────────────

#[repr(C)]
pub struct __AXUIElement(c_void);
pub type AXUIElementRef = *mut __AXUIElement;

// ── AXError ──────────────────────────────────────────────────────────────────

pub type AXError = c_int;
pub const kAXErrorSuccess: AXError = 0;
pub const kAXErrorFailure: AXError = -25200;
pub const kAXErrorInvalidUIElement: AXError = -25202;
pub const kAXErrorAttributeUnsupported: AXError = -25205;
pub const kAXErrorNoValue: AXError = -25212;
pub const kAXErrorAPIDisabled: AXError = -25211;

// ── AXValue opaque type ──────────────────────────────────────────────────────

#[repr(C)]
pub struct __AXValue(c_void);
pub type AXValueRef = *mut __AXValue;

pub type AXValueType = c_int;
pub const kAXValueCGPointType: AXValueType = 1;
pub const kAXValueCGSizeType: AXValueType = 2;
pub const kAXValueCGRectType: AXValueType = 3;
pub const kAXValueCFRangeType: AXValueType = 4;
pub const kAXValueIllegalType: AXValueType = 1_000;

// ── Link to AXUIElement functions ────────────────────────────────────────────
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    pub fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    pub fn AXUIElementCopyAttributeNames(
        element: AXUIElementRef,
        names: *mut CFArrayRef,
    ) -> AXError;
    pub fn AXUIElementCopyActionNames(element: AXUIElementRef, names: *mut CFArrayRef) -> AXError;
    pub fn AXUIElementCopyElementAtPosition(
        application: AXUIElementRef,
        x: f32,
        y: f32,
        element: *mut AXUIElementRef,
    ) -> AXError;
    pub fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
    pub fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    pub fn AXUIElementIsAttributeSettable(
        element: AXUIElementRef,
        attribute: CFStringRef,
        settable: *mut u8,
    ) -> AXError;
    pub fn AXUIElementSetMessagingTimeout(
        element: AXUIElementRef,
        timeout_in_seconds: f32,
    ) -> AXError;
    pub fn AXUIElementGetTypeID() -> CFTypeID;
    pub fn AXIsProcessTrusted() -> bool;
    /// `AXIsProcessTrustedWithOptions(options)` — when called with
    /// `{kAXTrustedCheckOptionPrompt: true}` raises the system Accessibility
    /// prompt if the process isn't already trusted.  Returns the post-prompt
    /// trust state (may still be false if the user dismissed the prompt).
    pub fn AXIsProcessTrustedWithOptions(
        options: core_foundation::dictionary::CFDictionaryRef,
    ) -> bool;

    /// Private SPI: maps an AX window element to its CGWindowID.
    /// Stable since macOS 10.9; used by yabai, Hammerspoon, Accessibility Inspector.
    pub fn _AXUIElementGetWindow(element: AXUIElementRef, window_id: *mut u32) -> AXError;
}

/// Hit-test one process's accessibility tree at a screen point. The returned
/// element is retained and must be released by the caller.
///
/// # Safety
///
/// The caller must release any returned element exactly once with `CFRelease`.
pub unsafe fn element_at_screen_position(pid: i32, x: f64, y: f64) -> Option<AXUIElementRef> {
    let application = AXUIElementCreateApplication(pid);
    if application.is_null() {
        return None;
    }
    let mut element = std::ptr::null_mut();
    let error = AXUIElementCopyElementAtPosition(application, x as f32, y as f32, &mut element);
    CFRelease(application as CFTypeRef);
    (error == kAXErrorSuccess && !element.is_null()).then_some(element)
}

// ── AXValue functions ────────────────────────────────────────────────────────
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub fn AXValueCreate(the_type: AXValueType, value_ptr: *const c_void) -> AXValueRef;
    pub fn AXValueGetTypeID() -> CFTypeID;
    pub fn AXValueGetType(value: AXValueRef) -> AXValueType;
    pub fn AXValueGetValue(
        value: AXValueRef,
        the_type: AXValueType,
        value_ptr: *mut c_void,
    ) -> bool;
}

#[repr(C)]
struct CGPointValue {
    x: f64,
    y: f64,
}

#[repr(C)]
struct CGSizeValue {
    width: f64,
    height: f64,
}

// ── Helper functions ──────────────────────────────────────────────────────────

use core_foundation::{array::CFArray, base::TCFType, string::CFString as CFStr};

#[derive(Debug)]
pub struct CopiedAXAttribute<T> {
    pub value: Option<T>,
    pub complete: bool,
}

// Bounded, thread-local trace of why the current AX capture was judged
// incomplete. `walk_tree_bounded` clears it before every walk and drains it
// afterwards so a forced-full observation revision can explain itself instead
// of reporting an opaque `capture_incomplete`.
thread_local! {
    static INCOMPLETE_NOTES: std::cell::RefCell<Vec<String>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

const MAX_INCOMPLETE_NOTES: usize = 12;

pub(crate) fn reset_incomplete_notes() {
    INCOMPLETE_NOTES.with(|notes| notes.borrow_mut().clear());
}

pub(crate) fn take_incomplete_notes() -> Vec<String> {
    INCOMPLETE_NOTES.with(|notes| std::mem::take(&mut *notes.borrow_mut()))
}

pub(crate) fn note_incomplete(context: &str, detail: &str) {
    INCOMPLETE_NOTES.with(|notes| {
        let mut notes = notes.borrow_mut();
        if notes.len() < MAX_INCOMPLETE_NOTES {
            notes.push(format!("{context}: {detail}"));
        }
    });
}

fn missing_attribute_is_complete(error: AXError) -> bool {
    // kAXErrorFailure is a stable app-side refusal, observed live on
    // TextEdit's AXDescription and SwiftUI's AXSlider value writes — the
    // element consistently answers "no", so it carries no evidence of a
    // mid-capture mutation. Transient busy signals (kAXErrorCannotComplete)
    // still mark the capture incomplete.
    matches!(
        error,
        kAXErrorNoValue | kAXErrorAttributeUnsupported | kAXErrorFailure
    )
}

/// Classify a failed attribute read, recording every transient verdict.
fn attribute_error_is_complete(attr_name: &str, error: AXError) -> bool {
    if missing_attribute_is_complete(error) {
        return true;
    }
    note_incomplete(attr_name, &format!("ax_error {error}"));
    false
}

/// Record a success-but-null read, which is treated as transient.
fn null_value_incomplete(attr_name: &str) -> bool {
    note_incomplete(attr_name, "null value");
    false
}

/// Whether an AX attribute is currently writable on this element.
///
/// # Safety
///
/// `element` must be a valid, live `AXUIElementRef` for the duration of the call.
pub unsafe fn is_attribute_settable(element: AXUIElementRef, attr_name: &str) -> bool {
    is_attribute_settable_with_status(element, attr_name)
        .value
        .unwrap_or(false)
}

pub unsafe fn is_attribute_settable_with_status(
    element: AXUIElementRef,
    attr_name: &str,
) -> CopiedAXAttribute<bool> {
    let attr = CFStr::new(attr_name);
    let mut settable = 0_u8;
    let error = AXUIElementIsAttributeSettable(element, attr.as_concrete_TypeRef(), &mut settable);
    if error == kAXErrorSuccess {
        return CopiedAXAttribute {
            value: Some(settable != 0),
            complete: true,
        };
    }
    CopiedAXAttribute {
        value: Some(false),
        complete: attribute_error_is_complete(attr_name, error),
    }
}

/// Copy a string attribute from an AX element. Returns `None` on any error.
///
/// # Safety
///
/// `element` must be a valid, live `AXUIElementRef` for the duration of the call.
pub unsafe fn copy_string_attr(element: AXUIElementRef, attr_name: &str) -> Option<String> {
    copy_string_attr_with_status(element, attr_name).value
}

pub unsafe fn copy_string_attr_with_status(
    element: AXUIElementRef,
    attr_name: &str,
) -> CopiedAXAttribute<String> {
    let attr = CFStr::new(attr_name);
    let mut value: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut value);
    if err != kAXErrorSuccess {
        return CopiedAXAttribute {
            value: None,
            complete: attribute_error_is_complete(attr_name, err),
        };
    }
    if value.is_null() {
        return CopiedAXAttribute {
            value: None,
            complete: null_value_incomplete(attr_name),
        };
    }
    let cf_string_type_id = CFStr::type_id();
    if core_foundation::base::CFGetTypeID(value) != cf_string_type_id {
        CFRelease(value);
        return CopiedAXAttribute {
            value: None,
            complete: true,
        };
    }
    let s = CFStr::wrap_under_create_rule(value as _);
    CopiedAXAttribute {
        value: Some(s.to_string()),
        complete: true,
    }
}

/// Copy a numeric attribute from an AX element as an `f64`. Returns `None` on
/// any error or if the attribute is not a `CFNumber`. SwiftUI sliders expose a
/// readable numeric `AXValue` even when that value is not settable — this lets
/// the stepping fallback read the control's current position for feedback.
///
/// # Safety
///
/// `element` must be a valid, live `AXUIElementRef` for the duration of the call.
pub unsafe fn copy_number_attr(element: AXUIElementRef, attr_name: &str) -> Option<f64> {
    copy_number_attr_with_status(element, attr_name).value
}

pub unsafe fn copy_number_attr_with_status(
    element: AXUIElementRef,
    attr_name: &str,
) -> CopiedAXAttribute<f64> {
    use core_foundation::number::CFNumber;
    let attr = CFStr::new(attr_name);
    let mut value: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut value);
    if err != kAXErrorSuccess {
        return CopiedAXAttribute {
            value: None,
            complete: attribute_error_is_complete(attr_name, err),
        };
    }
    if value.is_null() {
        return CopiedAXAttribute {
            value: None,
            complete: null_value_incomplete(attr_name),
        };
    }
    let cf_number_type_id = CFNumber::type_id();
    if core_foundation::base::CFGetTypeID(value) != cf_number_type_id {
        CFRelease(value);
        return CopiedAXAttribute {
            value: None,
            complete: true,
        };
    }
    let n = CFNumber::wrap_under_create_rule(value as _);
    CopiedAXAttribute {
        value: n.to_f64(),
        complete: true,
    }
}

/// Copy a boolean attribute from an AX element. Returns `None` on any error
/// or if the attribute is neither a `CFBoolean` nor a `CFNumber` (some apps
/// report AXEnabled/AXSelected as a 0/1 CFNumber instead of a CFBoolean).
///
/// # Safety
///
/// `element` must be a valid Accessibility object reference for the duration
/// of this call.
pub unsafe fn copy_bool_attr(element: AXUIElementRef, attr_name: &str) -> Option<bool> {
    copy_bool_attr_with_status(element, attr_name).value
}

pub unsafe fn copy_bool_attr_with_status(
    element: AXUIElementRef,
    attr_name: &str,
) -> CopiedAXAttribute<bool> {
    use core_foundation::boolean::CFBoolean;
    use core_foundation::number::CFNumber;
    let attr = CFStr::new(attr_name);
    let mut value: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut value);
    if err != kAXErrorSuccess {
        return CopiedAXAttribute {
            value: None,
            complete: attribute_error_is_complete(attr_name, err),
        };
    }
    if value.is_null() {
        return CopiedAXAttribute {
            value: None,
            complete: null_value_incomplete(attr_name),
        };
    }
    let type_id = core_foundation::base::CFGetTypeID(value);
    if type_id == CFBoolean::type_id() {
        let b = CFBoolean::wrap_under_create_rule(value as _);
        return CopiedAXAttribute {
            value: Some(b.into()),
            complete: true,
        };
    }
    if type_id == CFNumber::type_id() {
        let n = CFNumber::wrap_under_create_rule(value as _);
        return CopiedAXAttribute {
            value: n.to_f64().map(|f| f != 0.0),
            complete: true,
        };
    }
    CFRelease(value);
    CopiedAXAttribute {
        value: None,
        complete: true,
    }
}

/// A copied AX attribute represented for both existing string-only consumers
/// and the wider structured control-state response.
#[derive(Debug, PartialEq, Eq)]
pub struct StringishAttrValue {
    /// Present only when the source value was a CFString.
    pub string_value: Option<String>,
    /// CFString as-is, CFNumber as text, or CFBoolean as `"1"` / `"0"`.
    pub state_value: String,
}

/// Convert a borrowed CF value without taking ownership of it.
unsafe fn coerce_stringish_value(value: CFTypeRef) -> Option<StringishAttrValue> {
    use core_foundation::boolean::CFBoolean;
    use core_foundation::number::CFNumber;
    let type_id = core_foundation::base::CFGetTypeID(value);
    if type_id == CFStr::type_id() {
        let string = CFStr::wrap_under_get_rule(value as _).to_string();
        return Some(StringishAttrValue {
            string_value: Some(string.clone()),
            state_value: string,
        });
    }
    if type_id == CFNumber::type_id() {
        let n = CFNumber::wrap_under_get_rule(value as _);
        let f = n.to_f64()?;
        let state_value = if f == f.trunc() && f.abs() < 1e15 {
            format!("{}", f as i64)
        } else {
            format!("{f}")
        };
        return Some(StringishAttrValue {
            string_value: None,
            state_value,
        });
    }
    if type_id == CFBoolean::type_id() {
        let b = CFBoolean::wrap_under_get_rule(value as _);
        return Some(StringishAttrValue {
            string_value: None,
            state_value: if bool::from(b) {
                "1".into()
            } else {
                "0".into()
            },
        });
    }
    None
}

/// Copy an attribute that may be a `CFString`, `CFNumber`, or `CFBoolean`.
///
/// The returned pair lets the tree walker preserve its historical CFString-only
/// markdown while using the same single AX read for structured control state.
/// Numbers render without a trailing `.0` when integral (`8`, not `8.0`), and
/// booleans render as `1`/`0` to match AppKit's two-state controls.
///
/// # Safety
///
/// `element` must be a valid Accessibility object reference for the duration
/// of this call.
pub unsafe fn copy_stringish_attr(
    element: AXUIElementRef,
    attr_name: &str,
) -> Option<StringishAttrValue> {
    copy_stringish_attr_with_status(element, attr_name).value
}

pub unsafe fn copy_stringish_attr_with_status(
    element: AXUIElementRef,
    attr_name: &str,
) -> CopiedAXAttribute<StringishAttrValue> {
    let attr = CFStr::new(attr_name);
    let mut value: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut value);
    if err != kAXErrorSuccess {
        return CopiedAXAttribute {
            value: None,
            complete: attribute_error_is_complete(attr_name, err),
        };
    }
    if value.is_null() {
        return CopiedAXAttribute {
            value: None,
            complete: null_value_incomplete(attr_name),
        };
    }
    let result = coerce_stringish_value(value);
    CFRelease(value);
    CopiedAXAttribute {
        value: result,
        complete: true,
    }
}

/// Get the action names for an AX element.
///
/// # Safety
///
/// `element` must be a valid, live `AXUIElementRef` for the duration of the call.
pub unsafe fn copy_action_names(element: AXUIElementRef) -> Vec<String> {
    copy_action_names_with_status(element).actions
}

pub struct CopiedAXActions {
    pub actions: Vec<String>,
    pub complete: bool,
}

pub unsafe fn copy_action_names_with_status(element: AXUIElementRef) -> CopiedAXActions {
    let mut names: CFArrayRef = std::ptr::null_mut();
    let err = AXUIElementCopyActionNames(element, &mut names);
    if err != kAXErrorSuccess {
        return CopiedAXActions {
            actions: Vec::new(),
            complete: attribute_error_is_complete("AXActionNames", err),
        };
    }
    if names.is_null() {
        return CopiedAXActions {
            actions: Vec::new(),
            complete: null_value_incomplete("AXActionNames"),
        };
    }
    // Use CFArray<CFStr> (the typed wrapper) to satisfy FromVoid bound.
    let arr = CFArray::<CFStr>::wrap_under_create_rule(names);
    let mut actions = Vec::with_capacity(usize::try_from(arr.len()).unwrap_or_default());
    let mut complete = true;
    for index in 0..arr.len() {
        match arr.get(index) {
            Some(action) => actions.push(action.to_string()),
            None => {
                note_incomplete("AXActionNames", "missing array item");
                complete = false;
            }
        }
    }
    CopiedAXActions { actions, complete }
}

/// Read the on-screen center of an AX element (AXPosition + AXSize → center).
/// Returns `(cx, cy)` in screen coordinates, or `None` if either attribute
/// is unavailable or the element has zero size.
///
/// # Safety
///
/// `element` must be a valid, live `AXUIElementRef` for the duration of the call.
pub unsafe fn element_screen_center(element: AXUIElementRef) -> Option<(f64, f64)> {
    element_screen_rect(element).map(|[x, y, width, height]| (x + width / 2.0, y + height / 2.0))
}

/// Read the on-screen bounding rect of an AX element.
/// Returns `[x, y, width, height]` in screen coordinates (top-left origin), or `None`.
///
/// # Safety
///
/// `element` must be a valid, live `AXUIElementRef` for the duration of the call.
pub unsafe fn element_screen_rect(element: AXUIElementRef) -> Option<[f64; 4]> {
    element_screen_rect_with_status(element).value
}

/// Read the bounding rect while distinguishing a stable missing/unsupported
/// attribute from a transient native read failure. Revision capture must never
/// retain the latter as if a frame had genuinely disappeared.
///
/// # Safety
///
/// `element` must be a valid, live `AXUIElementRef` for the duration of the call.
pub unsafe fn element_screen_rect_with_status(
    element: AXUIElementRef,
) -> CopiedAXAttribute<[f64; 4]> {
    // AXPosition → CGPoint
    let pos_attr = CFStr::new("AXPosition");
    let mut pos_ref: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(element, pos_attr.as_concrete_TypeRef(), &mut pos_ref);
    if err != kAXErrorSuccess {
        return CopiedAXAttribute {
            value: None,
            complete: attribute_error_is_complete("AXPosition", err),
        };
    }
    if pos_ref.is_null() {
        return CopiedAXAttribute {
            value: None,
            complete: {
                note_incomplete("AXFrame", "null or undecodable value");
                false
            },
        };
    }
    if core_foundation::base::CFGetTypeID(pos_ref) != AXValueGetTypeID()
        || AXValueGetType(pos_ref as AXValueRef) != kAXValueCGPointType
    {
        CFRelease(pos_ref);
        return CopiedAXAttribute {
            value: None,
            complete: true,
        };
    }
    let mut pos = CGPointValue { x: 0.0, y: 0.0 };
    let ok = AXValueGetValue(
        pos_ref as AXValueRef,
        kAXValueCGPointType,
        &mut pos as *mut _ as *mut std::ffi::c_void,
    );
    CFRelease(pos_ref);
    if !ok {
        return CopiedAXAttribute {
            value: None,
            complete: {
                note_incomplete("AXFrame", "null or undecodable value");
                false
            },
        };
    }

    // AXSize → CGSize
    let sz_attr = CFStr::new("AXSize");
    let mut sz_ref: CFTypeRef = std::ptr::null();
    let err2 = AXUIElementCopyAttributeValue(element, sz_attr.as_concrete_TypeRef(), &mut sz_ref);
    if err2 != kAXErrorSuccess {
        return CopiedAXAttribute {
            value: None,
            complete: attribute_error_is_complete("AXSize", err2),
        };
    }
    if sz_ref.is_null() {
        return CopiedAXAttribute {
            value: None,
            complete: {
                note_incomplete("AXFrame", "null or undecodable value");
                false
            },
        };
    }
    if core_foundation::base::CFGetTypeID(sz_ref) != AXValueGetTypeID()
        || AXValueGetType(sz_ref as AXValueRef) != kAXValueCGSizeType
    {
        CFRelease(sz_ref);
        return CopiedAXAttribute {
            value: None,
            complete: true,
        };
    }
    let mut sz = CGSizeValue {
        width: 0.0,
        height: 0.0,
    };
    let ok2 = AXValueGetValue(
        sz_ref as AXValueRef,
        kAXValueCGSizeType,
        &mut sz as *mut _ as *mut std::ffi::c_void,
    );
    CFRelease(sz_ref);
    if !ok2 {
        return CopiedAXAttribute {
            value: None,
            complete: {
                note_incomplete("AXFrame", "null or undecodable value");
                false
            },
        };
    }
    if sz.width < 1.0 || sz.height < 1.0 {
        return CopiedAXAttribute {
            value: None,
            complete: true,
        };
    }

    CopiedAXAttribute {
        value: Some([pos.x, pos.y, sz.width, sz.height]),
        complete: true,
    }
}

/// Get the focused UI element of a running application by pid.
/// Returns a retained `AXUIElementRef` that the caller must release, or `None`.
///
/// # Safety
///
/// The caller must release any returned element exactly once with `CFRelease`.
pub unsafe fn focused_element_of_pid(pid: i32) -> Option<AXUIElementRef> {
    let app = AXUIElementCreateApplication(pid);
    if app.is_null() {
        return None;
    }
    let attr = CFStr::new("AXFocusedUIElement");
    let mut value: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(app, attr.as_concrete_TypeRef(), &mut value);
    CFRelease(app as CFTypeRef);
    if err != kAXErrorSuccess || value.is_null() {
        return None;
    }
    let ax_type_id = AXUIElementGetTypeID();
    if core_foundation::base::CFGetTypeID(value) != ax_type_id {
        CFRelease(value);
        return None;
    }
    // Already retained by CopyAttributeValue — hand the raw pointer to the caller.
    Some(value as AXUIElementRef)
}

/// Return the CGWindowID of the application's focused AX window.
///
/// This is a narrow read-only proof used before global keyboard delivery: an
/// already focused exact window must not be re-activated, because doing so can
/// make a focus-proxy renderer drop its current key target.
pub fn focused_window_id_of_pid(pid: i32) -> Option<u32> {
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return None;
        }
        let window = copy_element_attr(app, "AXFocusedWindow");
        CFRelease(app as CFTypeRef);
        let window = window?;
        let window_id = ax_get_window_id(window);
        CFRelease(window as CFTypeRef);
        window_id
    }
}

/// Get the children of an AX element.
///
/// # Safety
///
/// `element` must be valid, and the caller must release every returned element.
pub struct CopiedAXElements {
    pub elements: Vec<AXUIElementRef>,
    pub complete: bool,
}

unsafe fn copy_element_array_attr(element: AXUIElementRef, attr_name: &str) -> CopiedAXElements {
    let attr = CFStr::new(attr_name);
    let mut value: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut value);
    if matches!(err, kAXErrorNoValue | kAXErrorAttributeUnsupported) {
        return CopiedAXElements {
            elements: Vec::new(),
            complete: true,
        };
    }
    if err != kAXErrorSuccess || value.is_null() {
        return CopiedAXElements {
            elements: Vec::new(),
            complete: {
                note_incomplete(
                    attr_name,
                    if err != kAXErrorSuccess {
                        "ax_error on element array"
                    } else {
                        "null or non-array value"
                    },
                );
                false
            },
        };
    }
    let cf_array_type_id = CFArray::<CFTypeRef>::type_id();
    if core_foundation::base::CFGetTypeID(value) != cf_array_type_id {
        CFRelease(value);
        return CopiedAXElements {
            elements: Vec::new(),
            complete: {
                note_incomplete(
                    attr_name,
                    if err != kAXErrorSuccess {
                        "ax_error on element array"
                    } else {
                        "null or non-array value"
                    },
                );
                false
            },
        };
    }
    let arr = CFArray::<CFTypeRef>::wrap_under_create_rule(value as _);
    let ax_type_id = AXUIElementGetTypeID();
    let mut elements = Vec::with_capacity(usize::try_from(arr.len()).unwrap_or_default());
    let mut complete = true;
    for index in 0..arr.len() {
        let Some(item) = arr.get(index) else {
            complete = false;
            continue;
        };
        let item = *item;
        if core_foundation::base::CFGetTypeID(item) != ax_type_id {
            complete = false;
            continue;
        }
        CFRetain(item);
        elements.push(item as AXUIElementRef);
    }
    CopiedAXElements { elements, complete }
}

pub unsafe fn copy_children_with_status(element: AXUIElementRef) -> CopiedAXElements {
    copy_element_array_attr(element, "AXChildren")
}

pub unsafe fn copy_children(element: AXUIElementRef) -> Vec<AXUIElementRef> {
    copy_children_with_status(element).elements
}

/// Copy an AX element-valued attribute. The returned element is retained and
/// must be released by the caller.
///
/// # Safety
///
/// `element` must be valid, and the caller must release any returned element.
pub unsafe fn copy_element_attr(
    element: AXUIElementRef,
    attr_name: &str,
) -> Option<AXUIElementRef> {
    let attr = CFStr::new(attr_name);
    let mut value: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut value);
    if err != kAXErrorSuccess || value.is_null() {
        return None;
    }
    if core_foundation::base::CFGetTypeID(value) != AXUIElementGetTypeID() {
        CFRelease(value);
        return None;
    }
    Some(value as AXUIElementRef)
}

/// Perform an AX action using a string attribute name.
///
/// # Safety
///
/// `element` must be a valid, live `AXUIElementRef` for the duration of the call.
pub unsafe fn perform_action(element: AXUIElementRef, action_name: &str) -> AXError {
    let action = CFStr::new(action_name);
    AXUIElementPerformAction(element, action.as_concrete_TypeRef())
}

/// Set an AX attribute to a CFString value.
///
/// # Safety
///
/// `element` must be a valid, live `AXUIElementRef` for the duration of the call.
pub unsafe fn set_string_attr(element: AXUIElementRef, attr_name: &str, value: &str) -> AXError {
    let attr = CFStr::new(attr_name);
    let cf_value = CFStr::new(value);
    AXUIElementSetAttributeValue(element, attr.as_concrete_TypeRef(), cf_value.as_CFTypeRef())
}

/// Set an AX attribute to a CFNumber (double) value. Numeric controls — most
/// notably `AXSlider` (NSSlider) and `AXStepper` — expose a numeric `AXValue`
/// reject a `CFString` write — `-25200` (kAXErrorFailure, observed live on a
/// SwiftUI `AXSlider`) or `-25201` (kAXErrorIllegalArgument); only a `CFNumber`
/// is accepted. Text fields, by contrast, take a `CFString`.
///
/// # Safety
///
/// `element` must be a valid, live `AXUIElementRef` for the duration of the call.
pub unsafe fn set_number_attr(element: AXUIElementRef, attr_name: &str, value: f64) -> AXError {
    use core_foundation::number::CFNumber;
    let attr = CFStr::new(attr_name);
    let cf_value = CFNumber::from(value);
    AXUIElementSetAttributeValue(element, attr.as_concrete_TypeRef(), cf_value.as_CFTypeRef())
}

/// Set an AX CGPoint attribute such as `AXPosition`.
///
/// # Safety
///
/// `element` must be a valid, live `AXUIElementRef` for the duration of the call.
pub unsafe fn set_point_attr(element: AXUIElementRef, attr_name: &str, x: f64, y: f64) -> AXError {
    let attr = CFStr::new(attr_name);
    let point = CGPointValue { x, y };
    let value = AXValueCreate(
        kAXValueCGPointType,
        &point as *const CGPointValue as *const c_void,
    );
    if value.is_null() {
        return kAXErrorFailure;
    }
    let result =
        AXUIElementSetAttributeValue(element, attr.as_concrete_TypeRef(), value as CFTypeRef);
    CFRelease(value as CFTypeRef);
    result
}

/// Set an AX CGSize attribute such as `AXSize`.
///
/// # Safety
///
/// `element` must be a valid, live `AXUIElementRef` for the duration of the call.
pub unsafe fn set_size_attr(
    element: AXUIElementRef,
    attr_name: &str,
    width: f64,
    height: f64,
) -> AXError {
    let attr = CFStr::new(attr_name);
    let size = CGSizeValue { width, height };
    let value = AXValueCreate(
        kAXValueCGSizeType,
        &size as *const CGSizeValue as *const c_void,
    );
    if value.is_null() {
        return kAXErrorFailure;
    }
    let result =
        AXUIElementSetAttributeValue(element, attr.as_concrete_TypeRef(), value as CFTypeRef);
    CFRelease(value as CFTypeRef);
    result
}

/// Set an AX attribute to a CFBoolean true value.
///
/// # Safety
///
/// `element` must be a valid, live `AXUIElementRef` for the duration of the call.
pub unsafe fn set_bool_attr_true(element: AXUIElementRef, attr_name: &str) -> AXError {
    use core_foundation::boolean::CFBoolean;
    let attr = CFStr::new(attr_name);
    let cf_true = CFBoolean::true_value();
    AXUIElementSetAttributeValue(element, attr.as_concrete_TypeRef(), cf_true.as_CFTypeRef())
}

/// Signal to a Chromium/Electron application root that a real assistive client
/// is present so it materializes its full web-content accessibility tree.
///
/// Returns `true` when an attribute write was accepted — meaning the app was
/// flipped from "tree off" to "tree building" and the caller should let the
/// tree settle before walking. Returns `false` when the app does not support
/// either attribute (native Cocoa apps such as Finder / Calculator / TextEdit),
/// in which case no settle delay is warranted.
///
/// `AXManualAccessibility` is the modern opt-in with no screen-reader side
/// effects; `AXEnhancedUserInterface` is the legacy fallback some Electron
/// builds expose instead (the modern attribute returns
/// `kAXErrorAttributeUnsupported` on those builds).
///
/// # Safety
///
/// `app_element` must be a valid, live application `AXUIElementRef`.
pub unsafe fn enable_chromium_accessibility(app_element: AXUIElementRef) -> bool {
    let manual = set_bool_attr_true(app_element, "AXManualAccessibility");
    if manual == kAXErrorSuccess {
        return true;
    }
    if manual != kAXErrorAttributeUnsupported {
        // A transient error (e.g. timeout / app busy) rather than a hard
        // "this app has no such attribute" — don't bother with the legacy
        // fallback, and don't claim enablement happened.
        return false;
    }
    set_bool_attr_true(app_element, "AXEnhancedUserInterface") == kAXErrorSuccess
}

/// Get the CGWindowID of an AX window element via the private `_AXUIElementGetWindow` SPI.
/// Returns `None` if the element is not a composited window.
///
/// # Safety
///
/// `element` must be a valid, live window `AXUIElementRef`.
pub unsafe fn ax_get_window_id(element: AXUIElementRef) -> Option<u32> {
    let mut wid: u32 = 0;
    let err = _AXUIElementGetWindow(element, &mut wid);
    if err == kAXErrorSuccess && wid != 0 {
        Some(wid)
    } else {
        None
    }
}

/// Read the `AXWindows` attribute of an application element.
/// Unlike `AXChildren`, this returns the window list regardless of whether
/// the app is frontmost. Returns a Vec of retained AXUIElementRefs.
///
/// # Safety
///
/// `element` must be valid, and the caller must release every returned element.
pub unsafe fn copy_ax_windows(element: AXUIElementRef) -> Vec<AXUIElementRef> {
    copy_ax_windows_with_status(element).elements
}

pub unsafe fn copy_ax_windows_with_status(element: AXUIElementRef) -> CopiedAXElements {
    copy_element_array_attr(element, "AXWindows")
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_foundation::{boolean::CFBoolean, number::CFNumber};

    #[test]
    fn stringish_value_coerces_cfstring_cfnumber_and_cfboolean() {
        let string = CFStr::new("Search");
        let integer = CFNumber::from(8.0);
        let decimal = CFNumber::from(2.5);
        let true_value = CFBoolean::true_value();
        let false_value = CFBoolean::false_value();

        let string_result = unsafe { coerce_stringish_value(string.as_CFTypeRef()) }.unwrap();
        assert_eq!(string_result.string_value.as_deref(), Some("Search"));
        assert_eq!(string_result.state_value, "Search");

        let integer_result = unsafe { coerce_stringish_value(integer.as_CFTypeRef()) }.unwrap();
        assert_eq!(integer_result.string_value, None);
        assert_eq!(integer_result.state_value, "8");

        let decimal_result = unsafe { coerce_stringish_value(decimal.as_CFTypeRef()) }.unwrap();
        assert_eq!(decimal_result.string_value, None);
        assert_eq!(decimal_result.state_value, "2.5");

        let true_result = unsafe { coerce_stringish_value(true_value.as_CFTypeRef()) }.unwrap();
        assert_eq!(true_result.string_value, None);
        assert_eq!(true_result.state_value, "1");

        let false_result = unsafe { coerce_stringish_value(false_value.as_CFTypeRef()) }.unwrap();
        assert_eq!(false_result.string_value, None);
        assert_eq!(false_result.state_value, "0");
    }

    #[test]
    fn stable_app_side_refusals_are_complete_transient_errors_are_not() {
        assert!(attribute_error_is_complete(
            "AXDescription",
            kAXErrorNoValue
        ));
        assert!(attribute_error_is_complete(
            "AXDescription",
            kAXErrorAttributeUnsupported
        ));
        // Observed live: TextEdit's AXDescription and SwiftUI slider value
        // writes refuse with -25200 consistently; not a mid-capture mutation.
        assert!(attribute_error_is_complete(
            "AXDescription",
            kAXErrorFailure
        ));
        // -25204 kAXErrorCannotComplete: the app was busy mid-walk.
        assert!(!attribute_error_is_complete("AXTitle", -25204));
    }
}
