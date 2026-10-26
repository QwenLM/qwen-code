use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::c_void;

use objc2::declare::ClassBuilder;
use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2::{class, msg_send, sel};
use objc2_foundation::{NSPoint, NSRect, NSSize};

use super::{PipSink, CONTROLLER};

pub(super) const HEADER_HEIGHT: u32 = 28;

struct Handles {
    panel: *mut AnyObject,
    image: *mut AnyObject,
    label: *mut AnyObject,
    button: *mut AnyObject,
}

thread_local! {
    static WINDOWS: RefCell<HashMap<String, Handles>> = RefCell::new(HashMap::new());
}

#[link(name = "dispatch", kind = "dylib")]
extern "C" {
    static _dispatch_main_q: u8;
    fn dispatch_async_f(
        queue: *const c_void,
        context: *mut c_void,
        work: unsafe extern "C" fn(*mut c_void),
    );
}

fn dispatch(value: String, callback: unsafe extern "C" fn(*mut c_void)) {
    unsafe {
        dispatch_async_f(
            &raw const _dispatch_main_q as *const c_void,
            Box::into_raw(Box::new(value)) as *mut c_void,
            callback,
        );
    }
}

pub(super) fn draw(session: String) {
    dispatch(session, draw_callback);
}

pub(super) fn close(session: String) {
    dispatch(session, close_callback);
}

unsafe extern "C" fn draw_callback(context: *mut c_void) {
    let session = *Box::from_raw(context as *mut String);
    objc2::rc::autoreleasepool(|_| {
        let Some(controller) = CONTROLLER.get() else {
            return;
        };
        let current = controller.sessions.lock().unwrap().take_frame(&session);
        let Some((generation, scene)) = current else {
            close_now(&session);
            return;
        };
        let Some(scene) = scene else {
            close_now(&session);
            return;
        };
        if !crate::permissions::status::screen_recording_granted()
            || scene
                .targets
                .iter()
                .any(|target| !super::target_is_live(target))
        {
            controller.remove_if_current(&session, generation);
            close_now(&session);
            return;
        }
        if !controller
            .sessions
            .lock()
            .unwrap()
            .matches(&session, generation)
        {
            return;
        }
        WINDOWS.with(|windows| {
            let mut windows = windows.borrow_mut();
            let slot = windows.len();
            if !windows.contains_key(&session) {
                let Some(handles) = create(&controller.config, slot) else { return; };
                windows.insert(session.clone(), handles);
            }
            let handles = &windows[&session];
            let data: *mut AnyObject = msg_send![class!(NSData), dataWithBytes: scene.png.as_ptr() as *const c_void length: scene.png.len()];
            let image: *mut AnyObject = msg_send![class!(NSImage), alloc];
            let image: *mut AnyObject = msg_send![image, initWithData: data];
            if !image.is_null() {
                let _: () = msg_send![handles.image, setImage: image];
                let _: () = msg_send![image, release];
            }
            let _: () = msg_send![handles.label, setStringValue: string(&scene.label)];
            let _: () = msg_send![handles.panel, orderFrontRegardless];
        });
    });
}

unsafe extern "C" fn close_callback(context: *mut c_void) {
    let session = *Box::from_raw(context as *mut String);
    objc2::rc::autoreleasepool(|_| close_now(&session));
}

unsafe fn close_now(session: &str) {
    WINDOWS.with(|windows| {
        if let Some(handles) = windows.borrow_mut().remove(session) {
            let _: () = msg_send![handles.panel, orderOut: std::ptr::null_mut::<AnyObject>()];
            let _: () = msg_send![handles.panel, close];
            let _: () = msg_send![handles.panel, release];
        }
    });
}

unsafe fn string(value: &str) -> *mut AnyObject {
    let bytes = value.as_bytes();
    let string: *mut AnyObject = msg_send![class!(NSString), alloc];
    let string: *mut AnyObject = msg_send![string, initWithBytes: bytes.as_ptr() as *const c_void length: bytes.len() encoding: 4usize];
    msg_send![string, autorelease]
}

