use std::ffi::c_void;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail};
use async_trait::async_trait;
use core_foundation::base::{CFEqual, CFRelease, CFTypeRef, TCFType};
use core_foundation::runloop::{
    kCFRunLoopDefaultMode, CFRunLoopAddSource, CFRunLoopGetCurrent, CFRunLoopRemoveSource,
    CFRunLoopRunInMode, CFRunLoopSourceRef,
};
use core_foundation::string::{CFString, CFStringRef};
use cua_driver_contract::{tool_contract, PasteInput};
use cua_driver_core::{
    action_record::{
        ActionEffect, ActionEvidence, ActionExecutionRecord, ActionTransport, ActualDelivery,
        EvidenceKind, RequestedDelivery,
    },
    background_input::{
        decide_background_input, BackgroundAction, BackgroundInputDecision, ExactWindowTarget,
    },
    protocol::ToolResult,
    tool::{Tool, ToolDef},
    tool_args::parse_typed_projection,
};
use serde_json::{json, Value};

use super::{pasteboard, ToolState};
use crate::ax::bindings::*;

pub struct PasteTool;

impl PasteTool {
    pub fn new(_state: Arc<ToolState>) -> Self {
        Self
    }
}

static DEF: OnceLock<ToolDef> = OnceLock::new();

struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn check_cancelled(cancelled: &AtomicBool) -> anyhow::Result<()> {
    if cancelled.load(Ordering::Acquire) {
        bail!("paste was cancelled");
    }
    Ok(())
}

type Observer = *mut c_void;
type Callback = unsafe extern "C" fn(Observer, AXUIElementRef, CFStringRef, *mut c_void);

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXObserverCreate(pid: i32, callback: Callback, observer: *mut Observer) -> AXError;
    fn AXObserverAddNotification(
        observer: Observer,
        element: AXUIElementRef,
        notification: CFStringRef,
        context: *mut c_void,
    ) -> AXError;
    fn AXObserverGetRunLoopSource(observer: Observer) -> CFRunLoopSourceRef;
}

unsafe extern "C" fn effect_notification(
    _observer: Observer,
    _element: AXUIElementRef,
    _name: CFStringRef,
    context: *mut c_void,
) {
    if let Some(signals) = (context as *const pasteboard::Signals).as_ref() {
        signals.observe_effect();
    }
}

struct EffectProbe {
    element: Option<AXUIElementRef>,
    baseline: Vec<(CFString, CFTypeRef)>,
    observer: Observer,
    signals: Arc<pasteboard::Signals>,
}

impl EffectProbe {
    fn new(pid: i32, window_id: u32, signals: Arc<pasteboard::Signals>) -> Self {
        unsafe {
            let element = crate::ax::exact_target::focused_element_in_window(pid, window_id);
            let mut baseline = Vec::new();
            if let Some(element) = element {
                let _ = AXUIElementSetMessagingTimeout(element, 0.1);
                for name in ["AXSelectedTextRange", "AXNumberOfCharacters"] {
                    let name = CFString::new(name);
                    let mut value = std::ptr::null();
                    let status = AXUIElementCopyAttributeValue(
                        element,
                        name.as_concrete_TypeRef(),
                        &mut value,
                    );
                    if status == kAXErrorSuccess && !value.is_null() {
                        baseline.push((name, value));
                    } else if !value.is_null() {
                        CFRelease(value);
                    }
                }
            }
            let mut observer = std::ptr::null_mut();
            if AXObserverCreate(pid, effect_notification, &mut observer) == kAXErrorSuccess
                && !observer.is_null()
            {
                let app = AXUIElementCreateApplication(pid);
                let mut registered = false;
                if !app.is_null() {
                    let _ = AXUIElementSetMessagingTimeout(app, 0.1);
                    for name in ["AXSelectedTextChanged", "AXValueChanged"] {
                        registered |= AXObserverAddNotification(
                            observer,
                            app,
                            CFString::new(name).as_concrete_TypeRef(),
                            Arc::as_ptr(&signals) as *mut c_void,
                        ) == kAXErrorSuccess;
                    }
                    CFRelease(app.cast());
                }
                if registered {
                    CFRunLoopAddSource(
                        CFRunLoopGetCurrent(),
                        AXObserverGetRunLoopSource(observer),
                        kCFRunLoopDefaultMode,
                    );
                } else {
                    CFRelease(observer.cast());
                    observer = std::ptr::null_mut();
                }
            }
            Self {
                element,
                baseline,
                observer,
                signals,
            }
        }
    }

