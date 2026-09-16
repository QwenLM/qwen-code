use std::ffi::c_void;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use core_foundation::base::{CFRetain, CFTypeRef};
use core_graphics::event::{CGEvent, CGEventFlags};
use foreign_types::ForeignType;
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};

use super::mouse::DragButton;

#[repr(C)]
pub(super) struct ObjcCGEvent(c_void);

unsafe impl objc2::encode::RefEncode for ObjcCGEvent {
    const ENCODING_REF: objc2::encode::Encoding =
        objc2::encode::Encoding::Pointer(&objc2::encode::Encoding::Struct("__CGEvent", &[]));
}

pub(super) unsafe fn cg_event(event: &NSEvent) -> *mut c_void {
    let raw: *mut ObjcCGEvent = objc2::msg_send![event, CGEvent];
    raw as *mut c_void
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    // CGPoint's two floating-point arguments match the existing arm64/x86_64
    // bridge declaration in mouse.rs and interactive.rs.
    fn CGEventSetLocation(event: *mut c_void, x: f64, y: f64);
    fn CGEventSetTimestamp(event: *mut c_void, timestamp: u64);
}

fn native_event(
    kind: usize,
    button: i64,
    click_count: isize,
    number: isize,
    point: (f64, f64),
    local: (f64, f64),
    window_id: u32,
    flags: CGEventFlags,
) -> anyhow::Result<CGEvent> {
    objc2::rc::autoreleasepool(|_| unsafe {
        let ns = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType(kind), objc2_foundation::NSPoint::new(point.0, point.1),
            NSEventModifierFlags::empty(), 0.0, window_id as isize, None,
            number, click_count, 1.0,
        ).ok_or_else(|| anyhow::anyhow!("could not construct native window pointer event"))?;
        let ptr = cg_event(&ns);
        if ptr.is_null() {
            anyhow::bail!("native window pointer event has no CGEvent");
        }
        CFRetain(ptr as CFTypeRef);
        let event = CGEvent::from_ptr(ptr as _);
        event.set_flags(flags);
        CGEventSetLocation(ptr, point.0, point.1);
        super::skylight::set_integer_field(ptr, 3, button);
        super::skylight::set_integer_field(ptr, 7, 3);
        super::skylight::set_integer_field(ptr, 91, window_id as i64);
        super::skylight::set_integer_field(ptr, 92, window_id as i64);
        super::skylight::set_window_location(ptr, local.0, local.1);
        Ok(event)
    })
}

pub(super) fn focus_events(
    preparation: super::app_focus::Preparation,
    window_id: u32,
    activation_point: Option<((f64, f64), (f64, f64))>,
) -> anyhow::Result<Vec<CGEvent>> {
    use super::app_focus::Preparation;
    let (kind, subtype, window_number, flags) = match preparation {
        Preparation::None => return Ok(Vec::new()),
        Preparation::ReturnKeyFocus => (21, 0x8000u16 as i16, 0, 0),
        Preparation::Activate => (13, 1, window_id as isize, 0xc0000),
    };
    let notification = objc2::rc::autoreleasepool(|_| unsafe {
        let event = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
            NSEventType(kind), objc2_foundation::NSPoint::new(0.0, 0.0),
            NSEventModifierFlags(flags), 0.0, window_number, None, subtype, 0, 0,
        ).ok_or_else(|| anyhow::anyhow!("could not construct background focus notification"))?;
        let raw = cg_event(&event);
        if raw.is_null() {
            anyhow::bail!("background focus notification has no CGEvent");
        }
        CFRetain(raw as CFTypeRef);
        Ok(CGEvent::from_ptr(raw as _))
    })?;
    let mut events = vec![notification];
    if preparation == Preparation::Activate {
        if let Some((point, local)) = activation_point {
            for (kind, number) in [(1, 1), (2, 2)] {
                events.push(native_event(
                    kind,
                    0,
                    1,
                    number,
                    point,
                    local,
                    window_id,
                    CGEventFlags::empty(),
                )?);
            }
        }
    }
    Ok(events)
}

fn next_event_number() -> isize {
    static NUMBER: AtomicI64 = AtomicI64::new(1);
    NUMBER.fetch_add(1, Ordering::Relaxed) as isize
}

