//! Local, read-only previews of successfully observed, authorized windows.

mod native;
mod state;

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cua_driver_core::pip_hook::{self, PipSink, PipTarget};
use image::{ImageFormat, Pixel, Rgba, RgbaImage};
use pip_preview::PipConfig;

struct Scene {
    cards: Vec<Card>,
    targets: Vec<PipTarget>,
}

struct Card {
    window_id: u32,
    png: Option<Vec<u8>>,
    size: (u32, u32),
    label: String,
}

struct Controller {
    config: PipConfig,
    sessions: Mutex<state::Sessions>,
    sampling: Mutex<bool>,
    busy: Mutex<HashMap<String, usize>>,
    drained: tokio::sync::Notify,
}

static CONTROLLER: OnceLock<Arc<Controller>> = OnceLock::new();

pub fn initialize(config: &PipConfig) -> anyhow::Result<()> {
    if !config.enabled {
        return Ok(());
    }
    if let Some(controller) = CONTROLLER.get() {
        pip_hook::set_pip_sink(Some(controller.clone()));
        return Ok(());
    }
    crate::cursor::overlay::initialize_appkit_on_main_thread().map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        (160..=2048).contains(&config.geometry.width)
            && (120..=2048).contains(&config.geometry.height),
        "preview geometry is outside the supported range"
    );
    let controller = CONTROLLER.get_or_init(|| {
        Arc::new(Controller {
            config: config.clone(),
            sessions: Mutex::new(state::Sessions::default()),
            sampling: Mutex::new(false),
            busy: Mutex::new(HashMap::new()),
            drained: tokio::sync::Notify::new(),
        })
    });
    pip_hook::set_pip_sink(Some(controller.clone()));
    Ok(())
}

pub async fn flush_runtime(prefix: &str) -> anyhow::Result<()> {
    if let Some(controller) = CONTROLLER.get() {
        controller.wait_runtime(prefix).await?;
    }
    Ok(())
}

struct SampleJob {
    targets: Vec<PipTarget>,
    session: String,
    generation: u64,
    // Drop the target snapshots before acknowledging this capture's cleanup.
    _lease: Arc<SampleLease>,
}

struct SampleLease {
    controller: Arc<Controller>,
    session: String,
}

impl Drop for SampleLease {
    fn drop(&mut self) {
        let mut busy = self.controller.busy.lock().unwrap();
        let count = busy.get_mut(&self.session).expect("active preview capture");
        *count -= 1;
        if *count == 0 {
            busy.remove(&self.session);
        }
        self.controller.drained.notify_waiters();
    }
}

pub fn run_appkit_main_loop() {
    crate::cursor::overlay::run_appkit_main_loop();
}

impl PipSink for Controller {
    fn observe(&self, target: PipTarget) {
        if target.session.is_empty()
            || target.pid <= 0
            || target.window_id == 0
            || !(target.is_live)()
        {
            return;
        }
        let pid = target.pid;
        let Some(target) = bind_process_lifetime(target, move || {
            crate::ax::enablement::process_start_stamp(pid)
        }) else {
            return;
        };
        if !target_is_live(&target) {
            return;
        }
        self.sessions.lock().unwrap().observe(target);
        let mut sampling = self.sampling.lock().unwrap();
        if !*sampling {
            *sampling = true;
            let controller = CONTROLLER.get().unwrap().clone();
            if let Err(error) = std::thread::Builder::new()
                .name("cua-preview".into())
                .spawn(move || controller.sample())
            {
                *sampling = false;
                tracing::warn!("could not start window preview: {error}");
            }
        }
    }

    fn remove_session(&self, session: &str) {
        self.sessions.lock().unwrap().entries.remove(session);
        native::close(session.to_owned());
    }

    fn remove_runtime(&self, prefix: &str) {
        let keys = self.sessions.lock().unwrap().remove_runtime(prefix);
        for key in keys {
            native::close(key);
        }
    }
}

