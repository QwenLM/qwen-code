//! Live process queries for hosts that do not drive AppKit's main run loop.
//!
//! NSWorkspace.runningApplications and NSRunningApplication's active/terminated
//! properties only refresh on a main-run-loop turn. Embedded Node hosts can
//! therefore retain the initial app list indefinitely. These Process Manager
//! APIs are deprecated, but query live state without taking over the host loop.

#[repr(C)]
#[derive(Default)]
struct ProcessSerialNumber {
    high: u32,
    low: u32,
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    // Processes.h declares OSErr as a signed 16-bit value, OSStatus as 32-bit.
    fn GetNextProcess(process: *mut ProcessSerialNumber) -> i16;
    fn GetFrontProcess(process: *mut ProcessSerialNumber) -> i16;
    fn GetProcessPID(process: *const ProcessSerialNumber, pid: *mut libc::pid_t) -> i32;
}

fn pid_for_process(process: &ProcessSerialNumber) -> Option<i32> {
    let mut pid = 0;
    let status = unsafe { GetProcessPID(process, &mut pid) };
    (status == 0 && pid > 0).then_some(pid)
}

pub(super) fn running_pids() -> Vec<i32> {
    let mut process = ProcessSerialNumber::default();
    let mut pids = Vec::new();
    loop {
        match unsafe { GetNextProcess(&mut process) } {
            0 => {
                // An application can exit between enumeration and PID lookup.
                if let Some(pid) = pid_for_process(&process) {
                    pids.push(pid);
                }
            }
            -600 => break, // procNotFound: normal end of enumeration.
            status => {
                tracing::warn!(status, "Process Manager app enumeration failed");
                break;
            }
        }
    }
    pids
}

pub(super) fn frontmost_pid() -> Option<i32> {
    let mut process = ProcessSerialNumber::default();
    if unsafe { GetFrontProcess(&mut process) } != 0 {
        return None;
    }
    pid_for_process(&process)
}