    fn available(&self) -> bool {
        !self.observer.is_null() || !self.baseline.is_empty()
    }

    fn changed(&self) -> bool {
        if self.signals.effect.load(Ordering::Acquire) {
            return true;
        }
        let Some(element) = self.element else {
            return false;
        };
        unsafe {
            for (name, before) in &self.baseline {
                let mut after = std::ptr::null();
                let status =
                    AXUIElementCopyAttributeValue(element, name.as_concrete_TypeRef(), &mut after);
                if !after.is_null() {
                    let changed = status == kAXErrorSuccess && CFEqual(*before, after) == 0;
                    CFRelease(after);
                    if changed {
                        return true;
                    }
                }
            }
        }
        false
    }
}

impl Drop for EffectProbe {
    fn drop(&mut self) {
        unsafe {
            if !self.observer.is_null() {
                CFRunLoopRemoveSource(
                    CFRunLoopGetCurrent(),
                    AXObserverGetRunLoopSource(self.observer),
                    kCFRunLoopDefaultMode,
                );
                CFRelease(self.observer.cast());
            }
            for (_, value) in &self.baseline {
                CFRelease(*value);
            }
            if let Some(element) = self.element {
                CFRelease(element.cast());
            }
        }
    }
}

fn pump() {
    let before = Instant::now();
    unsafe {
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.025, 0);
    }
    // An empty CFRunLoop can return immediately; do not busy-spin while waiting.
    if let Some(remaining) = Duration::from_millis(25).checked_sub(before.elapsed()) {
        std::thread::sleep(remaining);
    }
}

fn wait_for_paste(
    transaction: &pasteboard::Transaction,
    probe: &EffectProbe,
    cancelled: &AtomicBool,
) -> anyhow::Result<bool> {
    let read_deadline = Instant::now() + Duration::from_secs(2);
    loop {
        check_cancelled(cancelled)?;
        if !transaction.owns_clipboard() {
            bail!("clipboard changed during paste; new clipboard was preserved");
        }
        if probe.signals.consumed.load(Ordering::Acquire) {
            break;
        }
        if probe.signals.finished.load(Ordering::Acquire) {
            bail!("paste content provider ended without supplying data");
        }
        if Instant::now() >= read_deadline {
            bail!("timed out waiting for an application to read paste content");
        }
        pump();
    }
    let observable = probe.available();
    let deadline = Instant::now()
        + if observable {
            Duration::from_secs(2)
        } else {
            Duration::from_millis(100)
        };
    loop {
        check_cancelled(cancelled)?;
        if !transaction.owns_clipboard() {
            bail!("clipboard changed during paste; new clipboard was preserved");
        }
        if observable && probe.changed() {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            if observable {
                bail!("paste content was read, but no editing signal arrived before timeout; inspect app state before another action");
            }
            return Ok(false);
        }
        pump();
    }
}

#[derive(Default)]
struct Outcome {
    dispatched: bool,
    consumed: bool,
    effect_observed: bool,
    restoration: Option<pasteboard::Restoration>,
    error: Option<String>,
}

