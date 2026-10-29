// Called synchronously by the Node host while native UI or paste cleanup is live.
#[napi]
pub fn pump_main_run_loop() -> napi::Result<()> {
    #[cfg(target_os = "macos")]
    unsafe {
        use std::ffi::c_void;
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            static kCFRunLoopDefaultMode: *const c_void;
            fn CFRunLoopRunInMode(
                mode: *const c_void,
                seconds: f64,
                return_after_source: u8,
            ) -> i32;
            fn pthread_main_np() -> i32;
        }
        #[link(name = "AppKit", kind = "framework")]
        extern "C" {
            static NSApp: *mut c_void;
        }
        #[link(name = "objc", kind = "dylib")]
        extern "C" {
            fn objc_getClass(name: *const std::ffi::c_char) -> *mut c_void;
            fn sel_registerName(name: *const std::ffi::c_char) -> *mut c_void;
            fn objc_msgSend();
        }
        if pthread_main_np() == 0 {
            return Err(napi::Error::from_reason(
                "macOS native UI requires the Node main thread; Worker threads cannot service AppKit callbacks",
            ));
        }
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let send_void: unsafe extern "C" fn(*mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        let send_event: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        let next_event: unsafe extern "C" fn(
            *mut c_void,
            *mut c_void,
            usize,
            *mut c_void,
            *const c_void,
            i8,
        ) -> *mut c_void = std::mem::transmute(objc_msgSend as *const ());
        let pool = send(
            objc_getClass(c"NSAutoreleasePool".as_ptr()),
            sel_registerName(c"new".as_ptr()),
        );
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.0, 1);
        let app = NSApp;
        if !app.is_null() {
            let deadline = send(
                objc_getClass(c"NSDate".as_ptr()),
                sel_registerName(c"distantPast".as_ptr()),
            );
            let started = std::time::Instant::now();
            for _ in 0..32 {
                let event = next_event(
                    app,
                    sel_registerName(c"nextEventMatchingMask:untilDate:inMode:dequeue:".as_ptr()),
                    usize::MAX,
                    deadline,
                    kCFRunLoopDefaultMode,
                    1,
                );
                if event.is_null() {
                    break;
                }
                send_event(app, sel_registerName(c"sendEvent:".as_ptr()), event);
                if started.elapsed() >= std::time::Duration::from_millis(2) {
                    break;
                }
            }
            send_void(app, sel_registerName(c"updateWindows".as_ptr()));
        }
        send_void(pool, sel_registerName(c"drain".as_ptr()));
    }
    Ok(())
}
