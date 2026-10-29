use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;
use std::rc::Rc;
use std::time::Instant;

use objc2::declare::ClassBuilder;
use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2::{class, msg_send, sel};
use objc2_app_kit::NSWindowCollectionBehavior;
use objc2_foundation::{NSPoint, NSRect, NSSize};

use super::state::{self, Motion};
use super::{PipSink, Scene, CONTROLLER};

const COLLECTION_BEHAVIOR: NSWindowCollectionBehavior =
    NSWindowCollectionBehavior::CanJoinAllSpaces
        .union(NSWindowCollectionBehavior::Stationary)
        .union(NSWindowCollectionBehavior::IgnoresCycle)
        .union(NSWindowCollectionBehavior::FullScreenAuxiliary);

struct CardViews {
    shell: *mut AnyObject,
    image: *mut AnyObject,
}

struct Presentation {
    ids: Vec<u32>,
    sizes: Vec<(u32, u32)>,
    front: usize,
    bounds: (f64, f64),
    motions: Vec<Motion>,
    targets: Vec<[f64; 4]>,
    controls: Motion,
    controls_target: [f64; 4],
    opacity: f64,
    opacity_target: f64,
    last_tick: Instant,
    last_pointer: (f64, f64),
    hover_armed: bool,
}

impl Presentation {
    fn hover_rear(&mut self, point: (f64, f64)) -> bool {
        if self
            .targets
            .get(self.front)
            .is_some_and(|frame| contains(*frame, point))
            || !self.targets.iter().any(|frame| contains(*frame, point))
        {
            self.hover_armed = true;
        }
        let rear = (0..self.ids.len()).find(|&index| {
            index != self.front
                && self.hover_armed
                && !contains(self.controls_target, point)
                && !contains(self.targets[self.front], point)
                && contains(self.targets[index], point)
        });
        if let Some(front) = rear {
            // One promotion per entry into the rear slot, even while cards move.
            self.hover_armed = false;
            self.front = front;
            let layout = state::layout(&self.sizes, front, self.bounds);
            self.targets = layout.frames;
            self.controls_target = layout.controls;
            true
        } else {
            false
        }
    }

    fn retarget<R>(&mut self, now: Instant, change: impl FnOnce(&mut Self) -> R) -> R {
        // Elapsed time belongs to the old targets, including an interrupted motion's velocity.
        self.step_at(now, false);
        change(self)
    }

    fn step_at(&mut self, now: Instant, reduced: bool) -> bool {
        let dt = now.duration_since(self.last_tick).as_secs_f64().min(0.05);
        self.last_tick = now;
        let mut moving = false;
        for (motion, target) in self.motions.iter_mut().zip(&self.targets) {
            if reduced {
                *motion = Motion::new(*target);
            } else {
                moving |= motion.step(*target, dt);
            }
        }
        if reduced {
            self.controls = Motion::new(self.controls_target);
        } else {
            moving |= self.controls.step(self.controls_target, dt);
        }
        self.opacity += (self.opacity_target - self.opacity) * (1.0 - (-dt / 0.07).exp());
        if (self.opacity - self.opacity_target).abs() < 0.003 {
            self.opacity = self.opacity_target;
        } else {
            moving = true;
        }
        moving
    }
}

struct Handles {
    session: String,
    slot: usize,
    panel: *mut AnyObject,
    root: *mut AnyObject,
    cards: [CardViews; 2],
    controls: *mut AnyObject,
    button: *mut AnyObject,
    mover: *mut AnyObject,
    timer: Cell<*mut AnyObject>,
    closed: Cell<bool>,
    dragging: Cell<bool>,
    presentation: RefCell<Presentation>,
}

impl Drop for Handles {
    fn drop(&mut self) {
        // Executing callbacks retain their Rc through nested native dragging.
        unsafe {
            let _: () = msg_send![self.panel, release];
        }
    }
}

