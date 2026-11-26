//! Native background scrolling adapted from upstream #4861/#5079. Selection
//! is read-only; dispatch reveals one element without waiting or replaying.

use core_foundation::base::{CFRelease, CFRetain, CFTypeRef};
use std::time::{Duration, Instant};

use super::bindings::{
    copy_children, copy_element_attr, copy_string_attr, element_at_screen_position,
    element_screen_rect, kAXErrorSuccess, perform_action, AXUIElementGetPid, AXUIElementRef,
};

type Rect = [f64; 4];

struct Element(usize);

impl Drop for Element {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0 as CFTypeRef) };
    }
}

// Retained AX proxies already cross blocking workers in the element cache.
unsafe impl Send for Element {}

impl Element {
    fn ptr(&self) -> AXUIElementRef {
        self.0 as AXUIElementRef
    }
}

pub(crate) struct RevealTarget {
    element: Element,
    pub container_role: String,
}

impl RevealTarget {
    pub fn element_ptr(&self) -> usize {
        self.element.0
    }

    /// The caller holds the background mutation lease and has just gated this
    /// exact element. Consume the target so no retry can follow an AX error.
    pub unsafe fn dispatch(self, pid: i32, window_id: u32) -> Result<i32, &'static str> {
        if !belongs_to(self.element.ptr(), pid, window_id)
            || crate::windows::resolve_window_owner(pid, window_id)
                != crate::windows::WindowOwner::SamePid
        {
            return Err("The native scroll target no longer belongs to the requested window.");
        }
        Ok(perform_action(self.element.ptr(), "AXScrollToVisible"))
    }
}

unsafe fn belongs_to(element: AXUIElementRef, pid: i32, window_id: u32) -> bool {
    let mut owner = 0;
    AXUIElementGetPid(element, &mut owner) == kAXErrorSuccess
        && owner == pid
        && super::exact_target::element_window_id(element) == Some(window_id)
}

unsafe fn children(element: AXUIElementRef) -> Vec<Element> {
    copy_children(element)
        .into_iter()
        .map(|p| Element(p as usize))
        .collect()
}

fn valid_rect(rect: Rect) -> bool {
    rect.iter().all(|v| v.is_finite()) && rect[2] > 0.0 && rect[3] > 0.0
}

fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    if !valid_rect(a) || !valid_rect(b) {
        return None;
    }
    let left = a[0].max(b[0]);
    let top = a[1].max(b[1]);
    let right = (a[0] + a[2]).min(b[0] + b[2]);
    let bottom = (a[1] + a[3]).min(b[1] + b[3]);
    (right > left && bottom > top).then_some([left, top, right - left, bottom - top])
}

fn past_edge([fx, fy, fw, fh]: Rect, direction: &str, [x, y, w, h]: Rect) -> bool {
    match direction {
        "down" => y + h > fy + fh + 1.0 || (h <= 1.5 && y >= fy + fh - 2.5),
        "up" => y < fy - 1.0 || (h <= 1.5 && y <= fy + 1.5),
        "right" => x + w > fx + fw + 1.0 || (w <= 1.5 && x >= fx + fw - 2.5),
        "left" => x < fx - 1.0 || (w <= 1.5 && x <= fx + 1.5),
        _ => false,
    }
}

fn clips_axis(frame: Rect, direction: &str, rect: Rect) -> bool {
    let opposite = match direction {
        "down" => "up",
        "up" => "down",
        "left" => "right",
        "right" => "left",
        _ => return false,
    };
    past_edge(frame, direction, rect) || past_edge(frame, opposite, rect)
}