fn action_record(outcome: &Outcome) -> ActionExecutionRecord {
    let mut record = ActionExecutionRecord::builder(
        if outcome.dispatched {
            ActionEffect::Unverifiable
        } else {
            ActionEffect::Refused
        },
        ActionTransport::MacosCgEventPid,
        RequestedDelivery::Background,
    );
    if outcome.dispatched {
        record = record
            .actual_delivery(ActualDelivery::Background)
            .evidence(ActionEvidence {
                kind: EvidenceKind::NativeApiResult,
                detail: "one targeted Command-V dispatch was attempted".into(),
            });
    }
    if outcome.dispatched && outcome.consumed {
        record = record.evidence(ActionEvidence {
            kind: EvidenceKind::EventReceipt,
            detail: "a pasteboard reader requested content; its identity and document insertion are unverified".into(),
        });
    }
    if outcome.dispatched && outcome.effect_observed {
        record = record.evidence(ActionEvidence {
            kind: EvidenceKind::EventReceipt,
            detail: "an AX editing signal or focused selection/character-count delta followed paste; exact inserted content is unverified".into(),
        });
    }
    record.build().expect("paste execution record is valid")
}

fn run_paste(
    pid: i32,
    window_id: u32,
    content: pasteboard::Representations,
    cancelled: &AtomicBool,
) -> Outcome {
    let mut outcome = Outcome::default();
    let signals = Arc::new(pasteboard::Signals::default());
    let result = (|| -> anyhow::Result<()> {
        check_cancelled(cancelled)?;
        if crate::input::keyboard::is_screen_sharing_pid(pid) {
            bail!("paste is unavailable for Screen Sharing modifier forwarding");
        }
        crate::input::skylight::prepare_background_keyboard(pid, window_id)?;
        let probe = EffectProbe::new(pid, window_id, Arc::clone(&signals));
        check_cancelled(cancelled)?;
        let mut transaction = pasteboard::Transaction::begin(content, Arc::clone(&signals))?;
        let action = (|| -> anyhow::Result<bool> {
            check_cancelled(cancelled)?;
            let facts = crate::ax::exact_target::gather_background_facts(pid, window_id, None);
            if !matches!(
                decide_background_input(
                    ExactWindowTarget { pid, window_id },
                    &facts,
                    BackgroundAction::GenericKey
                ),
                BackgroundInputDecision::Execute { .. }
            ) {
                bail!("paste target changed before dispatch; refresh app state");
            }
            crate::input::skylight::prepare_background_keyboard(pid, window_id)?;
            check_cancelled(cancelled)?;
            if !transaction.owns_clipboard() {
                bail!("clipboard changed before paste dispatch; new clipboard was preserved");
            }
            // Mark the attempted send before the void native event API: an error
            // cannot justify replaying a chord that may already be in flight.
            outcome.dispatched = true;
            crate::input::keyboard::hotkey(pid, "v", &["super"])?;
            wait_for_paste(&transaction, &probe, cancelled)
        })();
        let restored = transaction.restore();
        outcome.restoration = restored.as_ref().ok().copied();
        match (action, restored) {
            (Ok(effect), Ok(pasteboard::Restoration::Restored)) => {
                outcome.effect_observed = effect;
                Ok(())
            }
            (Ok(_), Ok(pasteboard::Restoration::ExternalChange)) => Err(anyhow!(
                "clipboard changed during paste; new clipboard was preserved"
            )),
            (Err(error), Ok(_)) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Err(action), Err(cleanup)) => Err(anyhow!(
                "{action}; clipboard cleanup also failed: {cleanup}"
            )),
        }
    })();
    outcome.consumed = signals.consumed.load(Ordering::Acquire);
    outcome.error = result.err().map(|error| error.to_string());
    outcome
}

#[async_trait]
impl Tool for PasteTool {
    fn def(&self) -> &ToolDef {
        DEF.get_or_init(|| ToolDef::from_contract(&tool_contract("paste").expect("paste contract")))
    }

