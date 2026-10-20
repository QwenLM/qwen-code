//! Chromium opt-in and readiness are distinct: accepted ManualAccessibility
//! may still expose only a shell. Only explicit AX observations wait for web
//! content, using a caller-owned deadline shared with application selection.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::bindings::{
    copy_children_with_status, copy_string_attr_with_status, enable_chromium_accessibility,
    AXUIElementRef, AXUIElementSetMessagingTimeout, AccessibilityOptIn,
};
use core_foundation::base::{CFRelease, CFTypeRef};

type ProcessStartStamp = (u64, u64);
const RETRY_BACKOFF: Duration = Duration::from_secs(30);
const MAX_WAIT_ATTEMPTS: u32 = 3;
const POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChromiumReadiness {
    NotApplicable,
    Ready,
    Pending(Option<ProcessStartStamp>),
}

#[derive(Clone, Copy, Debug)]
struct ProcessEnablement {
    stamp: ProcessStartStamp,
    ready: bool,
    attempts: u32,
    attempted_at: Option<Instant>,
}

pub(crate) fn process_start_stamp(pid: i32) -> Option<ProcessStartStamp> {
    // SAFETY: proc_pidinfo writes at most `size` bytes into `info` and returns
    // the number of bytes filled (<= size) or <= 0 on failure.
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let filled = libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        );
        if filled != size {
            return None;
        }
        Some((info.pbi_start_tvsec, info.pbi_start_tvusec))
    }
}

fn enabled_processes() -> &'static Mutex<HashMap<i32, ProcessEnablement>> {
    static ENABLED: OnceLock<Mutex<HashMap<i32, ProcessEnablement>>> = OnceLock::new();
    ENABLED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_lifetime_is_current(
    cached: &ProcessEnablement,
    observed: Option<ProcessStartStamp>,
) -> bool {
    observed == Some(cached.stamp)
}

fn should_wait(cached: Option<ProcessEnablement>, now: Instant) -> bool {
    cached.is_none_or(|cached| {
        !cached.ready
            && cached.attempts < MAX_WAIT_ATTEMPTS
            && cached
                .attempted_at
                .is_none_or(|at| now.saturating_duration_since(at) >= RETRY_BACKOFF)
    })
}

fn merge_state(
    cached: Option<ProcessEnablement>,
    stamp: ProcessStartStamp,
    ready: bool,
    attempted_at: Option<Instant>,
) -> ProcessEnablement {
    let cached = cached.filter(|cached| cached.stamp == stamp);
    ProcessEnablement {
        stamp,
        ready: ready || cached.is_some_and(|cached| cached.ready),
        attempts: cached.map_or(0, |cached| cached.attempts) + u32::from(attempted_at.is_some()),
        attempted_at: attempted_at.or(cached.and_then(|cached| cached.attempted_at)),
    }
}

fn remember(
    pid: i32,
    stamp: Option<ProcessStartStamp>,
    ready: bool,
    attempted_at: Option<Instant>,
) {
    let Some(stamp) = stamp else { return };
    if let Ok(mut cache) = enabled_processes().lock() {
        // Serialize the identity check with publication: an old completion
        // must not overwrite a newer lifetime that was already cached.
        if process_start_stamp(pid) != Some(stamp) {
            return;
        }
        let state = merge_state(cache.get(&pid).copied(), stamp, ready, attempted_at);
        cache.insert(pid, state);
    }
}

// Every borrowed root and retained child gets its own remaining AX timeout.
unsafe fn probe_web_area(
    element: AXUIElementRef,
    depth: usize,
    visits: &mut usize,
    deadline: Instant,
) -> bool {
    if depth == 0 || *visits == 0 || Instant::now() >= deadline {
        return false;
    }
    *visits -= 1;
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .as_secs_f32();
    let _ = AXUIElementSetMessagingTimeout(element, remaining.min(0.1).max(0.001));
    if copy_string_attr_with_status(element, "AXRole")
        .value
        .as_deref()
        == Some("AXWebArea")
    {
        return true;
    }
    if Instant::now() >= deadline {
        return false;
    }
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .as_secs_f32();
    let _ = AXUIElementSetMessagingTimeout(element, remaining.min(0.1).max(0.001));
    let children = copy_children_with_status(element);
    let mut found = false;
    for child in children.elements {
        if !found {
            found = probe_web_area(child, depth - 1, visits, deadline);
        }
        CFRelease(child as CFTypeRef);
    }
    found
}

