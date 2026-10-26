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
    pub frame: Option<super::Scene>,
    pub queued: bool,
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
                frame: None,
                queued: false,
            });
        preview.generation = self.serial;
        preview.frame = None;
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
        preview.frame = frame;
        if preview.queued {
            false
        } else {
            preview.queued = true;
            true
        }
    }

    pub fn take_frame(&mut self, session: &str) -> Option<(u64, Option<super::Scene>)> {
        self.entries.get_mut(session).map(|preview| {
            preview.queued = false;
            (preview.generation, preview.frame.take())
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
                png: vec![value],
                label: String::new(),
                targets: Vec::new(),
            })
        };
        assert!(!sessions.publish("owner", old, frame(1)));
        assert!(sessions.publish("owner", current, frame(2)));
        assert!(!sessions.publish("owner", current, frame(3)));
        assert_eq!(sessions.take_frame("owner").unwrap().1.unwrap().png, [3]);
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
}