impl Controller {
    async fn wait_runtime(&self, prefix: &str) -> anyhow::Result<()> {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let notified = self.drained.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if !self
                    .busy
                    .lock()
                    .unwrap()
                    .keys()
                    .any(|session| session.starts_with(prefix))
                {
                    return;
                }
                notified.await;
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("window preview capture did not drain before shutdown"))
    }

    fn sample(self: Arc<Self>) {
        loop {
            let started = Instant::now();
            let jobs: Vec<_> = {
                let sessions = self.sessions.lock().unwrap();
                let mut busy = self.busy.lock().unwrap();
                sessions
                    .entries
                    .iter()
                    .map(|(session, preview)| {
                        *busy.entry(session.clone()).or_default() += 1;
                        SampleJob {
                            targets: preview.targets.clone(),
                            session: session.clone(),
                            generation: preview.generation,
                            _lease: Arc::new(SampleLease {
                                controller: self.clone(),
                                session: session.clone(),
                            }),
                        }
                    })
                    .collect()
            };
            if jobs.is_empty() {
                // Take locks in observe's order so a new observation cannot miss startup.
                let sessions = self.sessions.lock().unwrap();
                let mut sampling = self.sampling.lock().unwrap();
                if sessions.entries.is_empty() {
                    *sampling = false;
                    return;
                }
                continue;
            }
            for job in jobs {
                let session = &job.session;
                let generation = job.generation;
                if !self.sessions.lock().unwrap().matches(session, generation) {
                    continue;
                }
                let live: Vec<_> = job
                    .targets
                    .iter()
                    .filter(|target| target_is_live(target))
                    .cloned()
                    .collect();
                if live.is_empty() {
                    self.remove_if_current(session, generation);
                    continue;
                }
                {
                    let mut sessions = self.sessions.lock().unwrap();
                    let Some(preview) = sessions
                        .entries
                        .get_mut(session)
                        .filter(|p| p.generation == generation)
                    else {
                        continue;
                    };
                    preview.targets = live.clone();
                }
                let scene = self.capture(live, job._lease.clone());
                if self
                    .sessions
                    .lock()
                    .unwrap()
                    .publish(session, generation, scene)
                {
                    native::draw(session.clone());
                }
            }
            std::thread::sleep(Duration::from_millis(333).saturating_sub(started.elapsed()));
        }
    }

    fn remove_if_current(&self, session: &str, generation: u64) {
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.matches(session, generation) {
            sessions.entries.remove(session);
            native::close(session.to_owned());
        }
    }

    fn capture(&self, targets: Vec<PipTarget>, lifetime: Arc<dyn Send + Sync>) -> Option<Scene> {
        let bounds = (
            self.config.geometry.width * 2,
            self.config.geometry.height * 2,
        );
        let cards = targets
            .iter()
            .map(|target| {
                if let Some((image, label)) = capture_target(target, lifetime.clone()) {
                    let size = image.dimensions();
                    let (_, _, width, height) = state::fit(size, bounds);
                    let image = image::imageops::resize(
                        &image,
                        width,
                        height,
                        image::imageops::FilterType::Triangle,
                    );
                    let mut png = Cursor::new(Vec::new());
                    let png = image
                        .write_to(&mut png, ImageFormat::Png)
                        .ok()
                        .map(|()| png.into_inner());
                    Card {
                        window_id: target.window_id,
                        png,
                        size,
                        label,
                    }
                } else {
                    let size = crate::windows::window_info_by_id(target.window_id)
                        .filter(|window| window.pid == target.pid)
                        .map(|window| {
                            (
                                window.bounds.width.max(1.0) as u32,
                                window.bounds.height.max(1.0) as u32,
                            )
                        })
                        .unwrap_or((bounds.0, bounds.1));
                    Card {
                        window_id: target.window_id,
                        png: None,
                        size,
                        label: "Window unavailable".into(),
                    }
                }
            })
            .collect();
        if targets.iter().any(|target| !(target.is_live)()) {
            return None;
        }
        Some(Scene { cards, targets })
    }
}

