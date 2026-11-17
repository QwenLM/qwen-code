use super::bindings::*;
use core_foundation::{
    array::{CFArray, CFArrayGetCount},
    base::{CFRelease, CFType, CFTypeRef, TCFType},
    string::CFString,
};

unsafe fn read(element: AXUIElementRef, name: &str) -> (AXError, Option<CFType>) {
    let name = CFString::new(name);
    let mut value: CFTypeRef = std::ptr::null();
    let status = AXUIElementCopyAttributeValue(element, name.as_concrete_TypeRef(), &mut value);
    let value = (!value.is_null()).then(|| CFType::wrap_under_create_rule(value));
    (status, value)
}

// AppKit's Help search can retain an empty, roleless decoration. It is already
// omitted from the rendered tree; do not let it invalidate every real token.
// Any missing proof leaves the ordinary incomplete-capture path in control.
pub(super) unsafe fn is_empty_search_field_leaf(element: AXUIElementRef) -> bool {
    let (status, role) = read(element, "AXRole");
    if status != kAXErrorNoValue || role.is_some() {
        return false;
    }
    let Some(parent) = copy_element_attr(element, "AXParent") else {
        return false;
    };
    let search_parent = copy_string_attr(parent, "AXRole").as_deref() == Some("AXTextField")
        && copy_string_attr(parent, "AXSubrole").as_deref() == Some("AXSearchField");
    CFRelease(parent as CFTypeRef);
    if !search_parent {
        return false;
    }

    let (status, size) = read(element, "AXSize");
    let Some(size) = size else { return false };
    if status != kAXErrorSuccess
        || size.type_of() != AXValueGetTypeID()
        || AXValueGetType(size.as_CFTypeRef() as AXValueRef) != kAXValueCGSizeType
    {
        return false;
    }
    let mut dimensions = [f64::NAN; 2];
    if !AXValueGetValue(
        size.as_CFTypeRef() as AXValueRef,
        kAXValueCGSizeType,
        dimensions.as_mut_ptr().cast(),
    ) || dimensions != [0.0, 0.0]
    {
        return false;
    }

    let (status, children) = read(element, "AXChildren");
    let Some(children) = children else {
        return false;
    };
    if status != kAXErrorSuccess
        || children.type_of() != CFArray::<CFType>::type_id()
        || CFArrayGetCount(children.as_CFTypeRef() as _) != 0
    {
        return false;
    }
    for name in [
        "AXTitle",
        "AXDescription",
        "AXValue",
        "AXPlaceholderValue",
        "AXHelp",
    ] {
        let (status, value) = read(element, name);
        if !matches!(status, kAXErrorNoValue | kAXErrorAttributeUnsupported) || value.is_some() {
            return false;
        }
    }
    let actions = copy_action_names_with_status(element);
    if !actions.complete || !actions.actions.is_empty() {
        return false;
    }
    for name in ["AXValue", "AXFocused"] {
        let settable = is_attribute_settable_with_status(element, name);
        if !settable.complete || settable.value != Some(false) {
            return false;
        }
    }
    let focused = copy_bool_attr_with_status(element, "AXFocused");
    focused.complete && focused.value == Some(false)
}