fn panel_class() -> &'static AnyClass {
    static CLASS: std::sync::OnceLock<&AnyClass> = std::sync::OnceLock::new();
    CLASS.get_or_init(|| {
        let mut builder = ClassBuilder::new("QwenCuPreviewPanel", class!(NSPanel)).unwrap();
        unsafe {
            builder.add_method(
                sel!(canBecomeKeyWindow),
                never_key as extern "C" fn(_, _) -> _,
            );
            builder.add_method(
                sel!(canBecomeMainWindow),
                never_key as extern "C" fn(_, _) -> _,
            );
            builder.add_method(sel!(closePreview:), close_clicked as extern "C" fn(_, _, _));
        }
        builder.register()
    })
}

extern "C" fn never_key(_this: &AnyObject, _selector: Sel) -> Bool {
    Bool::NO
}

extern "C" fn close_clicked(_this: &AnyObject, _selector: Sel, sender: *mut AnyObject) {
    let session = WINDOWS.with(|windows| {
        windows
            .borrow()
            .iter()
            .find(|(_, handles)| handles.button == sender)
            .map(|(key, _)| key.clone())
    });
    if let (Some(controller), Some(session)) = (CONTROLLER.get(), session) {
        controller.remove_session(&session);
    }
}

fn header_class() -> &'static AnyClass {
    static CLASS: std::sync::OnceLock<&AnyClass> = std::sync::OnceLock::new();
    CLASS.get_or_init(|| {
        let mut builder = ClassBuilder::new("QwenCuPreviewDragHeader", class!(NSView)).unwrap();
        unsafe {
            builder.add_method(sel!(mouseDown:), drag_header as extern "C" fn(_, _, _));
            builder.add_method(
                sel!(acceptsFirstMouse:),
                accepts_mouse as extern "C" fn(_, _, _) -> _,
            );
        }
        builder.register()
    })
}

extern "C" fn accepts_mouse(_this: &AnyObject, _selector: Sel, _event: *mut AnyObject) -> Bool {
    Bool::YES
}

extern "C" fn drag_header(this: &AnyObject, _selector: Sel, event: *mut AnyObject) {
    unsafe {
        let window: *mut AnyObject = msg_send![this, window];
        let _: () = msg_send![window, performWindowDragWithEvent: event];
    }
}

fn label_class() -> &'static AnyClass {
    static CLASS: std::sync::OnceLock<&AnyClass> = std::sync::OnceLock::new();
    CLASS.get_or_init(|| {
        let mut builder = ClassBuilder::new("QwenCuPreviewLabel", class!(NSTextField)).unwrap();
        unsafe {
            builder.add_method(sel!(hitTest:), passive_label as extern "C" fn(_, _, _) -> _);
        }
        builder.register()
    })
}

extern "C" fn passive_label(_this: &AnyObject, _selector: Sel, _point: NSPoint) -> *mut AnyObject {
    std::ptr::null_mut()
}

