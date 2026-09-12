use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};

use async_trait::async_trait;
use core_foundation::{
    base::{CFGetTypeID, CFRange, CFType, TCFType},
    string::CFString,
};
use cua_driver_contract::{SelectTextInput, TextSelection};
use cua_driver_core::{
    action_record::{
        ActionEffect, ActionEvidence, ActionExecutionRecord, ActionTransport, ActualDelivery,
        EvidenceKind, RequestedDelivery,
    },
    background_input::{
        decide_background_input, BackgroundAction, BackgroundInputDecision, ExactWindowTarget,
    },
    element_token::{resolve_element_args, ResolvedElement},
    protocol::ToolResult,
    tool::{Tool, ToolDef},
    tool_args::parse_typed_projection,
};
use objc2_foundation::{NSRange, NSString, NSStringCompareOptions};
use serde_json::{json, Value};

use super::ToolState;
use crate::ax::bindings::*;

pub struct SelectTextTool {
    state: Arc<ToolState>,
}

impl SelectTextTool {
    pub fn new(state: Arc<ToolState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl Tool for SelectTextTool {
    fn def(&self) -> &ToolDef {
        static DEF: OnceLock<ToolDef> = OnceLock::new();
        DEF.get_or_init(|| {
            ToolDef::from_contract(&cua_driver_contract::tool_contract("select_text").unwrap())
        })
    }

    async fn invoke(&self, args: Value) -> ToolResult {
        let input = match parse_typed_projection::<SelectTextInput>("select_text", &args) {
            Ok(input) => input,
            Err(error) => return error,
        };
        let (pid, window_id) = match (i32::try_from(input.pid), u32::try_from(input.window_id)) {
            (Ok(pid), Ok(window)) if pid > 0 && window > 0 => (pid, window),
            _ => return refusal("invalid_arguments", "Invalid exact app window."),
        };
        if input.text.is_empty() {
            return refusal("invalid_arguments", "text must not be empty");
        }
        let index = match resolve_element_args(
            pid,
            None,
            Some(&input.element_token),
            None,
            Some(window_id),
            "select_text",
        ) {
            Ok(ResolvedElement::Element { element_index, .. }) => element_index,
            Ok(_) => {
                return refusal(
                    "invalid_arguments",
                    "An observed element token is required.",
                )
            }
            Err(error) => return error,
        };
        let Some(element) = self
            .state
            .element_cache
            .get_element_retained(pid, window_id, index)
        else {
            return refusal(
                "stale_element",
                "The text element is stale. Observe the app again.",
            );
        };
        let lease = super::acquire_background_mutation(pid).await;
        let cancelled = Arc::new(AtomicBool::new(false));
        let _cancel = CancelOnDrop(Arc::clone(&cancelled));
        tokio::task::spawn_blocking(move || {
            // Ownership follows the native worker even if its async caller drops.
            let (_lease, element) = (lease, element);
            let pointer = element.as_ptr() as AXUIElementRef;
            let prepared = match gate(pid, window_id, pointer, BackgroundAction::AxSemantic)
                .and_then(|()| unsafe { prepare(pointer, &input) })
            {
                Ok(prepared) => prepared,
                Err(error) => return refusal("text_selection_unavailable", &error.to_string()),
            };
            let prior = crate::apps::frontmost_pid();
            let _focus = prior.filter(|prior| *prior != pid).map(|prior| {
                crate::focus_steal::begin_suppression(Some(pid), prior, "app.selectText")
            });
            let result = (|| unsafe {
                check_cancelled(&cancelled)?;
                if focus_field(pointer, pid)? {
                    gate(pid, window_id, pointer, BackgroundAction::WindowPointer)?;
                    check_cancelled(&cancelled)?;
                    click_field(pointer, pid, window_id)?;
                }
                gate(pid, window_id, pointer, BackgroundAction::AxSemantic)?;
                check_cancelled(&cancelled)?;
                apply(pointer, &prepared)
            })();
            match result {
                Ok(verified) => selection_result(verified),
                Err(error) => ToolResult::error(format!(
                    "select_text failed: {error}; observe before retrying"
                ))
                .with_action_record(selection_record(false)),
            }
        })
        .await
        .unwrap_or_else(|error| ToolResult::error(format!("Text selection worker failed: {error}")))
    }
}

struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn check_cancelled(cancelled: &AtomicBool) -> anyhow::Result<()> {
    anyhow::ensure!(
        !cancelled.load(Ordering::Acquire),
        "Text selection was cancelled"
    );
    Ok(())
}

fn gate(
    pid: i32,
    window_id: u32,
    element: AXUIElementRef,
    action: BackgroundAction,
) -> anyhow::Result<()> {
    let facts =
        crate::ax::exact_target::gather_background_facts(pid, window_id, Some(element as usize));
    match decide_background_input(ExactWindowTarget { pid, window_id }, &facts, action) {
        BackgroundInputDecision::Execute { .. } => Ok(()),
        BackgroundInputDecision::Refuse(refusal) => {
            anyhow::bail!("{}: {}", refusal.code, refusal.reason)
        }
    }
}

fn refusal(code: &str, message: &str) -> ToolResult {
    ToolResult::error(message).with_structured(json!({"code":code,"effect":"refused"}))
}

fn selection_record(verified: bool) -> ActionExecutionRecord {
    let mut record = ActionExecutionRecord::new(
        if verified {
            ActionEffect::Confirmed
        } else {
            ActionEffect::Unverifiable
        },
        ActionTransport::MacosAxValue,
        RequestedDelivery::Background,
    );
    record.actual_delivery = Some(ActualDelivery::Background);
    if verified {
        record.evidence.push(ActionEvidence {
            kind: EvidenceKind::AccessibilityReadback,
            detail: "AXSelectedTextRange read-back matches the requested source range".into(),
        });
    }
    record
}

fn selection_result(verified: bool) -> ToolResult {
    ToolResult::text(if verified { "Text selection confirmed." } else { "Text selection sent; observe the app to confirm." })
        .with_structured(json!({"path":"ax", "verified":verified, "effect":if verified {"confirmed"} else {"unverifiable"}}))
        .with_action_record(selection_record(verified))
}

/// Foundation searches use UTF-16 and canonical Unicode matching. Advancing
/// one code unit counts overlapping occurrences instead of silently picking one.
fn unique_range(
    source: &str,
    text: &str,
    prefix: Option<&str>,
    suffix: Option<&str>,
) -> Option<(usize, usize)> {
    if text.is_empty() {
        return None;
    }
    objc2::rc::autoreleasepool(|_| unsafe {
        let source = NSString::from_str(source);
        let text = NSString::from_str(text);
        let length = source.length();
        let prefix = prefix.map(NSString::from_str);
        let suffix = suffix.map(NSString::from_str);
        let mut start = 0;
        let mut found = None;
        while start < length {
            let range = source.rangeOfString_options_range(
                &text,
                NSStringCompareOptions::empty(),
                NSRange::new(start, length - start),
            );
            let end = range.location.checked_add(range.length)?;
            if range.length == 0 || end > length {
                break;
            }
            let before = prefix.as_ref().is_none_or(|prefix| {
                let count = prefix.length();
                range.location >= count
                    && source
                        .substringWithRange(NSRange::new(range.location - count, count))
                        .isEqualToString(prefix)
            });
            let after = suffix.as_ref().is_none_or(|suffix| {
                let count = suffix.length();
                count <= length - end
                    && source
                        .substringWithRange(NSRange::new(end, count))
                        .isEqualToString(suffix)
            });
            if before && after {
                if found.is_some() {
                    return None;
                }
                found = Some((range.location, range.length));
            }
            start = range.location + 1;
        }
        found
    })
}

struct Prepared {
    source: String,
    location: usize,
    length: usize,
}

unsafe fn prepare(element: AXUIElementRef, input: &SelectTextInput) -> anyhow::Result<Prepared> {
    anyhow::ensure!(
        is_attribute_settable(element, "AXSelectedTextRange"),
        "The element does not support setting AXSelectedTextRange"
    );
    let source = copy_string_attr(element, "AXValue")
        .ok_or_else(|| anyhow::anyhow!("The element has no readable text value"))?;
    let role = copy_string_attr(element, "AXRole").unwrap_or_default();
    let rich = crate::ax::app_text::read_rich_text(element, &role, Some(&source));
    let range = rich
        .as_ref()
        .and_then(|rich| {
            let (start, count) = unique_range(
                &rich.markdown,
                &input.text,
                input.prefix.as_deref(),
                input.suffix.as_deref(),
            )?;
            let start_offset = *rich.source_offsets.get(start)?;
            let end_offset = *rich.source_offsets.get(start + count)?;
            (end_offset > start_offset).then_some((start_offset, end_offset - start_offset))
        })
        .or_else(|| {
            unique_range(
                &source,
                &input.text,
                input.prefix.as_deref(),
                input.suffix.as_deref(),
            )
        });
    let (mut location, mut length) = range.ok_or_else(|| {
        anyhow::anyhow!("Text and adjacent context must identify exactly one match")
    })?;
    match input.selection {
        TextSelection::Text => {}
        TextSelection::CursorBefore => length = 0,
        TextSelection::CursorAfter => {
            location += length;
            length = 0;
        }
    }
    Ok(Prepared {
        source,
        location,
        length,
    })
}

unsafe fn focus_field(element: AXUIElementRef, pid: i32) -> anyhow::Result<bool> {
    let role = copy_string_attr(element, "AXRole").unwrap_or_default();
    if !matches!(
        role.as_str(),
        "AXTextArea" | "AXTextField" | "AXDateTimeArea"
    ) || copy_bool_attr(element, "AXFocused") == Some(true)
    {
        return Ok(false);
    }
    if !is_attribute_settable(element, "AXFocused") {
        return Ok(false);
    }
    let class_list = CFString::new("AXDOMClassList");
    let mut classes = std::ptr::null();
    let status =
        AXUIElementCopyAttributeValue(element, class_list.as_concrete_TypeRef(), &mut classes);
    let classes = (!classes.is_null()).then(|| CFType::wrap_under_create_rule(classes));
    if crate::apps::bundle_id_for_pid(pid).as_deref() == Some("com.apple.Safari")
        && status == kAXErrorSuccess
        && classes.is_some()
    {
        return Ok(true);
    }
    let status = set_bool_attr_true(element, "AXFocused");
    anyhow::ensure!(
        status == kAXErrorSuccess,
        "AXFocused failed with AX error {status}"
    );
    Ok(copy_bool_attr(element, "AXFocused") != Some(true))
}

unsafe fn click_field(element: AXUIElementRef, pid: i32, window_id: u32) -> anyhow::Result<()> {
    let point = element_screen_center(element)
        .ok_or_else(|| anyhow::anyhow!("Text field has no clickable bounds"))?;
    let frame = crate::windows::window_bounds_by_id(window_id)
        .ok_or_else(|| anyhow::anyhow!("Text window has no bounds"))?;
    let local = (point.0 - frame.x, point.1 - frame.y);
    anyhow::ensure!(
        [point.0, point.1, local.0, local.1]
            .iter()
            .all(|value| value.is_finite())
            && local.0 >= 0.0
            && local.1 >= 0.0
            && local.0 <= frame.width
            && local.1 <= frame.height,
        "Text field is outside its window"
    );
    crate::input::app_pointer::click_button(
        pid,
        window_id,
        point,
        local,
        1,
        &[],
        crate::input::mouse::DragButton::Left,
    )
}

unsafe fn read_range(element: AXUIElementRef) -> Option<(usize, usize)> {
    let attr = CFString::new("AXSelectedTextRange");
    let mut value = std::ptr::null();
    let status = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut value);
    let value = (!value.is_null()).then(|| CFType::wrap_under_create_rule(value))?;
    if status != kAXErrorSuccess
        || CFGetTypeID(value.as_CFTypeRef()) != AXValueGetTypeID()
        || AXValueGetType(value.as_CFTypeRef() as AXValueRef) != kAXValueCFRangeType
    {
        return None;
    }
    let mut range = CFRange {
        location: 0,
        length: 0,
    };
    AXValueGetValue(
        value.as_CFTypeRef() as AXValueRef,
        kAXValueCFRangeType,
        (&mut range as *mut CFRange).cast(),
    )
    .then_some((
        usize::try_from(range.location).ok()?,
        usize::try_from(range.length).ok()?,
    ))
}

unsafe fn apply(element: AXUIElementRef, prepared: &Prepared) -> anyhow::Result<bool> {
    anyhow::ensure!(
        copy_string_attr(element, "AXValue").as_deref() == Some(prepared.source.as_str()),
        "Text changed before selection; observe again"
    );
    let range = CFRange {
        location: prepared.location.try_into()?,
        length: prepared.length.try_into()?,
    };
    let value = AXValueCreate(kAXValueCFRangeType, (&range as *const CFRange).cast());
    anyhow::ensure!(!value.is_null(), "Could not construct selection range");
    let value = CFType::wrap_under_create_rule(value.cast());
    let attr = CFString::new("AXSelectedTextRange");
    let status =
        AXUIElementSetAttributeValue(element, attr.as_concrete_TypeRef(), value.as_CFTypeRef());
    anyhow::ensure!(
        status == kAXErrorSuccess,
        "AXSelectedTextRange failed with AX error {status}"
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(200);
    loop {
        if read_range(element) == Some((prepared.location, prepared.length)) {
            return Ok(true);
        }
        if std::time::Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_matching_counts_overlap_and_requires_adjacent_context() {
        assert_eq!(unique_range("banana", "ana", None, None), None);
        assert_eq!(unique_range("banana", "ana", Some("b"), None), Some((1, 3)));
        assert_eq!(
            unique_range(
                "left cat right cat end",
                "cat",
                Some("right "),
                Some(" end")
            ),
            Some((15, 3))
        );
        assert_eq!(
            unique_range("left cat end", "cat", Some("left"), None),
            None
        );
        assert_eq!(unique_range("hello", "HELLO", None, None), None);
        assert_eq!(unique_range("hello", "", None, None), None);
    }

    #[test]
    fn foundation_matches_unicode_and_reports_utf16_ranges() {
        assert_eq!(
            unique_range("🙂中文 cafe\u{301}", "中文", None, None),
            Some((2, 2))
        );
        assert_eq!(
            unique_range("🙂中文 cafe\u{301}", "café", None, None),
            Some((5, 5))
        );
        assert_eq!(unique_range("a🙂b", "🙂", None, None), Some((1, 2)));
    }
}