thread_local! {
    static WINDOWS: RefCell<HashMap<String, Rc<Handles>>> = RefCell::new(HashMap::new());
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

fn lookup(object: *const AnyObject) -> Option<Rc<Handles>> {
    WINDOWS.with(|windows| {
        windows
            .borrow()
            .values()
            .find(|handles| {
                [handles.panel, handles.root, handles.button, handles.mover]
                    .into_iter()
                    .chain(
                        handles
                            .cards
                            .iter()
                            .flat_map(|card| [card.shell, card.image]),
                    )
                    .any(|candidate| std::ptr::eq(candidate, object))
            })
            .cloned()
    })
}

unsafe extern "C" fn draw_callback(context: *mut c_void) {
    let session = *Box::from_raw(context as *mut String);
    objc2::rc::autoreleasepool(|_| {
        let Some(controller) = CONTROLLER.get() else {
            return;
        };
        let current = controller.sessions.lock().unwrap().take_frame(&session);
        let Some((generation, frame)) = current else {
            close_now(&session);
            return;
        };
        let scene = match frame {
            state::Frame::Pending => return,
            state::Frame::Invalid => {
                close_now(&session);
                return;
            }
            state::Frame::Ready(scene) => scene,
        };
        if scene.cards.is_empty()
            || !crate::permissions::status::screen_recording_granted()
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
        let existing = WINDOWS.with(|windows| windows.borrow().get(&session).cloned());
        let handles = match existing {
            Some(handles) => handles,
            None => {
                let Some(handles) = create(&session, &controller.config, &scene) else {
                    return;
                };
                if !controller
                    .sessions
                    .lock()
                    .unwrap()
                    .matches(&session, generation)
                {
                    shut(&handles);
                    return;
                }
                let current = WINDOWS.with(|windows| {
                    windows
                        .borrow_mut()
                        .entry(session.clone())
                        .or_insert_with(|| handles.clone())
                        .clone()
                });
                if !Rc::ptr_eq(&current, &handles) {
                    shut(&handles);
                }
                current
            }
        };
        update(&handles, &scene, &controller.config);
        let current = controller
            .sessions
            .lock()
            .unwrap()
            .matches(&session, generation);
        if !handles.closed.get() && current {
            let _: () = msg_send![handles.panel, orderFrontRegardless];
        }
    });
}

unsafe extern "C" fn close_callback(context: *mut c_void) {
    let session = *Box::from_raw(context as *mut String);
    objc2::rc::autoreleasepool(|_| close_now(&session));
}

unsafe fn close_now(session: &str) {
    let handles = WINDOWS.with(|windows| windows.borrow_mut().remove(session));
    if let Some(handles) = handles {
        shut(&handles);
    }
}

unsafe fn shut(handles: &Handles) {
    if handles.closed.replace(true) {
        return;
    }
    stop_timer(handles);
    let _: () = msg_send![handles.panel, orderOut: std::ptr::null_mut::<AnyObject>()];
    let _: () = msg_send![handles.panel, close];
}

unsafe fn string(value: &str) -> *mut AnyObject {
    let bytes = value.as_bytes();
    let value: *mut AnyObject = msg_send![class!(NSString), alloc];
    let value: *mut AnyObject = msg_send![value, initWithBytes: bytes.as_ptr() as *const c_void length: bytes.len() encoding: 4usize];
    msg_send![value, autorelease]
}

fn rect(value: [f64; 4]) -> NSRect {
    NSRect::new(
        NSPoint::new(value[0], value[1]),
        NSSize::new(value[2], value[3]),
    )
}

fn contains(frame: [f64; 4], point: (f64, f64)) -> bool {
    point.0 >= frame[0]
        && point.1 >= frame[1]
        && point.0 < frame[0] + frame[2]
        && point.1 < frame[1] + frame[3]
}

fn initial_origin(
    config: &pip_preview::PipConfig,
    screen: NSRect,
    size: (f64, f64),
    slot: usize,
) -> (f64, f64) {
    match (config.geometry.x, config.geometry.y) {
        (Some(x), Some(y)) => (
            f64::from(x),
            screen.origin.y + screen.size.height - f64::from(y) - size.1,
        ),
        _ => (
            screen.origin.x + screen.size.width - size.0 - 24.0 - (slot % 5) as f64 * 18.0,
            screen.origin.y + 24.0 + (slot % 5) as f64 * 36.0,
        ),
    }
}

fn preview_slot(occupied: impl Iterator<Item = usize>) -> usize {
    let occupied: Vec<_> = occupied.collect();
    (0..5)
        .find(|slot| !occupied.contains(slot))
        .unwrap_or(occupied.len() % 5)
}

unsafe fn available(panel: *mut AnyObject) -> Option<NSRect> {
    let mut screen: *mut AnyObject = if panel.is_null() {
        std::ptr::null_mut()
    } else {
        msg_send![panel, screen]
    };
    if screen.is_null() {
        screen = msg_send![class!(NSScreen), mainScreen];
    }
    if screen.is_null() {
        None
    } else {
        Some(msg_send![screen, visibleFrame])
    }
}

fn card_bounds(
    config: &pip_preview::PipConfig,
    sizes: &[(u32, u32)],
    screen: NSRect,
) -> (f64, f64) {
    let room = (
        (screen.size.width - 48.0).max(1.0),
        (screen.size.height - 48.0).max(1.0),
    );
    let bounds = (
        f64::from(config.geometry.width).min(room.0),
        f64::from(config.geometry.height).min(room.1),
    );
    let fits = |scale| {
        let layout = state::layout(sizes, 0, (bounds.0 * scale, bounds.1 * scale));
        layout.size.0 <= room.0 && layout.size.1 <= room.1
    };
    if fits(1.0) {
        return bounds;
    }
    let (mut low, mut high) = (0.0, 1.0);
    for _ in 0..20 {
        let middle = (low + high) / 2.0;
        if fits(middle) {
            low = middle;
        } else {
            high = middle;
        }
    }
    (bounds.0 * low, bounds.1 * low)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn preview_joins_fullscreen_as_an_auxiliary_window_only() {
        let fullscreen = NSWindowCollectionBehavior::FullScreenPrimary
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::FullScreenNone;
        assert_eq!(
            COLLECTION_BEHAVIOR & fullscreen,
            NSWindowCollectionBehavior::FullScreenAuxiliary
        );
        assert!(COLLECTION_BEHAVIOR.contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
        assert!(COLLECTION_BEHAVIOR.contains(NSWindowCollectionBehavior::IgnoresCycle));
    }

    fn presentation(now: Instant) -> Presentation {
        Presentation {
            ids: vec![1],
            sizes: vec![(400, 300)],
            front: 0,
            bounds: (400.0, 300.0),
            motions: vec![Motion::new([0.0; 4])],
            targets: vec![[0.0; 4]],
            controls: Motion::new([0.0; 4]),
            controls_target: [0.0; 4],
            opacity: 0.0,
            opacity_target: 0.0,
            last_tick: now,
            last_pointer: (0.0, 0.0),
            hover_armed: true,
        }
    }

    fn assert_frame(actual: [f64; 4], expected: [f64; 4]) {
        for (actual, expected) in actual.into_iter().zip(expected) {
            assert!((actual - expected).abs() < 1e-8, "{actual} != {expected}");
        }
    }

    #[test]
    fn superseded_draw_preserves_the_existing_panel_until_the_next_frame() {
        use std::sync::{Arc, Mutex};

        extern "C" fn order_out(_: &AnyObject, _: Sel, _: *mut AnyObject) {}
        extern "C" fn close(_: &AnyObject, _: Sel) {}
        extern "C" fn frame(_: &AnyObject, _: Sel) -> NSRect {
            rect([321.25, 654.5, 424.0, 247.0])
        }
        let mut builder =
            ClassBuilder::new("QwenCuPreviewDrawTestPanel", class!(NSObject)).unwrap();
        unsafe {
            builder.add_method(sel!(orderOut:), order_out as extern "C" fn(_, _, _));
            builder.add_method(sel!(close), close as extern "C" fn(_, _));
            builder.add_method(sel!(frame), frame as extern "C" fn(_, _) -> NSRect);
        }
        let panel_class = builder.register();
        let panel = unsafe { msg_send![panel_class, new] };
        let controller = CONTROLLER.get_or_init(|| {
            Arc::new(super::super::Controller {
                config: pip_preview::PipConfig::default(),
                sessions: Mutex::new(state::Sessions::default()),
                sampling: Mutex::new(false),
                busy: Mutex::new(HashMap::new()),
                drained: tokio::sync::Notify::new(),
            })
        });
        let session = "superseded-draw-test";
        let target = || cua_driver_core::pip_hook::PipTarget {
            session: session.into(),
            pid: 1,
            window_id: 1,
            is_live: Arc::new(|| true),
        };
        let scene = || Scene {
            cards: Vec::new(),
            targets: Vec::new(),
        };
        let nil = std::ptr::null_mut();
        let handles = Rc::new(Handles {
            session: session.into(),
            slot: 0,
            panel,
            root: nil,
            cards: std::array::from_fn(|_| CardViews {
                shell: nil,
                image: nil,
            }),
            controls: nil,
            button: nil,
            mover: nil,
            timer: Cell::new(nil),
            closed: Cell::new(false),
            dragging: Cell::new(false),
            presentation: RefCell::new(presentation(Instant::now())),
        });
        WINDOWS.with(|windows| windows.borrow_mut().insert(session.into(), handles.clone()));
        let generation = {
            let mut sessions = controller.sessions.lock().unwrap();
            sessions.observe(target());
            let first = sessions.entries[session].generation;
            assert!(sessions.publish(session, first, Some(scene())));
            sessions.observe(target());
            sessions.entries[session].generation
        };
        unsafe {
            draw_callback(Box::into_raw(Box::new(session.to_owned())).cast());
        }
        assert!(!handles.closed.get());
        WINDOWS.with(|windows| assert!(Rc::ptr_eq(&windows.borrow()[session], &handles)));
        let position: NSRect = unsafe { msg_send![handles.panel, frame] };
        assert_eq!((position.origin.x, position.origin.y), (321.25, 654.5));
        {
            let mut sessions = controller.sessions.lock().unwrap();
            assert!(sessions.publish(session, generation, Some(scene())));
            assert_eq!(sessions.take_frame(session).unwrap().0, generation);
            assert!(sessions.publish(session, generation, None));
        }
        unsafe {
            draw_callback(Box::into_raw(Box::new(session.to_owned())).cast());
        }
        assert!(
            handles.closed.get(),
            "an explicitly invalid frame still closes"
        );
        WINDOWS.with(|windows| assert!(!windows.borrow().contains_key(session)));
        controller.sessions.lock().unwrap().entries.remove(session);
    }

    #[test]
    fn hovering_the_rear_slot_swaps_once_until_the_pointer_leaves() {
        let start = Instant::now();
        let mut state = presentation(start);
        state.ids = vec![1, 2];
        state.sizes = vec![(1600, 900), (1600, 800)];
        state.targets = state::layout(&state.sizes, state.front, state.bounds).frames;
        state.motions = state.targets.iter().copied().map(Motion::new).collect();
        let mut swaps = 0;
        for tick in 1..=240 {
            let point = (30.0 + (tick % 3) as f64, 180.0);
            swaps += usize::from(
                state.retarget(start + Duration::from_millis(tick * 8), |state| {
                    state.hover_rear(point)
                }),
            );
        }
        assert_eq!(swaps, 1, "small pointer moves must not retrigger the swap");
        assert!(!state.hover_rear((420.0, 100.0)));
        assert!(state.hover_rear((30.0, 180.0)));
    }

    #[test]
    fn default_owners_are_staggered_but_explicit_positions_are_unchanged() {
        let mut config = pip_preview::PipConfig::default();
        let screen = rect([-1000.0, -200.0, 1800.0, 1000.0]);
        let size = (480.0, 388.0);
        let first = initial_origin(&config, screen, size, 0);
        let second = initial_origin(&config, screen, size, 1);
        assert_eq!(second, (first.0 - 18.0, first.1 + 36.0));
        assert_eq!(initial_origin(&config, screen, size, 5), first);
        config.geometry.x = Some(-400);
        config.geometry.y = Some(90);
        let explicit = initial_origin(&config, screen, size, 0);
        assert_eq!(explicit, (-400.0, 322.0));
        assert_eq!(initial_origin(&config, screen, size, 1), explicit);
    }

    #[test]
    fn closing_an_older_owner_frees_its_default_placement_slot() {
        let mut owners = vec![0, 1];
        assert_eq!(preview_slot(owners.iter().copied()), 2);
        owners.remove(0);
        let slot = preview_slot(owners.iter().copied());
        assert_eq!(slot, 0);
        let config = pip_preview::PipConfig::default();
        let screen = rect([0.0, 0.0, 1800.0, 1000.0]);
        assert_ne!(
            initial_origin(&config, screen, (400.0, 300.0), slot),
            initial_origin(&config, screen, (400.0, 300.0), owners[0])
        );
        assert!(preview_slot(0..5) < 5);
    }

    #[test]
    fn idle_time_is_not_consumed_by_new_motion_or_fade_targets() {
        let start = Instant::now();
        let mut state = presentation(start);
        let event = start + Duration::from_millis(250);
        state.retarget(event, |state| {
            state.targets[0] = [56.0, 44.0, 0.0, 0.0];
            state.controls_target = state.targets[0];
            state.opacity_target = 1.0;
        });
        state.step_at(event, false);
        assert_frame(state.motions[0].value, [0.0; 4]);
        assert_frame(state.controls.value, [0.0; 4]);
        assert_eq!(state.opacity, 0.0);
        state.step_at(event + Duration::from_secs_f64(1.0 / 60.0), false);
        assert!(state.motions[0].value[0] > 0.0 && state.motions[0].value[0] < 56.0);
        assert!(state.opacity > 0.0 && state.opacity < 1.0);
    }

    #[test]
    fn a_mid_motion_reversal_keeps_the_old_interval_and_velocity() {
        let start = Instant::now();
        let mut state = presentation(start);
        let target = [56.0, 44.0, 0.0, 0.0];
        state.targets[0] = target;
        let mut expected = Motion::new([0.0; 4]);
        state.step_at(start + Duration::from_millis(16), false);
        expected.step(target, 0.016);
        let event = start + Duration::from_millis(32);
        expected.step(target, 0.016);
        state.retarget(event, |state| state.targets[0] = [0.0; 4]);
        state.step_at(event, false);
        assert_frame(state.motions[0].value, expected.value);
        let next = event + Duration::from_millis(16);
        state.step_at(next, false);
        expected.step([0.0; 4], 0.016);
        assert_frame(state.motions[0].value, expected.value);
    }

    #[test]
    fn card_envelope_fits_available_screen_without_assuming_stack_offsets() {
        let mut config = pip_preview::PipConfig::default();
        config.geometry.width = 2048;
        config.geometry.height = 2048;
        let screen = rect([-1000.0, -200.0, 900.0, 650.0]);
        for sizes in [
            vec![(1600, 1200), (1600, 900)],
            vec![(500, 2000), (1600, 900)],
        ] {
            let bounds = card_bounds(&config, &sizes, screen);
            let layout = state::layout(&sizes, 0, bounds);
            assert!(layout.size.0 <= screen.size.width - 48.0);
            assert!(layout.size.1 <= screen.size.height - 48.0);
        }
    }
}

unsafe fn update(handles: &Rc<Handles>, scene: &Scene, config: &pip_preview::PipConfig) {
    if handles.closed.get() {
        return;
    }
    let Some(screen) = available(handles.panel) else {
        return;
    };
    let sizes: Vec<_> = scene.cards.iter().take(2).map(|card| card.size).collect();
    let ids: Vec<_> = scene
        .cards
        .iter()
        .take(2)
        .map(|card| card.window_id)
        .collect();
    let bounds = card_bounds(config, &sizes, screen);
    let (size, changed) = {
        let mut state = handles.presentation.borrow_mut();
        state.retarget(Instant::now(), |state| {
            let changed = state.ids != ids;
            if changed {
                state.front = ids.len() - 1;
            }
            let layout = state::layout(&sizes, state.front, bounds);
            if changed {
                let old_ids = state.ids.clone();
                let mut old: Vec<_> = std::mem::take(&mut state.motions)
                    .into_iter()
                    .map(Some)
                    .collect();
                state.motions = ids
                    .iter()
                    .enumerate()
                    .map(|(index, id)| {
                        old_ids
                            .iter()
                            .position(|old| old == id)
                            .and_then(|slot| old[slot].take())
                            .unwrap_or_else(|| Motion::new(layout.frames[index]))
                    })
                    .collect();
            }
            state.ids = ids;
            state.sizes = sizes;
            state.bounds = bounds;
            state.targets = layout.frames;
            state.controls_target = layout.controls;
            (layout.size, changed)
        })
    };
    let frame: NSRect = msg_send![handles.panel, frame];
    if (frame.size.width - size.0).abs() > 0.01 || (frame.size.height - size.1).abs() > 0.01 {
        let frame = rect([
            frame.origin.x + frame.size.width - size.0,
            frame.origin.y,
            size.0,
            size.1,
        ]);
        let _: () = msg_send![handles.panel, setFrame: frame display: true];
        let _: () = msg_send![handles.root, setFrame: rect([0.0, 0.0, size.0, size.1])];
    }
    for (index, views) in handles.cards.iter().enumerate() {
        if handles.closed.get() {
            return;
        }
        let card = scene.cards.get(index);
        let _: () = msg_send![views.shell, setHidden: card.is_none()];
        let Some(card) = card else {
            continue;
        };
        let mut image: *mut AnyObject = std::ptr::null_mut();
        if let Some(png) = &card.png {
            let data: *mut AnyObject = msg_send![class!(NSData), dataWithBytes: png.as_ptr() as *const c_void length: png.len()];
            image = msg_send![class!(NSImage), alloc];
            image = msg_send![image, initWithData: data];
        }
        // A missing/invalid capture clears the old source image immediately.
        let _: () = msg_send![views.image, setImage: image];
        if !image.is_null() {
            let _: () = msg_send![image, release];
        }
        let label = if card.png.is_some() {
            card.label.clone()
        } else {
            format!("{} — Window unavailable", card.label)
        };
        let _: () = msg_send![views.image, setAccessibilityLabel: string(&label)];
        let _: () = msg_send![views.image, setToolTip: string(&label)];
    }
    if changed {
        reorder(handles);
    }
    advance(handles);
}

unsafe fn reorder(handles: &Handles) {
    if handles.closed.get() {
        return;
    }
    let (front, count) = {
        let state = handles.presentation.borrow();
        (state.front, state.ids.len())
    };
    for index in (0..count)
        .filter(|&index| index != front)
        .chain(std::iter::once(front))
    {
        let _: () = msg_send![handles.root, addSubview: handles.cards[index].shell positioned: 1isize relativeTo: std::ptr::null_mut::<AnyObject>()];
    }
    let _: () = msg_send![handles.root, addSubview: handles.controls positioned: 1isize relativeTo: std::ptr::null_mut::<AnyObject>()];
}

unsafe fn advance(handles: &Rc<Handles>) {
    if handles.closed.get() {
        return;
    }
    let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
    let reduced: Bool = msg_send![workspace, accessibilityDisplayShouldReduceMotion];
    let (frames, controls, opacity, moving) = {
        let mut state = handles.presentation.borrow_mut();
        let moving = state.step_at(Instant::now(), reduced.as_bool());
        (
            state
                .motions
                .iter()
                .map(|motion| motion.value)
                .collect::<Vec<_>>(),
            state.controls.value,
            state.opacity,
            moving,
        )
    };
    let _: () = msg_send![class!(CATransaction), begin];
    let _: () = msg_send![class!(CATransaction), setDisableActions: true];
    for (views, frame) in handles.cards.iter().zip(frames) {
        let _: () = msg_send![views.shell, setFrame: rect(frame)];
        let _: () = msg_send![views.image, setFrame: rect([0.0, 0.0, frame[2], frame[3]])];
    }
    let _: () = msg_send![handles.controls, setFrame: rect(controls)];
    let _: () = msg_send![handles.button, setFrame: rect([0.0, 0.0, 28.0, controls[3]])];
    let _: () =
        msg_send![handles.mover, setFrame: rect([28.0, 0.0, controls[2] - 28.0, controls[3]])];
    let layer: *mut AnyObject = msg_send![handles.controls, layer];
    // Hide pixels at the layer, keeping the native AX close button available.
    let _: () = msg_send![layer, setOpacity: opacity as f32];
    let _: () = msg_send![class!(CATransaction), commit];
    if !handles.closed.get() && moving {
        start_timer(handles);
    } else {
        stop_timer(handles);
    }
}

unsafe fn start_timer(handles: &Handles) {
    if handles.closed.get() || !handles.timer.get().is_null() {
        return;
    }
    let timer: *mut AnyObject = msg_send![class!(NSTimer), timerWithTimeInterval: (1.0 / 60.0) target: handles.panel selector: sel!(previewTick:) userInfo: std::ptr::null_mut::<AnyObject>() repeats: true];
    let _: *mut AnyObject = msg_send![timer, retain];
    handles.timer.set(timer);
    let run_loop: *mut AnyObject = msg_send![class!(NSRunLoop), mainRunLoop];
    let _: () =
        msg_send![run_loop, addTimer: timer forMode: objc2_foundation::NSRunLoopCommonModes];
}

unsafe fn stop_timer(handles: &Handles) {
    let timer = handles.timer.replace(std::ptr::null_mut());
    if !timer.is_null() {
        let _: () = msg_send![timer, invalidate];
        let _: () = msg_send![timer, release];
    }
}

extern "C" fn timer_tick(this: &AnyObject, _selector: Sel, _timer: *mut AnyObject) {
    let Some(handles) = lookup(this) else {
        return;
    };
    objc2::rc::autoreleasepool(|_| unsafe {
        advance(&handles);
    });
}

extern "C" fn pointer_moved(this: &AnyObject, _selector: Sel, _event: *mut AnyObject) {
    let Some(handles) = lookup(this) else {
        return;
    };
    if handles.closed.get() || handles.dragging.get() {
        return;
    }
    unsafe {
        let point: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let frame: NSRect = msg_send![handles.panel, frame];
        let point_local = (point.x - frame.origin.x, point.y - frame.origin.y);
        let changed = {
            let mut state = handles.presentation.borrow_mut();
            if state.last_pointer == (point.x, point.y) {
                return;
            }
            state.retarget(Instant::now(), |state| {
                state.last_pointer = (point.x, point.y);
                state.opacity_target =
                    if contains([0.0, 0.0, frame.size.width, frame.size.height], point_local) {
                        1.0
                    } else {
                        0.0
                    };
                state.hover_rear(point_local)
            })
        };
        if changed {
            reorder(&handles);
        }
        advance(&handles);
    }
}

extern "C" fn drag_preview(this: &AnyObject, _selector: Sel, event: *mut AnyObject) {
    let Some(handles) = lookup(this) else {
        return;
    };
    if handles.closed.get() {
        return;
    }
    handles.dragging.set(true);
    handles
        .presentation
        .borrow_mut()
        .retarget(Instant::now(), |state| state.opacity_target = 1.0);
    unsafe {
        advance(&handles);
        let _: () = msg_send![handles.panel, performWindowDragWithEvent: event];
        handles.dragging.set(false);
        if handles.closed.get() {
            return;
        }
        let point: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        handles.presentation.borrow_mut().last_pointer = (point.x, point.y);
    }
}

fn request_close(handles: &Rc<Handles>) {
    if handles.closed.get() {
        return;
    }
    if let Some(controller) = CONTROLLER.get() {
        controller.remove_session(&handles.session);
    }
    unsafe {
        close_now(&handles.session);
    }
}

extern "C" fn close_clicked(this: &AnyObject, _selector: Sel, _sender: *mut AnyObject) {
    if let Some(handles) = lookup(this) {
        request_close(&handles);
    }
}

extern "C" fn close_accessible(this: &AnyObject, _selector: Sel) -> Bool {
    let Some(handles) = lookup(this) else {
        return Bool::NO;
    };
    request_close(&handles);
    Bool::YES
}

extern "C" fn close_button(this: &AnyObject, _selector: Sel) -> *mut AnyObject {
    lookup(this)
        .filter(|handles| !handles.closed.get())
        .map_or(std::ptr::null_mut(), |handles| handles.button)
}

extern "C" fn never_key(_this: &AnyObject, _selector: Sel) -> Bool {
    Bool::NO
}
extern "C" fn accepts_mouse(_this: &AnyObject, _selector: Sel, _event: *mut AnyObject) -> Bool {
    Bool::YES
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
            builder.add_method(
                sel!(accessibilityCloseButton),
                close_button as extern "C" fn(_, _) -> _,
            );
            builder.add_method(sel!(previewTick:), timer_tick as extern "C" fn(_, _, _));
        }
        builder.register()
    })
}