fn bind_process_lifetime(
    mut target: PipTarget,
    start_stamp: impl Fn() -> Option<(u64, u64)> + Send + Sync + 'static,
) -> Option<PipTarget> {
    let observed = start_stamp()?;
    let authorized = target.is_live;
    target.is_live = Arc::new(move || authorized() && start_stamp() == Some(observed));
    Some(target)
}

fn target_is_live(target: &PipTarget) -> bool {
    (target.is_live)()
        && crate::windows::window_info_by_id(target.window_id)
            .is_some_and(|window| window.pid == target.pid)
}

fn capture_target(
    target: &PipTarget,
    lifetime: Arc<dyn Send + Sync>,
) -> Option<(RgbaImage, String)> {
    if !(target.is_live)() || !crate::permissions::status::screen_recording_granted() {
        return None;
    }
    let before = crate::windows::window_info_by_id(target.window_id)?;
    if before.pid != target.pid {
        return None;
    }
    let png = crate::capture::screenshot_window_bytes_native(target.window_id, lifetime).ok()?;
    let after = crate::windows::window_info_by_id(target.window_id)?;
    if before.pid != after.pid
        || before.layer != after.layer
        || before.bounds.x != after.bounds.x
        || before.bounds.y != after.bounds.y
        || before.bounds.width != after.bounds.width
        || before.bounds.height != after.bounds.height
        || !(target.is_live)()
        || !crate::permissions::status::screen_recording_granted()
    {
        return None;
    }
    let mut image = image::load_from_memory(&png).ok()?.into_rgba8();
    let scale = crate::tools::px_frame::validate_capture_frame(
        target.window_id,
        &after.bounds,
        image.width(),
        image.height(),
    )
    .ok()?;
    if let Some(cursor) = crate::cursor::overlay::preview_cursor(&target.session) {
        paint_cursor(&mut image, &cursor, target.window_id, &after.bounds, scale);
    }
    Some((
        image,
        after
            .app_name
            .chars()
            .filter(|c| !c.is_control())
            .take(40)
            .collect(),
    ))
}

