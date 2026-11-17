use std::time::{Duration, Instant};

const LAUNCH_LOOKUP_BUDGET: Duration = Duration::from_secs(1);

pub(crate) fn lookup_deadline(readiness_deadline: Option<Instant>) -> Option<Instant> {
    // Both App selection and raw AX observations construct readiness from the
    // same observation start. Preserve that anchor across native consumers.
    readiness_deadline?
        .checked_sub(cua_driver_core::tool::AX_READINESS_BUDGET)?
        .checked_add(LAUNCH_LOOKUP_BUDGET)
}

pub(crate) fn is_still_launching(pid: i32) -> bool {
    unsafe {
        objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .is_some_and(|app| !app.isFinishedLaunching())
    }
}

pub(crate) fn retry_pause(
    pid: i32,
    deadline: Option<Instant>,
    attempt_started: Instant,
) -> Option<Duration> {
    let deadline = deadline?;
    if Instant::now() >= deadline || !is_still_launching(pid) {
        return None;
    }
    let now = Instant::now();
    let attempt_duration = now.saturating_duration_since(attempt_started);
    let remaining = deadline.checked_duration_since(now)?;
    let slack = remaining.checked_sub(attempt_duration)?;
    (!slack.is_zero()).then_some(slack.min(Duration::from_millis(50)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_keeps_the_original_observation_anchor_and_no_wait_mode() {
        let start = Instant::now();
        let readiness = start + cua_driver_core::tool::AX_READINESS_BUDGET;
        assert_eq!(
            lookup_deadline(Some(readiness)),
            Some(start + Duration::from_secs(1))
        );
        assert_eq!(lookup_deadline(None), None);
        assert_eq!(retry_pause(0, None, start), None);
        assert_eq!(retry_pause(0, Some(start), start), None);
    }
}