fn surface_class(image: bool) -> &'static AnyClass {
    static ROOT: std::sync::OnceLock<&AnyClass> = std::sync::OnceLock::new();
    static IMAGE: std::sync::OnceLock<&AnyClass> = std::sync::OnceLock::new();
    let slot = if image { &IMAGE } else { &ROOT };
    slot.get_or_init(|| {
        let mut builder = ClassBuilder::new(
            if image {
                "QwenCuPreviewImage"
            } else {
                "QwenCuPreviewSurface"
            },
            if image {
                class!(NSImageView)
            } else {
                class!(NSView)
            },
        )
        .unwrap();
        unsafe {
            builder.add_method(sel!(mouseDown:), drag_preview as extern "C" fn(_, _, _));
            builder.add_method(
                sel!(acceptsFirstMouse:),
                accepts_mouse as extern "C" fn(_, _, _) -> _,
            );
            if !image {
                for selector in [sel!(mouseMoved:), sel!(mouseEntered:), sel!(mouseExited:)] {
                    builder.add_method(selector, pointer_moved as extern "C" fn(_, _, _));
                }
            }
        }
        builder.register()
    })
}

fn button_class(mover: bool) -> &'static AnyClass {
    static CLOSE: std::sync::OnceLock<&AnyClass> = std::sync::OnceLock::new();
    static MOVE: std::sync::OnceLock<&AnyClass> = std::sync::OnceLock::new();
    let slot = if mover { &MOVE } else { &CLOSE };
    slot.get_or_init(|| {
        let mut builder = ClassBuilder::new(
            if mover {
                "QwenCuPreviewMove"
            } else {
                "QwenCuPreviewClose"
            },
            class!(NSButton),
        )
        .unwrap();
        unsafe {
            builder.add_method(
                sel!(acceptsFirstMouse:),
                accepts_mouse as extern "C" fn(_, _, _) -> _,
            );
            if mover {
                builder.add_method(sel!(mouseDown:), drag_preview as extern "C" fn(_, _, _));
            } else {
                builder.add_method(
                    sel!(accessibilityPerformPress),
                    close_accessible as extern "C" fn(_, _) -> _,
                );
            }
        }
        builder.register()
    })
}

