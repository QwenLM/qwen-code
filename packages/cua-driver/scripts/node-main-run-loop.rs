// Called synchronously by the Node host while a native paste is pending.
#[napi]
pub fn pump_main_run_loop() -> napi::Result<()> {
    #[cfg(target_os = "macos")]
    unsafe {
        use std::ffi::c_void;
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            static kCFRunLoopDefaultMode: *const c_void;
            fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, return_after_source: u8) -> i32;
            fn pthread_main_np() -> i32;
        }
        if pthread_main_np() == 0 {
            return Err(napi::Error::from_reason(
                "macOS paste requires the Node main thread; Worker threads cannot service AppKit callbacks",
            ));
        }
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.0, 1);
    }
    Ok(())
}