    async fn invoke(&self, args: Value) -> ToolResult {
        let input = match parse_typed_projection::<PasteInput>("paste", &args) {
            Ok(input) => input,
            Err(error) => return error,
        };
        let (pid, window_id) = match (i32::try_from(input.pid), u32::try_from(input.window_id)) {
            (Ok(pid), Ok(window_id)) if pid > 0 && window_id > 0 => (pid, window_id),
            _ => {
                return ToolResult::error(
                    "paste requires a positive native pid and window_id within platform bounds",
                )
            }
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let _cancel = CancelOnDrop(Arc::clone(&cancelled));
        let queue = pasteboard::queue().lock_owned().await;
        let content = match pasteboard::convert(input.text, input.format).await {
            Ok(content) => content,
            Err(error) => return ToolResult::error(format!("paste: {error}")),
        };
        let mutation = match super::gate_background_window_action(
            pid,
            window_id,
            None,
            BackgroundAction::GenericKey,
        )
        .await
        {
            Ok(lease) => lease,
            Err(error) => return error,
        };
        let result = tokio::task::spawn_blocking(move || {
            let (_queue, _mutation) = (queue, mutation);
            let prior = crate::apps::frontmost_pid();
            let _focus = prior.filter(|prior| *prior != pid).map(|prior| {
                crate::focus_steal::begin_suppression(Some(pid), prior, "paste.CGEvent")
            });
            objc2::rc::autoreleasepool(|_| run_paste(pid, window_id, content, &cancelled))
        })
        .await;
        let outcome = match result {
            Ok(outcome) => outcome,
            Err(error) => return ToolResult::error(format!("paste worker failed: {error}")),
        };
        let structured = json!({
            "path": "clipboard_paste",
            "dispatched": outcome.dispatched,
            "clipboard_consumed": outcome.consumed,
            "ax_effect_observed": outcome.effect_observed,
            "clipboard_restored": outcome.restoration == Some(pasteboard::Restoration::Restored),
            "external_clipboard_preserved": outcome.restoration == Some(pasteboard::Restoration::ExternalChange),
            "verified": false,
            "effect": if outcome.dispatched { "unverifiable" } else { "refused" },
        });
        let record = action_record(&outcome);
        let result = match outcome.error {
            Some(error) => ToolResult::error(format!("paste: {error}")).with_structured(structured),
            None => ToolResult::text(
                "Paste content was read; inspect the app to confirm the inserted content.",
            )
            .with_structured(structured),
        };
        result.with_action_record(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_visible_to_the_cleanup_worker() {
        let flag = Arc::new(AtomicBool::new(false));
        let guard = CancelOnDrop(Arc::clone(&flag));
        assert!(check_cancelled(&flag).is_ok());
        drop(guard);
        assert!(check_cancelled(&flag).is_err());
    }

    #[test]
    fn paste_receipt_never_equates_provider_read_with_document_insertion() {
        let outcome = Outcome {
            dispatched: true,
            consumed: true,
            ..Outcome::default()
        };
        let record = action_record(&outcome);
        assert_eq!(record.effect, ActionEffect::Unverifiable);
        assert_eq!(record.transport, ActionTransport::MacosCgEventPid);
        assert!(record.fallbacks.is_empty());
        assert!(record.validate().is_ok());
        let refused = action_record(&Outcome::default());
        assert_eq!(refused.effect, ActionEffect::Refused);
        assert_eq!(refused.actual_delivery, None);
    }

    #[test]
    fn effect_callback_does_not_turn_consumption_into_effect() {
        let signals = pasteboard::Signals::default();
        let ptr = &signals as *const _ as *mut c_void;
        unsafe {
            effect_notification(
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
                ptr,
            );
        }
        assert!(!signals.effect.load(Ordering::Acquire));
        signals.consumed.store(true, Ordering::Release);
        signals.written.store(true, Ordering::Release);
        unsafe {
            effect_notification(
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
                ptr,
            );
        }
        assert!(signals.effect.load(Ordering::Acquire));
    }

    #[test]
    fn unrelated_clipboard_read_before_dispatch_does_not_claim_action_evidence() {
        let record = action_record(&Outcome {
            consumed: true,
            ..Outcome::default()
        });
        assert_eq!(record.effect, ActionEffect::Refused);
        assert_eq!(record.actual_delivery, None);
        assert!(record.evidence.is_empty());
        assert!(record.validate().is_ok());
    }
}