fn paint_cursor(
    image: &mut RgbaImage,
    cursor: &cursor_overlay::RenderStateCore,
    window_id: u32,
    bounds: &crate::windows::WindowBounds,
    scale: f64,
) {
    if !cursor.cfg.enabled
        || !cursor.visible
        || cursor.idle_alpha < 0.004
        || cursor.pinned_wid != Some(u64::from(window_id))
        || cursor.pos.0 < bounds.x
        || cursor.pos.1 < bounds.y
        || cursor.pos.0 >= bounds.x + bounds.width
        || cursor.pos.1 >= bounds.y + bounds.height
    {
        return;
    }
    let mut local = cursor.clone();
    local.pos = (cursor.pos.0 - bounds.x, cursor.pos.1 - bounds.y);
    let overlay = cursor_overlay::render_frame(
        &local,
        image.width(),
        image.height(),
        0.0,
        0.0,
        None,
        scale as f32,
    );
    for (pixel, mark) in image.pixels_mut().zip(overlay.pixels()) {
        if mark.alpha() != 0 {
            let straight = mark.demultiply();
            pixel.blend(&Rgba([
                straight.red(),
                straight.green(),
                straight.blue(),
                straight.alpha(),
            ]));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_uses_exact_window_and_logical_origin_before_retina_scaling() {
        let mut cursor =
            cursor_overlay::RenderStateCore::new(cursor_overlay::CursorConfig::default());
        cursor.pos = (125.0, 225.0);
        cursor.pinned_wid = Some(7);
        let bounds = crate::windows::WindowBounds {
            x: 100.0,
            y: 200.0,
            width: 100.0,
            height: 100.0,
        };
        let blank = RgbaImage::from_pixel(200, 200, Rgba([0, 0, 0, 255]));
        let mut image = blank.clone();
        paint_cursor(&mut image, &cursor, 8, &bounds, 2.0);
        assert_eq!(
            image, blank,
            "a different window must not inherit this cursor"
        );
        paint_cursor(&mut image, &cursor, 7, &bounds, 2.0);
        assert_ne!(image, blank);
        assert!(
            image
                .enumerate_pixels()
                .any(|(x, y, p)| x < 100 && y < 100 && p.0 != [0, 0, 0, 255]),
            "cursor must be near the source-local 50px position"
        );
        cursor.pos = (-275.0, -175.0);
        let negative_bounds = crate::windows::WindowBounds {
            x: -300.0,
            y: -200.0,
            ..bounds.clone()
        };
        let mut negative = blank.clone();
        paint_cursor(&mut negative, &cursor, 7, &negative_bounds, 2.0);
        assert_eq!(
            negative, image,
            "negative desktop origins must preserve window-local pixels"
        );
        cursor.pos = (125.0, 225.0);
        cursor.idle_alpha = 0.0;
        let mut hidden = blank.clone();
        paint_cursor(&mut hidden, &cursor, 7, &bounds, 2.0);
        assert_eq!(hidden, blank, "idle fade must propagate to the preview");
    }

    #[tokio::test]
    async fn runtime_drain_waits_for_owned_snapshots_without_stopping_another_owner() {
        let controller = Arc::new(Controller {
            config: PipConfig::default(),
            sessions: Mutex::new(state::Sessions::default()),
            sampling: Mutex::new(false),
            busy: Mutex::new(HashMap::from([("a/one".into(), 1), ("b/two".into(), 1)])),
            drained: tokio::sync::Notify::new(),
        });
        let marker = Arc::new(());
        let weak = Arc::downgrade(&marker);
        let owned = marker.clone();
        drop(marker);
        let job = SampleJob {
            targets: vec![PipTarget {
                session: "a/one".into(),
                pid: 1,
                window_id: 2,
                is_live: Arc::new(move || {
                    let _ = &owned;
                    true
                }),
            }],
            session: "a/one".into(),
            generation: 1,
            _lease: Arc::new(SampleLease {
                controller: controller.clone(),
                session: "a/one".into(),
            }),
        };
        let waiting = controller.clone();
        let drain = tokio::spawn(async move { waiting.wait_runtime("a/").await });
        tokio::task::yield_now().await;
        assert!(!drain.is_finished());
        assert!(weak.upgrade().is_some());
        let native_capture = job._lease.clone();
        drop(job);
        tokio::task::yield_now().await;
        assert!(
            !drain.is_finished(),
            "an Apple callback may outlive its caller's timeout"
        );
        drop(native_capture);
        drain.await.unwrap().unwrap();
        assert!(
            weak.upgrade().is_none(),
            "owner snapshots must drop before acknowledging cleanup"
        );
        assert!(controller.busy.lock().unwrap().contains_key("b/two"));
    }

    #[test]
    fn pid_reuse_or_unprovable_process_identity_invalidates_preview_authority() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let make_target = || PipTarget {
            session: "owner".into(),
            pid: 1,
            window_id: 2,
            is_live: Arc::new(|| true),
        };
        assert!(bind_process_lifetime(make_target(), || None).is_none());
        let stamp = Arc::new(AtomicU64::new(7));
        let current = stamp.clone();
        let target = bind_process_lifetime(make_target(), move || {
            match current.load(Ordering::SeqCst) {
                0 => None,
                value => Some((value, 0)),
            }
        })
        .unwrap();
        assert!((target.is_live)());
        stamp.store(8, Ordering::SeqCst);
        assert!(
            !(target.is_live)(),
            "the same PID must not inherit a prior process's preview"
        );
        stamp.store(0, Ordering::SeqCst);
        assert!(!(target.is_live)(), "missing identity must fail closed");
    }

    #[test]
    fn revoked_observation_never_reaches_native_capture() {
        let target = PipTarget {
            session: "ended".into(),
            pid: 1,
            window_id: 2,
            is_live: Arc::new(|| false),
        };
        assert!(capture_target(&target, Arc::new(())).is_none());
        assert!(!target_is_live(&target));
    }
}