fn pick_target(
    viewport: Rect,
    direction: &str,
    distance: f64,
    nodes: &[(Rect, bool)],
) -> Option<usize> {
    let [vx, vy, vw, vh] = viewport;
    let mut best: Option<(usize, f64)> = None;
    for (index, (rect, _)) in nodes.iter().enumerate() {
        let [x, y, w, h] = *rect;
        if w <= 1.5 || h <= 1.5 {
            continue;
        }
        let (edge, goal, beyond, fits) = match direction {
            "down" => (y + h, vy + vh + distance, y + h > vy + vh + 1.0, h <= vh),
            "up" => (y, vy - distance, y < vy - 1.0, h <= vh),
            "right" => (x + w, vx + vw + distance, x + w > vx + vw + 1.0, w <= vw),
            "left" => (x, vx - distance, x < vx - 1.0, w <= vw),
            _ => return None,
        };
        let gap = (edge - goal).abs();
        if beyond && fits && best.is_none_or(|(_, old)| gap < old) {
            best = Some((index, gap));
        }
    }
    if let Some((index, _)) = best {
        return Some(index);
    }
    let vertical = matches!(direction, "up" | "down");
    let sliver = |r: &Rect| if vertical { r[3] <= 1.5 } else { r[2] <= 1.5 };
    let visible: Vec<(usize, f64)> = nodes
        .iter()
        .enumerate()
        .filter(|(_, (r, leaf))| {
            *leaf
                && !sliver(r)
                && r[0] >= vx
                && r[1] >= vy
                && r[0] + r[2] <= vx + vw
                && r[1] + r[3] <= vy + vh
        })
        .map(|(index, (r, _))| (index, if vertical { r[1] } else { r[0] }))
        .collect();
    let forward = matches!(direction, "down" | "right");
    let visible_edge = if forward {
        visible.last()
    } else {
        visible.first()
    }
    .map(|(index, _)| *index);
    let mut clamped: Vec<usize> = nodes
        .iter()
        .enumerate()
        .filter(|(index, (rect, leaf))| {
            // AX can clamp an earlier row to the far edge. Respect the known
            // visible document order before revealing another row.
            *leaf
                && sliver(rect)
                && past_edge(viewport, direction, *rect)
                && visible_edge.is_none_or(|edge| {
                    if forward {
                        *index > edge
                    } else {
                        *index < edge
                    }
                })
        })
        .map(|(index, _)| index)
        .collect();
    if clamped.is_empty() {
        return None;
    }
    if matches!(direction, "up" | "left") {
        clamped.reverse();
    }
    let mut starts: Vec<f64> = visible.into_iter().map(|(_, start)| start).collect();
    starts.sort_by(f64::total_cmp);
    starts.dedup_by(|a, b| (*a - *b).abs() < 2.0);
    let mut gaps: Vec<f64> = starts.windows(2).map(|p| p[1] - p[0]).collect();
    gaps.sort_by(f64::total_cmp);
    let pitch = gaps.get(gaps.len() / 2).copied().unwrap_or(40.0).max(8.0);
    let half = if vertical { vh } else { vw } / 2.0;
    let rows = ((distance - half) / pitch + 0.5).round().max(1.0) as usize;
    Some(clamped[rows.min(clamped.len()) - 1])
}

unsafe fn scroll_container(
    mut element: Element,
    direction: &str,
    deadline: Instant,
) -> Option<(Element, String)> {
    let mut inner = None;
    for _ in 0..40 {
        if Instant::now() >= deadline {
            return None;
        }
        let role = copy_string_attr(element.ptr(), "AXRole")?;
        if matches!(role.as_str(), "AXScrollArea" | "AXWebArea") {
            return Some(inner.unwrap_or((element, role)));
        }
        if matches!(role.as_str(), "AXWindow" | "AXApplication") {
            return None;
        }
        if inner.is_none() {
            if let Some(frame) = element_screen_rect(element.ptr()).filter(|r| valid_rect(*r)) {
                let clipped = children(element.ptr()).iter().any(|child| {
                    element_screen_rect(child.ptr())
                        .filter(|r| valid_rect(*r))
                        .is_some_and(|r| clips_axis(frame, direction, r))
                });
                if clipped {
                    CFRetain(element.ptr() as CFTypeRef);
                    inner = Some((Element(element.0), role));
                }
            }
        }
        element = Element(copy_element_attr(element.ptr(), "AXParent")? as usize);
    }
    None
}