unsafe fn rounded(view: *mut AnyObject, radius: f64, clips: bool) {
    let _: () = msg_send![view, setWantsLayer: true];
    let layer: *mut AnyObject = msg_send![view, layer];
    let _: () = msg_send![layer, setCornerRadius: radius];
    let _: () = msg_send![layer, setMasksToBounds: clips];
}

unsafe fn background(view: *mut AnyObject, white: f64, alpha: f64, radius: f64) {
    let color: *mut AnyObject =
        msg_send![class!(NSColor), colorWithCalibratedWhite: white alpha: alpha];
    let _: () = msg_send![view, setBoxType: 4usize];
    let _: () = msg_send![view, setTitlePosition: 0usize];
    let _: () = msg_send![view, setContentViewMargins: NSSize::new(0.0, 0.0)];
    let _: () = msg_send![view, setBorderWidth: 0.0f64];
    let _: () = msg_send![view, setCornerRadius: radius];
    let _: () = msg_send![view, setFillColor: color];
}

unsafe fn create(
    session: &str,
    config: &pip_preview::PipConfig,
    scene: &Scene,
) -> Option<Rc<Handles>> {
    let screen = available(std::ptr::null_mut())?;
    let sizes: Vec<_> = scene.cards.iter().take(2).map(|card| card.size).collect();
    let bounds = card_bounds(config, &sizes, screen);
    let layout = state::layout(&sizes, sizes.len() - 1, bounds);
    let (width, height) = layout.size;
    let slot =
        WINDOWS.with(|windows| preview_slot(windows.borrow().values().map(|handles| handles.slot)));
    let (x, y) = initial_origin(config, screen, layout.size, slot);
    let panel: *mut AnyObject = msg_send![panel_class(), alloc];
    let panel: *mut AnyObject = msg_send![panel, initWithContentRect: rect([x, y, width, height]) styleMask: 128u64 backing: 2u64 defer: false];
    if panel.is_null() {
        return None;
    }
    let _: () = msg_send![panel, setReleasedWhenClosed: false];
    let _: () = msg_send![panel, setAnimationBehavior: 2isize];
    let _: () = msg_send![panel, setTitle: string(&config.title)];
    let _: () = msg_send![panel, setFloatingPanel: true];
    let _: () = msg_send![panel, setBecomesKeyOnlyIfNeeded: true];
    let _: () = msg_send![panel, setHidesOnDeactivate: false];
    let _: () = msg_send![panel, setMovableByWindowBackground: false];
    let _: () = msg_send![panel, setAcceptsMouseMovedEvents: true];
    let _: () = msg_send![panel, setOpaque: false];
    let _: () = msg_send![panel, setHasShadow: false];
    // Keep a nonzero backing alpha so WindowServer can hit-test transparent gaps.
    let backing: *mut AnyObject =
        msg_send![class!(NSColor), colorWithCalibratedWhite: 0.0f64 alpha: (1.0f64 / 255.0)];
    let _: () = msg_send![panel, setBackgroundColor: backing];
    let _: () = msg_send![panel, setLevel: 3i64];
    let _: () = msg_send![panel, setCollectionBehavior: COLLECTION_BEHAVIOR];
    let root: *mut AnyObject = msg_send![surface_class(false), alloc];
    let root: *mut AnyObject = msg_send![root, initWithFrame: rect([0.0, 0.0, width, height])];
    let _: () = msg_send![panel, setContentView: root];
    let _: () = msg_send![root, release];
    let tracking: *mut AnyObject = msg_send![class!(NSTrackingArea), alloc];
    let tracking: *mut AnyObject = msg_send![tracking, initWithRect: rect([0.0; 4]) options: (1usize | 2 | 0x80 | 0x200 | 0x400) owner: root userInfo: std::ptr::null_mut::<AnyObject>()];
    let _: () = msg_send![root, addTrackingArea: tracking];
    let _: () = msg_send![tracking, release];
    let cards = std::array::from_fn(|_| {
        let shell: *mut AnyObject = msg_send![class!(NSBox), alloc];
        let shell: *mut AnyObject = msg_send![shell, initWithFrame: rect([0.0; 4])];
        rounded(shell, 12.0, false);
        background(shell, 0.18, 1.0, 12.0);
        let shadow: *mut AnyObject = msg_send![class!(NSShadow), alloc];
        let shadow: *mut AnyObject = msg_send![shadow, init];
        let color: *mut AnyObject =
            msg_send![class!(NSColor), colorWithCalibratedWhite: 0.0f64 alpha: 0.24f64];
        let _: () = msg_send![shadow, setShadowColor: color];
        let _: () = msg_send![shadow, setShadowBlurRadius: 7.0f64];
        let _: () = msg_send![shadow, setShadowOffset: NSSize::new(0.0, -2.0)];
        let _: () = msg_send![shell, setShadow: shadow];
        let _: () = msg_send![shadow, release];
        let image: *mut AnyObject = msg_send![surface_class(true), alloc];
        let image: *mut AnyObject = msg_send![image, initWithFrame: rect([0.0; 4])];
        rounded(image, 12.0, true);
        let _: () = msg_send![image, setImageScaling: 3u64];
        let _: () = msg_send![image, setAccessibilityElement: true];
        let _: () = msg_send![image, setAccessibilityRole: string("AXImage")];
        let _: () = msg_send![shell, addSubview: image];
        let _: () = msg_send![image, release];
        let _: () = msg_send![root, addSubview: shell];
        let _: () = msg_send![shell, release];
        CardViews { shell, image }
    });
    let controls: *mut AnyObject = msg_send![class!(NSBox), alloc];
    let controls: *mut AnyObject = msg_send![controls, initWithFrame: rect(layout.controls)];
    rounded(controls, 15.0, true);
    background(controls, 0.12, 0.92, 15.0);
    let make_button = |mover: bool| {
        let button: *mut AnyObject = msg_send![button_class(mover), alloc];
        let button: *mut AnyObject = msg_send![button, initWithFrame: rect([0.0; 4])];
        let title = if mover { "Move" } else { "×" };
        let label = if mover {
            "Move preview"
        } else {
            "Close preview"
        };
        let _: () = msg_send![button, setTitle: string(title)];
        let _: () = msg_send![button, setToolTip: string(label)];
        let _: () = msg_send![button, setAccessibilityLabel: string(label)];
        let _: () = msg_send![button, setAccessibilityHidden: false];
        let _: () = msg_send![button, setAccessibilityElement: true];
        let _: () = msg_send![button, setAccessibilityRole: string("AXButton")];
        let _: () = msg_send![button, setBordered: false];
        let white: *mut AnyObject = msg_send![class!(NSColor), whiteColor];
        let _: () = msg_send![button, setContentTintColor: white];
        let _: () = msg_send![button, setTarget: panel];
        if !mover {
            let _: () = msg_send![button, setAction: sel!(closePreview:)];
        }
        let _: () = msg_send![controls, addSubview: button];
        let _: () = msg_send![button, release];
        button
    };
    let button = make_button(false);
    let mover = make_button(true);
    let _: () = msg_send![root, addSubview: controls];
    let _: () = msg_send![controls, release];
    let point: NSPoint = msg_send![class!(NSEvent), mouseLocation];
    Some(Rc::new(Handles {
        session: session.to_owned(),
        slot,
        panel,
        root,
        cards,
        controls,
        button,
        mover,
        timer: Cell::new(std::ptr::null_mut()),
        closed: Cell::new(false),
        dragging: Cell::new(false),
        presentation: RefCell::new(Presentation {
            ids: Vec::new(),
            sizes: Vec::new(),
            front: 0,
            bounds,
            motions: Vec::new(),
            targets: Vec::new(),
            controls: Motion::new(layout.controls),
            controls_target: layout.controls,
            opacity: 0.0,
            opacity_target: 0.0,
            last_tick: Instant::now(),
            last_pointer: (point.x, point.y),
            hover_armed: true,
        }),
    }))
}