pub(super) fn post(pid: i32, event: &CGEvent) {
    unsafe {
        let mut clock: libc::timespec = std::mem::zeroed();
        if libc::clock_gettime(libc::CLOCK_UPTIME_RAW, &mut clock) == 0 {
            CGEventSetTimestamp(
                event.as_ptr() as *mut c_void,
                clock.tv_sec as u64 * 1_000_000_000 + clock.tv_nsec as u64,
            );
        }
    }
    if !super::skylight::post_to_pid(pid, event.as_ptr() as *mut c_void, false) {
        event.post_to_pid(pid);
    }
}

pub(crate) fn click_button(
    pid: i32,
    window_id: u32,
    point: (f64, f64),
    local: (f64, f64),
    count: usize,
    modifiers: &[&str],
    button: DragButton,
) -> anyhow::Result<()> {
    let (down, up, button) = match button {
        DragButton::Left => (1, 2, 0),
        DragButton::Right => (3, 4, 1),
        DragButton::Middle => (25, 26, 2),
    };
    let flags = super::mouse::parse_modifier_flags(modifiers);
    let mut events = Vec::with_capacity(count * 2);
    for click_count in 1..=count {
        let number = next_event_number();
        events.push(native_event(
            down,
            button,
            click_count as isize,
            number,
            point,
            local,
            window_id,
            flags,
        )?);
        events.push(native_event(
            up,
            button,
            click_count as isize,
            number,
            point,
            local,
            window_id,
            flags,
        )?);
    }
    super::skylight::prepare_background_pointer(pid, window_id)?;
    for event in &events {
        post(pid, event);
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    extern "C" {
        fn CGEventGetType(event: *mut c_void) -> u32;
    }

    #[test]
    fn activation_uses_notification_then_paired_native_activation_click() {
        let events = focus_events(
            super::super::app_focus::Preparation::Activate,
            1234,
            Some(((620.0, 350.0), (20.0, 50.0))),
        )
        .unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(
            unsafe { CGEventGetType(events[0].as_ptr() as *mut c_void) },
            13
        );
        for (index, event) in events.iter().enumerate().skip(1) {
            assert_eq!(event.get_integer_value_field(0), index as i64);
            assert_eq!(event.get_integer_value_field(1), 1);
            assert_eq!(event.get_integer_value_field(7), 3);
            assert_eq!(event.get_integer_value_field(91), 1234);
            assert_eq!(event.get_flags(), CGEventFlags::empty());
        }
        assert_eq!(events[1].get_type() as u32, 1);
        assert_eq!(events[2].get_type() as u32, 2);
        assert_eq!(events[0].get_flags().bits(), 0xc0000);
    }

    #[test]
    fn focus_return_never_clicks_activation_point() {
        let events = focus_events(
            super::super::app_focus::Preparation::ReturnKeyFocus,
            1234,
            Some(((620.0, 350.0), (20.0, 50.0))),
        )
        .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            unsafe { CGEventGetType(events[0].as_ptr() as *mut c_void) },
            21
        );
        objc2::rc::autoreleasepool(|_| unsafe {
            let notification: *mut NSEvent = objc2::msg_send![objc2::class!(NSEvent), eventWithCGEvent: events[0].as_ptr() as *mut ObjcCGEvent];
            assert!(!notification.is_null());
            assert_eq!((*notification).r#type().0, 21);
            assert_eq!((*notification).subtype().0, 0x8000u16 as i16);
            assert_eq!((*notification).windowNumber(), 0);
        });
        assert_eq!(events[0].get_flags(), CGEventFlags::empty());
    }

    #[test]
    fn native_pointer_carries_exact_window_and_explicit_flags_without_posting() {
        let event = native_event(
            6,
            0,
            0,
            17,
            (620.0, 350.0),
            (20.0, 50.0),
            1234,
            CGEventFlags::CGEventFlagShift,
        )
        .unwrap();
        assert_eq!((event.location().x, event.location().y), (620.0, 350.0));
        assert_eq!(event.get_integer_value_field(3), 0);
        assert_eq!(event.get_integer_value_field(7), 3);
        assert_eq!(event.get_integer_value_field(91), 1234);
        assert_eq!(event.get_integer_value_field(92), 1234);
        assert_eq!(event.get_integer_value_field(1), 0);
        assert_eq!(event.get_flags(), CGEventFlags::CGEventFlagShift);
    }
}