unsafe fn await_web_content(app_element: AXUIElementRef, deadline: Instant) -> bool {
    while Instant::now() < deadline {
        let mut visits = 400;
        if probe_web_area(app_element, 10, &mut visits, deadline) {
            return true;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        std::thread::sleep(remaining.min(POLL_INTERVAL));
    }
    false
}

/// `app_element` must remain a valid application AX element for `pid`.
/// A missing deadline permits opt-in, but never a materialization wait.
pub(crate) unsafe fn ensure_chromium_ax_enabled(
    pid: i32,
    app_element: AXUIElementRef,
    readiness_deadline: Option<Instant>,
) -> ChromiumReadiness {
    let stamp = process_start_stamp(pid);
    let cached = enabled_processes()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&pid).copied())
        .filter(|cached| cached_lifetime_is_current(cached, stamp));
    if cached.is_some_and(|cached| cached.ready) {
        return ChromiumReadiness::Ready;
    }
    if cached.is_none() {
        if let Some(deadline) = readiness_deadline {
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_secs_f32();
            let _ = AXUIElementSetMessagingTimeout(app_element, remaining.min(0.1).max(0.001));
        }
        match enable_chromium_accessibility(app_element) {
            AccessibilityOptIn::NotAccepted => return ChromiumReadiness::NotApplicable,
            AccessibilityOptIn::EnhancedUserInterface => {
                remember(pid, stamp, true, None);
                return ChromiumReadiness::Ready;
            }
            AccessibilityOptIn::ManualAccessibility => remember(pid, stamp, false, None),
        }
    }
    let now = Instant::now();
    if let Some(deadline) = readiness_deadline.filter(|deadline| *deadline > now) {
        if should_wait(cached, now) {
            if await_web_content(app_element, deadline) {
                remember(pid, stamp, true, None);
                return ChromiumReadiness::Ready;
            }
            remember(pid, stamp, false, Some(now));
        }
    }
    ChromiumReadiness::Pending(stamp)
}

// A real walk can discover naturally materialized content during cooldown.
// That positive evidence also prevents a late timeout from downgrading Ready.
pub(crate) fn complete_chromium_observation(
    pid: i32,
    readiness: ChromiumReadiness,
    web_area_seen: bool,
) -> bool {
    match readiness {
        ChromiumReadiness::Pending(stamp) if web_area_seen => {
            remember(pid, stamp, true, None);
            true
        }
        ChromiumReadiness::Pending(_) => false,
        ChromiumReadiness::Ready | ChromiumReadiness::NotApplicable => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_stamp_reads_the_current_process_and_rejects_dead_pids() {
        let own = process_start_stamp(std::process::id() as i32);
        assert!(own.is_some(), "own process start time must be readable");
        // Pid 0 is the kernel idle task; proc info for it is not readable from
        // user space, so lifetime keying must fail closed (None).
        assert_eq!(process_start_stamp(0), None);
    }

    #[test]
    fn distinct_lifetimes_do_not_alias() {
        // Two different processes must not produce identical (pid, stamp)
        // cache keys. Use launchd (pid 1) vs our own process.
        let own_pid = std::process::id() as i32;
        let own = process_start_stamp(own_pid);
        let launchd = process_start_stamp(1);
        if let (Some(own), Some(launchd)) = (own, launchd) {
            assert_ne!(
                (own_pid, own),
                (1, launchd),
                "cache keys must differ across processes"
            );
        }
    }

    #[test]
    fn accepted_is_pending_and_cooldown_does_not_prevent_positive_promotion() {
        let now = Instant::now();
        let pending = merge_state(None, (100, 10), false, None);
        assert!(should_wait(Some(pending), now));
        let timed_out = merge_state(Some(pending), pending.stamp, false, Some(now));
        assert!(!should_wait(
            Some(timed_out),
            now + Duration::from_millis(100)
        ));
        let ready = merge_state(Some(timed_out), timed_out.stamp, true, None);
        assert!(ready.ready);
        assert!(!should_wait(Some(ready), now + RETRY_BACKOFF));
        let late = merge_state(Some(ready), ready.stamp, false, Some(now));
        assert!(
            late.ready,
            "a late timeout must not downgrade positive evidence"
        );
    }

    #[test]
    fn no_wait_does_not_consume_attempts_and_new_lifetime_does_not_alias() {
        let now = Instant::now();
        let pending = merge_state(None, (100, 10), false, None);
        let again = merge_state(Some(pending), pending.stamp, false, None);
        assert_eq!(again.attempts, 0);
        assert!(should_wait(Some(again), now));
        assert!(!cached_lifetime_is_current(&again, None));
        assert!(!cached_lifetime_is_current(&again, Some((101, 20))));
        let old_ready = merge_state(Some(again), again.stamp, true, None);
        let relaunched = merge_state(Some(old_ready), (101, 20), false, None);
        assert!(!relaunched.ready);
        assert_eq!(relaunched.attempts, 0);
    }

    #[test]
    fn a_later_walk_with_web_area_is_complete_even_without_a_cacheable_stamp() {
        assert!(!complete_chromium_observation(
            0,
            ChromiumReadiness::Pending(None),
            false
        ));
        assert!(complete_chromium_observation(
            0,
            ChromiumReadiness::Pending(None),
            true
        ));
    }

    #[test]
    fn stale_completion_does_not_replace_the_live_lifetime_or_its_ready_state() {
        let pid = std::process::id() as i32;
        let stamp = process_start_stamp(pid).expect("own process start time");
        remember(pid, Some(stamp), true, None);
        let stale_stamp = (stamp.0.saturating_sub(1), stamp.1);
        assert_ne!(stale_stamp, stamp);
        remember(pid, Some(stale_stamp), false, Some(Instant::now()));
        let cached = enabled_processes().lock().unwrap()[&pid];
        assert_eq!(cached.stamp, stamp);
        assert!(cached.ready);
        enabled_processes().lock().unwrap().remove(&pid);
    }
}
