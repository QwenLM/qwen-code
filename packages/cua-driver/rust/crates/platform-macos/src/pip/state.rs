use std::collections::HashMap;

use cua_driver_core::pip_hook::PipTarget;

#[derive(Default)]
pub(super) struct Sessions {
    pub entries: HashMap<String, Preview>,
    serial: u64,
}

pub(super) struct Preview {
    pub generation: u64,
    pub targets: Vec<PipTarget>,
    pub frame: Frame,
    pub queued: bool,
}

pub(super) enum Frame {
    Pending,
    Invalid,
    Ready(super::Scene),
}

impl Sessions {
    pub fn observe(&mut self, target: PipTarget) {
        self.serial += 1;
        let preview = self
            .entries
            .entry(target.session.clone())
            .or_insert(Preview {
                generation: self.serial,
                targets: Vec::new(),
                frame: Frame::Pending,
                queued: false,
            });
        preview.generation = self.serial;
        preview.frame = Frame::Pending;
        preview
            .targets
            .retain(|old| old.window_id != target.window_id);
        preview.targets.push(target);
        if preview.targets.len() > 2 {
            preview.targets.remove(0);
        }
    }

    pub fn publish(&mut self, session: &str, generation: u64, frame: Option<super::Scene>) -> bool {
        let Some(preview) = self
            .entries
            .get_mut(session)
            .filter(|preview| preview.generation == generation)
        else {
            return false;
        };
        preview.frame = frame.map_or(Frame::Invalid, Frame::Ready);
        if preview.queued {
            false
        } else {
            preview.queued = true;
            true
        }
    }

    pub fn take_frame(&mut self, session: &str) -> Option<(u64, Frame)> {
        self.entries.get_mut(session).map(|preview| {
            preview.queued = false;
            (
                preview.generation,
                std::mem::replace(&mut preview.frame, Frame::Pending),
            )
        })
    }

    pub fn remove_runtime(&mut self, prefix: &str) -> Vec<String> {
        let keys: Vec<_> = self
            .entries
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect();
        for key in &keys {
            self.entries.remove(key);
        }
        keys
    }

    pub fn matches(&self, session: &str, generation: u64) -> bool {
        self.entries
            .get(session)
            .is_some_and(|preview| preview.generation == generation)
    }
}

pub(super) fn fit(source: (u32, u32), box_size: (u32, u32)) -> (u32, u32, u32, u32) {
    let scale = (box_size.0 as f64 / source.0.max(1) as f64)
        .min(box_size.1 as f64 / source.1.max(1) as f64);
    let width = ((source.0 as f64 * scale).round() as u32).clamp(1, box_size.0.max(1));
    let height = ((source.1 as f64 * scale).round() as u32).clamp(1, box_size.1.max(1));
    (
        (box_size.0 - width) / 2,
        (box_size.1 - height) / 2,
        width,
        height,
    )
}

pub(super) struct Layout {
    pub size: (f64, f64),
    pub frames: Vec<[f64; 4]>,
    pub controls: [f64; 4],
}

pub(super) fn layout(sizes: &[(u32, u32)], front: usize, bounds: (f64, f64)) -> Layout {
    let tallest_ratio = sizes
        .iter()
        .map(|&(width, height)| f64::from(height.max(1)) / f64::from(width.max(1)))
        .fold(1.0_f64 / 100.0, f64::max);
    let width = bounds.0.max(1.0).min(bounds.1.max(1.0) / tallest_ratio);
    let stacked = sizes.len() > 1;
    let offset_x = if stacked { (width * 0.14).round() } else { 0.0 };
    let offset_y = if stacked { (width * 0.11).round() } else { 0.0 };
    let frames: Vec<_> = sizes
        .iter()
        .enumerate()
        .map(|(index, &(source_width, source_height))| {
            let behind = stacked && index != front;
            [
                12.0 + if behind { 0.0 } else { offset_x },
                12.0 + if behind { offset_y } else { 0.0 },
                width,
                width * f64::from(source_height.max(1)) / f64::from(source_width.max(1)),
            ]
        })
        .collect();
    let top = frames
        .iter()
        .max_by(|a, b| (a[1] + a[3]).total_cmp(&(b[1] + b[3])))
        .copied()
        .unwrap_or([12.0, 12.0, width, 1.0]);
    Layout {
        size: (
            (width + offset_x + 24.0).max(offset_x + 104.0),
            width * tallest_ratio + offset_y + 44.0,
        ),
        controls: [top[0] + 8.0, top[1] + top[3] - 10.0, 72.0, 30.0],
        frames,
    }
}

pub(super) struct Motion {
    pub value: [f64; 4],
    velocity: [f64; 4],
}

impl Motion {
    pub fn new(value: [f64; 4]) -> Self {
        Self {
            value,
            velocity: [0.0; 4],
        }
    }