/// Select from one exact window. The supplied element remains retained by the
/// blocking caller; the returned target owns its own reference across awaits.
pub(crate) unsafe fn prepare(
    pid: i32,
    window_id: u32,
    element: Option<usize>,
    point: (f64, f64),
    window: Rect,
    direction: &str,
    distance: f64,
) -> Option<RevealTarget> {
    if !valid_rect(window)
        || !distance.is_finite()
        || distance <= 0.0
        || !matches!(direction, "up" | "down" | "left" | "right")
        || crate::windows::resolve_window_owner(pid, window_id)
            != crate::windows::WindowOwner::SamePid
    {
        return None;
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    let start = if let Some(ptr) = element {
        CFRetain(ptr as CFTypeRef);
        Element(ptr)
    } else {
        if !point.0.is_finite()
            || !point.1.is_finite()
            || point.0 < window[0]
            || point.1 < window[1]
            || point.0 >= window[0] + window[2]
            || point.1 >= window[1] + window[3]
        {
            return None;
        }
        Element(element_at_screen_position(pid, point.0, point.1)? as usize)
    };
    if !belongs_to(start.ptr(), pid, window_id) {
        return None;
    }
    let (container, role) = scroll_container(start, direction, deadline)?;
    if !belongs_to(container.ptr(), pid, window_id) {
        return None;
    }
    let viewport = intersect(element_screen_rect(container.ptr())?, window)?;
    let mut stack: Vec<(Element, usize)> = children(container.ptr())
        .into_iter()
        .rev()
        .map(|child| (child, 1))
        .collect();
    let mut elements = Vec::new();
    let mut nodes = Vec::new();
    let mut visited = 0;
    while let Some((element, depth)) = stack.pop() {
        if Instant::now() >= deadline || visited >= 4_000 {
            return None;
        }
        visited += 1;
        let rect = element_screen_rect(element.ptr()).filter(|r| valid_rect(*r));
        let behind = rect.is_some_and(|[x, y, w, h]| match direction {
            "down" => y + h < viewport[1],
            "up" => y > viewport[1] + viewport[3],
            "right" => x + w < viewport[0],
            "left" => x > viewport[0] + viewport[2],
            _ => false,
        });
        let mut leaf = true;
        if !behind {
            let descendants = children(element.ptr());
            leaf = descendants.is_empty();
            if depth >= 80 && !leaf {
                return None;
            }
            stack.extend(
                descendants
                    .into_iter()
                    .rev()
                    .map(|child| (child, depth + 1)),
            );
        }
        if let Some(rect) = rect.filter(|_| !behind) {
            nodes.push((rect, leaf));
            elements.push(element);
        }
    }
    if Instant::now() >= deadline {
        return None;
    }
    let index = pick_target(viewport, direction, distance, &nodes)?;
    let target = elements.swap_remove(index);
    belongs_to(target.ptr(), pid, window_id).then_some(RevealTarget {
        element: target,
        container_role: role,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directional_rows_and_container_end() {
        let viewport = [0.0, 100.0, 800.0, 500.0];
        let nodes: Vec<_> = (-10..30)
            .map(|i| ([10.0, 100.0 + 50.0 * i as f64, 600.0, 40.0], true))
            .collect();
        assert_eq!(
            nodes[pick_target(viewport, "down", 360.0, &nodes).unwrap()].0[1],
            900.0
        );
        assert_eq!(
            nodes[pick_target(viewport, "up", 120.0, &nodes).unwrap()].0[1],
            0.0
        );
        assert_eq!(
            pick_target(
                viewport,
                "down",
                120.0,
                &[([0.0, 100.0, 800.0, 3000.0], false)]
            ),
            None
        );
        let columns: Vec<_> = (0..20)
            .map(|i| ([100.0 * i as f64, 200.0, 90.0, 40.0], true))
            .collect();
        assert_eq!(
            columns[pick_target(viewport, "right", 120.0, &columns).unwrap()].0[0],
            800.0
        );
        assert_eq!(pick_target(viewport, "left", 120.0, &columns), None);
    }

    #[test]
    fn chromium_clamped_rows_and_inner_clip() {
        let viewport = [500.0, 290.0, 800.0, 600.0];
        let mut nodes: Vec<_> = (0..13)
            .map(|i| ([518.0, 301.0 + 45.0 * i as f64, 600.0, 41.0], true))
            .collect();
        let first = nodes.len();
        nodes.extend((0..100).map(|_| ([518.0, 889.0, 600.0, 1.0], true)));
        assert_eq!(
            pick_target(viewport, "down", 360.0, &nodes),
            Some(first + 1)
        );
        assert_eq!(
            pick_target(viewport, "down", 600.0, &nodes),
            Some(first + 6)
        );
        assert_eq!(pick_target(viewport, "up", 120.0, &nodes), None);
        assert!(past_edge(
            [0.0, 100.0, 300.0, 128.0],
            "down",
            [0.0, 227.0, 300.0, 1.0]
        ));
        assert!(!past_edge(
            [0.0, 100.0, 300.0, 128.0],
            "down",
            [0.0, 110.0, 300.0, 16.0]
        ));
    }

    #[test]
    fn viewport_requires_finite_overlap() {
        assert_eq!(
            intersect([0.0, 0.0, 1000.0, 3000.0], [10.0, 50.0, 800.0, 600.0]),
            Some([10.0, 50.0, 800.0, 600.0])
        );
        assert_eq!(
            intersect([0.0, 0.0, 10.0, 10.0], [20.0, 20.0, 5.0, 5.0]),
            None
        );
        assert_eq!(
            intersect([0.0, 0.0, f64::INFINITY, 10.0], [0.0, 0.0, 5.0, 5.0]),
            None
        );
    }

    #[test]
    fn inner_container_at_its_end_still_owns_the_scroll_axis() {
        let frame = [0.0, 100.0, 300.0, 128.0];
        let clipped_above = [0.0, 100.0, 200.0, 1.0];
        assert!(!past_edge(frame, "down", clipped_above));
        assert!(clips_axis(frame, "down", clipped_above));
        assert!(clips_axis(frame, "up", clipped_above));
        let clipped_right = [299.0, 110.0, 1.0, 16.0];
        assert!(!clips_axis(frame, "down", clipped_right));
        assert!(clips_axis(frame, "left", clipped_right));
    }

    #[test]
    fn wrong_edge_slivers_cannot_reverse_the_visible_document_order() {
        let viewport = [144.0, 320.0, 360.0, 120.0];
        let mut nodes = vec![
            ([154.0, 439.0, 143.0, 1.0], true),
            ([154.0, 320.0, 143.0, 10.0], true),
            ([154.0, 344.0, 140.0, 18.0], true),
            ([154.0, 376.0, 143.0, 18.0], true),
            ([154.0, 408.0, 260.0, 24.0], true),
        ];
        assert_eq!(pick_target(viewport, "down", 120.0, &nodes), None);
        nodes.push(([154.0, 439.0, 143.0, 1.0], true));
        assert_eq!(pick_target(viewport, "down", 120.0, &nodes), Some(5));

        let mut mirrored = vec![
            ([154.0, 320.0, 143.0, 10.0], true),
            ([154.0, 344.0, 140.0, 18.0], true),
            ([154.0, 320.0, 143.0, 1.0], true),
        ];
        assert_eq!(pick_target(viewport, "up", 120.0, &mirrored), None);
        mirrored.insert(0, ([154.0, 320.0, 143.0, 1.0], true));
        assert_eq!(pick_target(viewport, "up", 120.0, &mirrored), Some(0));
    }

    #[test]
    fn unanchored_clamped_geometry_retains_its_existing_behavior() {
        let viewport = [144.0, 320.0, 360.0, 120.0];
        assert_eq!(
            pick_target(
                viewport,
                "down",
                120.0,
                &[([154.0, 439.0, 143.0, 1.0], true)]
            ),
            Some(0)
        );
    }
}