unsafe fn create(config: &pip_preview::PipConfig, slot: usize) -> Option<Handles> {
    let screen: *mut AnyObject = msg_send![class!(NSScreen), mainScreen];
    if screen.is_null() {
        return None;
    }
    let screen_frame: NSRect = msg_send![screen, visibleFrame];
    let width = config.geometry.width as f64;
    let height = config.geometry.height as f64;
    let (x, y) = match (config.geometry.x, config.geometry.y) {
        (Some(x), Some(y)) => (
            x as f64,
            screen_frame.origin.y + screen_frame.size.height - y as f64 - height,
        ),
        _ => (
            screen_frame.origin.x + screen_frame.size.width
                - width
                - 24.0
                - (slot % 5) as f64 * 18.0,
            screen_frame.origin.y + screen_frame.size.height
                - height
                - 24.0
                - (slot % 5) as f64 * 36.0,
        ),
    };
    let rect = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
    let panel: *mut AnyObject = msg_send![panel_class(), alloc];
    let panel: *mut AnyObject =
        msg_send![panel, initWithContentRect: rect styleMask: 128u64 backing: 2u64 defer: false];
    if panel.is_null() {
        return None;
    }
    let _: () = msg_send![panel, setReleasedWhenClosed: false];
    // NSWindowAnimationBehaviorNone keeps shutdown's UI acknowledgment synchronous.
    let _: () = msg_send![panel, setAnimationBehavior: 2isize];
    let _: () = msg_send![panel, setTitle: string(&config.title)];
    let _: () = msg_send![panel, setFloatingPanel: true];
    let _: () = msg_send![panel, setBecomesKeyOnlyIfNeeded: true];
    let _: () = msg_send![panel, setHidesOnDeactivate: false];
    let _: () = msg_send![panel, setMovableByWindowBackground: false];
    let _: () = msg_send![panel, setLevel: 3i64];
    let _: () = msg_send![panel, setCollectionBehavior: ((1 << 0) | (1 << 4) | (1 << 6) | (1 << 7) | (1 << 8)) as u64];
    let color: *mut AnyObject =
        msg_send![class!(NSColor), colorWithCalibratedWhite: 0.1f64 alpha: 1.0f64];
    let _: () = msg_send![panel, setBackgroundColor: color];
    let view: *mut AnyObject = msg_send![panel, contentView];
    let body_height = height - HEADER_HEIGHT as f64;
    let image: *mut AnyObject = msg_send![class!(NSImageView), alloc];
    let image: *mut AnyObject = msg_send![image, initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, body_height))];
    let _: () = msg_send![image, setImageScaling: 3u64];
    let _: () = msg_send![view, addSubview: image];
    let _: () = msg_send![image, release];
    let header: *mut AnyObject = msg_send![header_class(), alloc];
    let header: *mut AnyObject = msg_send![header, initWithFrame: NSRect::new(NSPoint::new(0.0, body_height), NSSize::new(width, HEADER_HEIGHT as f64))];
    let label: *mut AnyObject = msg_send![label_class(), alloc];
    let label: *mut AnyObject = msg_send![label, initWithFrame: NSRect::new(NSPoint::new(10.0, 5.0), NSSize::new(width - 46.0, 18.0))];
    let _: () = msg_send![label, setBezeled: false];
    let _: () = msg_send![label, setDrawsBackground: false];
    let _: () = msg_send![label, setEditable: false];
    let _: () = msg_send![label, setSelectable: false];
    let text_color: *mut AnyObject = msg_send![class!(NSColor), whiteColor];
    let _: () = msg_send![label, setTextColor: text_color];
    let font: *mut AnyObject = msg_send![class!(NSFont), systemFontOfSize: 11.0f64];
    let _: () = msg_send![label, setFont: font];
    let _: () = msg_send![header, addSubview: label];
    let _: () = msg_send![label, release];
    let button: *mut AnyObject = msg_send![class!(NSButton), alloc];
    let button: *mut AnyObject = msg_send![button, initWithFrame: NSRect::new(NSPoint::new(width - 28.0, 2.0), NSSize::new(24.0, 24.0))];
    let _: () = msg_send![button, setTitle: string("×")];
    let _: () = msg_send![button, setToolTip: string("Close preview")];
    let _: () = msg_send![button, setAccessibilityLabel: string("Close preview")];
    let _: () = msg_send![button, setBezelStyle: 2u64];
    let _: () = msg_send![button, setTarget: panel];
    let _: () = msg_send![button, setAction: sel!(closePreview:)];
    let _: () = msg_send![header, addSubview: button];
    let _: () = msg_send![button, release];
    let _: () = msg_send![view, addSubview: header];
    let _: () = msg_send![header, release];
    Some(Handles {
        panel,
        image,
        label,
        button,
    })
}