    pub fn step(&mut self, target: [f64; 4], dt: f64) -> bool {
        let omega = 22.0;
        let decay = (-omega * dt).exp();
        let mut moving = false;
        for (index, target) in target.into_iter().enumerate() {
            let offset = self.value[index] - target;
            let combined = self.velocity[index] + omega * offset;
            self.value[index] = target + (offset + combined * dt) * decay;
            self.velocity[index] = (self.velocity[index] - omega * combined * dt) * decay;
            if (self.value[index] - target).abs() < 0.05 && self.velocity[index].abs() < 0.1 {
                self.value[index] = target;
                self.velocity[index] = 0.0;
            } else {
                moving = true;
            }
        }
        moving
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn target(session: &str, window_id: u32) -> PipTarget {
        PipTarget {
            session: session.into(),
            pid: 1,
            window_id,
            is_live: Arc::new(|| true),
        }
    }

    #[test]
    fn recency_and_cleanup_are_owned_by_session_and_runtime() {
        let mut sessions = Sessions::default();
        sessions.observe(target("a/one", 1));
        let old = sessions.entries["a/one"].generation;
        sessions.observe(target("a/one", 2));
        sessions.observe(target("a/one", 1));
        assert_eq!(
            sessions.entries["a/one"]
                .targets
                .iter()
                .map(|t| t.window_id)
                .collect::<Vec<_>>(),
            [2, 1]
        );
        sessions.observe(target("a/one", 3));
        assert_eq!(
            sessions.entries["a/one"]
                .targets
                .iter()
                .map(|t| t.window_id)
                .collect::<Vec<_>>(),
            [1, 3]
        );
        assert!(!sessions.matches("a/one", old));
        sessions.observe(target("b/two", 1));
        assert_eq!(sessions.remove_runtime("a/"), ["a/one"]);
        assert!(sessions.entries.contains_key("b/two"));
        sessions.entries.remove("b/two");
        sessions.observe(target("b/two", 4));
        assert_eq!(sessions.entries["b/two"].targets.len(), 1);
    }

    #[test]
    fn late_generations_cannot_reopen_and_only_latest_frame_is_queued() {
        let mut sessions = Sessions::default();
        sessions.observe(target("owner", 1));
        let old = sessions.entries["owner"].generation;
        sessions.observe(target("owner", 2));
        let current = sessions.entries["owner"].generation;
        let frame = |value| {
            Some(super::super::Scene {
                cards: vec![super::super::Card {
                    window_id: 1,
                    png: Some(vec![value]),
                    size: (1, 1),
                    label: String::new(),
                }],
                targets: Vec::new(),
            })
        };
        assert!(!sessions.publish("owner", old, frame(1)));
        assert!(sessions.publish("owner", current, frame(2)));
        assert!(!sessions.publish("owner", current, frame(3)));
        let Frame::Ready(captured) = sessions.take_frame("owner").unwrap().1 else {
            panic!("the latest published frame must be ready");
        };
        assert_eq!(captured.cards[0].png, Some(vec![3]));
        sessions.entries.remove("owner");
        assert!(!sessions.publish("owner", current, frame(4)));
        sessions.observe(target("owner", 1));
        assert!(!sessions.publish("owner", current, frame(5)));
    }

    #[test]
    fn proportional_fit_keeps_letterboxing_and_source_scale_coherent() {
        assert_eq!(fit((2000, 1000), (600, 400)), (0, 50, 600, 300));
        assert_eq!(fit((1000, 2000), (600, 400)), (200, 0, 200, 400));
        assert_eq!(fit((1000, 500), (600, 400)), fit((2000, 1000), (600, 400)));
    }

    #[test]
    fn cards_share_width_keep_source_ratios_and_use_a_stable_drag_envelope() {
        let sizes = [(1600, 1200), (1600, 900)];
        let first = layout(&sizes, 0, (400.0, 300.0));
        let second = layout(&sizes, 1, (400.0, 300.0));
        assert_eq!(first.size, second.size);
        assert_eq!(first.frames[0], [68.0, 12.0, 400.0, 300.0]);
        assert_eq!(first.frames[1], [12.0, 56.0, 400.0, 225.0]);
        assert_eq!(second.frames[0], [12.0, 56.0, 400.0, 300.0]);
        assert_eq!(second.frames[1], [68.0, 12.0, 400.0, 225.0]);
        for shape in [first, second] {
            for rect in shape.frames.iter().chain(std::iter::once(&shape.controls)) {
                assert!(rect[0] >= 0.0 && rect[1] >= 0.0);
                assert!(rect[0] + rect[2] <= shape.size.0);
                assert!(rect[1] + rect[3] <= shape.size.1);
            }
        }
    }

    #[test]
    fn portrait_source_scales_all_cards_together_without_stretching() {
        let result = layout(&[(500, 2000), (1600, 900)], 1, (400.0, 300.0));
        assert_eq!(result.frames[0][2], 75.0);
        assert_eq!(result.frames[1][2], 75.0);
        assert_eq!(result.frames[0][3], 300.0);
        assert_eq!(result.frames[1][3], 42.1875);
        let single = layout(&[(1600, 900)], 0, (400.0, 300.0));
        assert_eq!(single.frames[0], [12.0, 12.0, 400.0, 225.0]);
        let narrow = layout(&[(1, 4000)], 0, (400.0, 300.0));
        assert!(narrow.controls[0] + narrow.controls[2] < narrow.size.0);
    }

    #[test]
    fn interrupted_motion_preserves_position_and_velocity_until_the_next_step() {
        let mut motion = Motion::new([0.0; 4]);
        let target = [56.0, 44.0, 0.0, 0.0];
        for _ in 0..5 {
            assert!(motion.step(target, 1.0 / 60.0));
        }
        let current = motion.value;
        assert!(current[0] > 0.0 && current[0] < target[0]);
        let velocity = motion.velocity;
        assert!(velocity[0] > 0.0);
        motion.step([0.0; 4], 1.0 / 6000.0);
        assert!((motion.value[0] - current[0]).abs() < 0.1);
        assert!(
            motion.velocity[0] > 0.0,
            "retargeting must not erase existing velocity"
        );
        for _ in 0..120 {
            motion.step([0.0; 4], 1.0 / 60.0);
        }
        assert_eq!(motion.value, [0.0; 4]);
        assert!(!motion.step([0.0; 4], 1.0 / 60.0));
    }
}
