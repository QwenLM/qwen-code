//! Background input synthesis for macOS.
//!
//! Two strategies:
//! 1. **AX action** (`element_index` path): `AXUIElementPerformAction` — pure
//!    RPC, works on hidden/backgrounded windows, no cursor move, no focus steal.
//! 2. **CGEvent / SkyLight** (`x, y` path): synthesize CGEvents and post them
//!    to the target pid. Prefers `SLEventPostToPid` (SkyLight SPI) over the
//!    public `CGEventPostToPid` to reach Catalyst/Chromium apps and trigger
//!    the activity-monitor tickle required for live-input detection.

pub(crate) mod app_focus;
pub(crate) mod app_pointer;
pub mod ax_actions;
pub mod interactive;
pub mod keyboard;
pub mod mouse;
pub mod skylight;

pub use ax_actions::perform_ax_action;
pub use interactive::{
    GesturePhase, InteractiveDeliveryMode, InteractiveInputBatch, InteractiveInputConfig,
    InteractiveInputError, InteractiveInputEvent, InteractiveInputReceipt, InteractiveInputSession,
    KeyState, Modifier, PointerButton, PointerPhase,
};
pub use keyboard::{hotkey, press_key, type_text};
pub use mouse::click_at_xy;

pub(crate) fn new_event_source() -> Result<core_graphics::event_source::CGEventSource, ()> {
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    // HID state can deadlock inside SkyLight event construction for an isolated
    // user attached to another user's GUI session. Session events need no access
    // to hardware state; callers still select and guard their posting destination.
    CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
}

#[cfg(test)]
mod tests {
    use core_graphics::{
        event::{CGEvent, CGEventType, CGMouseButton, EventField},
        event_source::CGEventSourceStateID,
        geometry::CGPoint,
    };

    #[test]
    fn synthetic_events_use_the_combined_session_source() {
        let source = super::new_event_source().unwrap();
        let events = [
            CGEvent::new(source.clone()).unwrap(),
            CGEvent::new_keyboard_event(source.clone(), 53, true).unwrap(),
            CGEvent::new_mouse_event(
                source,
                CGEventType::LeftMouseDown,
                CGPoint::new(0.0, 0.0),
                CGMouseButton::Left,
            )
            .unwrap(),
        ];
        for event in events {
            assert_eq!(
                event.get_integer_value_field(EventField::EVENT_SOURCE_STATE_ID),
                CGEventSourceStateID::CombinedSessionState as i64
            );
        }
    }
}
