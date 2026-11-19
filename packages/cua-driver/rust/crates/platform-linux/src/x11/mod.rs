//! X11 window enumeration via x11rb.
//!
//! Uses _NET_CLIENT_LIST_STACKING to get the list of top-level windows,
//! then reads WM_NAME/_NET_WM_NAME, _NET_WM_PID, and geometry per window.

use anyhow::Result;
use x11rb::connection::Connection;
use x11rb::protocol::res::{ClientIdMask, ClientIdSpec, ConnectionExt as _};
use x11rb::protocol::xproto::*;
use x11rb::rust_connection::RustConnection;

#[derive(Debug, Clone)]
pub struct WindowInfo {
    /// X11 Window (XID) cast to u64.
    pub xid: u64,
    pub pid: Option<u32>,
    pub app_name: String,
    pub title: String,
    pub is_on_screen: bool,
    pub z_index: Option<usize>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// List top-level windows, optionally filtered by pid.
pub fn list_windows(filter_pid: Option<u32>) -> Vec<WindowInfo> {
    match try_list_windows(filter_pid) {
        Ok(w) => w,
        Err(_) => Vec::new(),
    }
}

/// Verify that an X11 window still exists and belongs to the requested process.
///
/// Checking `/proc/<pid>` alone is insufficient because Linux may recycle the
/// PID after the original application exits. The XID owner binds the two parts
/// of a `get_window_state` target and fails closed when either is stale.
pub fn window_belongs_to_pid(xid: u64, pid: u32) -> bool {
    window_owner_matches(window_owner_pid(xid), pid)
}

pub(crate) fn window_owner_pid(xid: u64) -> Option<u32> {
    let Ok(xid) = u32::try_from(xid) else {
        return None;
    };
    let Ok((conn, _)) = RustConnection::connect(None) else {
        return None;
    };
    OwnerResolver::new(&conn).owner_pid(xid)
}

pub(crate) fn is_minimized(xid: u64) -> bool {
    let Ok(xid) = u32::try_from(xid) else {
        return false;
    };
    let Ok((conn, _)) = RustConnection::connect(None) else {
        return false;
    };
    let Ok(atom) = get_atom(&conn, "WM_STATE") else {
        return false;
    };
    conn.get_property(false, xid, atom, atom, 0, 2)
        .ok()
        .and_then(|reply| reply.reply().ok())
        .and_then(|reply| reply.value32().and_then(|mut values| values.next()))
        == Some(3)
}

pub(crate) fn wait_for_restored_capture(xid: u64) -> Result<()> {
    use std::time::{Duration, Instant};
    let xid = u32::try_from(xid)?;
    let (conn, screen) = RustConnection::connect(None)?;
    let root = conn.setup().roots[screen].root;
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let attributes = conn.get_window_attributes(xid)?.reply()?;
        let geometry = conn.get_geometry(xid)?.reply()?;
        let origin = conn.translate_coordinates(xid, root, 0, 0)?.reply()?;
        let desktop = conn.get_geometry(root)?.reply()?;
        // A WM can report active/viewable before moving an iconic window back
        // from its off-screen parking position. Full-window XGetImage needs
        // the restored rectangle inside the screen, not just confirmed focus.
        if attributes.map_state == MapState::VIEWABLE
            && geometry.width > 0
            && geometry.height > 0
            && origin.dst_x >= 0
            && origin.dst_y >= 0
            && i32::from(origin.dst_x) + i32::from(geometry.width) <= i32::from(desktop.width)
            && i32::from(origin.dst_y) + i32::from(geometry.height) <= i32::from(desktop.height)
        {
            return Ok(());
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "app_window_unavailable: restored X11 window is not ready for a full screenshot"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn window_owner_matches(owner: Option<u32>, requested_pid: u32) -> bool {
    owner == Some(requested_pid)
}

pub fn try_list_windows(filter_pid: Option<u32>) -> Result<Vec<WindowInfo>> {
    try_list_windows_inner(filter_pid, false)
}

pub fn try_list_app_windows(pid: u32) -> Result<Vec<WindowInfo>> {
    try_list_windows_inner(Some(pid), true)
}

fn try_list_windows_inner(
    filter_pid: Option<u32>,
    include_untitled: bool,
) -> Result<Vec<WindowInfo>> {
    crate::require_x11()?;
    let (conn, screen_num) = RustConnection::connect(None)?;
    let screen = &conn.setup().roots[screen_num];
    let root = screen.root;

    // Get _NET_CLIENT_LIST_STACKING (or fallback to _NET_CLIENT_LIST).
    let (windows, stacking_known) = get_window_list(&conn, root)?;

    let owners = OwnerResolver::new(&conn);
    let mut result = Vec::new();
    for (z_index, xid) in windows.into_iter().enumerate() {
        let pid = owners.owner_pid(xid);
        if let Some(fp) = filter_pid {
            if pid != Some(fp) {
                continue;
            }
        }

        let title = get_window_title(&conn, xid).unwrap_or_default();
        if !include_untitled && title.trim().is_empty() {
            continue;
        }
        let app_name = get_window_class(&conn, xid)
            .map(|(instance, class)| if class.is_empty() { instance } else { class })
            .unwrap_or_default();
        let is_on_screen = conn
            .get_window_attributes(xid)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .is_some_and(|attributes| attributes.map_state == MapState::VIEWABLE);

        let geom = conn.get_geometry(xid)?.reply().ok();
        let (x, y, w, h) = if let Some(g) = geom {
            // Translate to root coordinates.
            let trans = conn.translate_coordinates(xid, root, 0, 0)?.reply().ok();
            let (rx, ry) = trans
                .map(|t| (t.dst_x as i32, t.dst_y as i32))
                .unwrap_or((0, 0));
            (rx, ry, g.width as u32, g.height as u32)
        } else {
            (0, 0, 0, 0)
        };

        result.push(WindowInfo {
            xid: xid as u64,
            pid,
            app_name,
            title,
            is_on_screen,
            z_index: stacking_known.then(|| z_index_from_bottom_to_top(z_index)),
            x,
            y,
            width: w,
            height: h,
        });
    }

    Ok(result)
}

pub(crate) fn window_manager_name() -> Option<String> {
    let (conn, screen) = RustConnection::connect(None).ok()?;
    let root = conn.setup().roots[screen].root;
    let atom = get_atom(&conn, "_NET_SUPPORTING_WM_CHECK").ok()?;
    let read = |window| {
        conn.get_property(false, window, atom, AtomEnum::WINDOW, 0, 1)
            .ok()?
            .reply()
            .ok()?
            .value32()?
            .next()
    };
    let window = read(root).filter(|window| *window != 0)?;
    (read(window) == Some(window))
        .then(|| get_window_title(&conn, window).ok())
        .flatten()
}

pub fn resolve_app_window(windows: &[WindowInfo]) -> Option<u64> {
    let (conn, screen) = RustConnection::connect(None).ok()?;
    let atom = get_atom(&conn, "_NET_ACTIVE_WINDOW").ok()?;
    let reply = conn
        .get_property(
            false,
            conn.setup().roots[screen].root,
            atom,
            AtomEnum::WINDOW,
            0,
            1,
        )
        .ok()?
        .reply()
        .ok()?;
    let active = reply
        .value32()
        .and_then(|mut values| values.next())
        .map(u64::from);
    select_app_window_with_owner(windows, active, |window| {
        let reply = conn
            .get_property(
                false,
                window as u32,
                AtomEnum::WM_TRANSIENT_FOR,
                AtomEnum::WINDOW,
                0,
                1,
            )
            .ok()?
            .reply()
            .ok()?;
        let owner = reply.value32()?.next().map(u64::from);
        owner
    })
}

fn select_app_window_with_owner(
    windows: &[WindowInfo],
    active: Option<u64>,
    mut owner_of: impl FnMut(u64) -> Option<u64>,
) -> Option<u64> {
    let selected = select_app_window(windows, active)?;
    let transients: Vec<_> = windows
        .iter()
        .filter(|w| w.is_on_screen && w.xid != selected)
        .filter(|w| {
            let mut current = w.xid;
            for _ in 0..32 {
                let Some(owner) = owner_of(current) else {
                    return false;
                };
                if owner == selected {
                    return true;
                }
                if owner == current {
                    return false;
                }
                current = owner;
            }
            false
        })
        .cloned()
        .collect();
    if transients.is_empty() {
        Some(selected)
    } else {
        select_app_window(&transients, active)
    }
}

pub(crate) fn select_app_window(windows: &[WindowInfo], active: Option<u64>) -> Option<u64> {
    let visible: Vec<_> = windows.iter().filter(|w| w.is_on_screen).collect();
    if visible.is_empty() && windows.len() == 1 {
        return Some(windows[0].xid);
    }
    if let Some(window) = visible.iter().find(|w| Some(w.xid) == active) {
        return Some(window.xid);
    }
    if visible.len() == 1 {
        return Some(visible[0].xid);
    }
    // Only native stacking order can identify the app's last active surface.
    let top = visible
        .iter()
        .filter_map(|w| w.z_index.map(|z| (z, w.xid)))
        .max()?;
    if visible.iter().any(|w| w.z_index.is_none())
        || visible.iter().filter(|w| w.z_index == Some(top.0)).count() != 1
    {
        return None;
    }
    Some(top.1)
}

fn z_index_from_bottom_to_top(position: usize) -> usize {
    position
}

fn get_window_list(conn: &RustConnection, root: Window) -> Result<(Vec<Window>, bool)> {
    let atom_names = ["_NET_CLIENT_LIST_STACKING", "_NET_CLIENT_LIST"];
    for name in &atom_names {
        if let Ok(atom) = get_atom(conn, name) {
            if let Ok(reply) = conn
                .get_property(false, root, atom, AtomEnum::WINDOW, 0, u32::MAX)?
                .reply()
            {
                let windows: Vec<Window> = reply
                    .value32()
                    .map(|iter| iter.collect())
                    .unwrap_or_default();
                if client_list_property(reply.type_, windows.as_slice()).is_some() {
                    return Ok((windows, *name == "_NET_CLIENT_LIST_STACKING"));
                }
            }
        }
    }

    // No EWMH client-list property means there may be no window manager. In
    // that case only expose mapped root children; unmapped Electron children
    // can otherwise be reported before a late-starting WM reparents them.
    let tree = conn.query_tree(root)?.reply()?;
    Ok((
        tree.children
            .into_iter()
            .filter(|window| {
                conn.get_window_attributes(*window)
                    .ok()
                    .and_then(|cookie| cookie.reply().ok())
                    .map(|attributes| fallback_window_is_listable(attributes.map_state))
                    .unwrap_or(false)
            })
            .collect(),
        true,
    ))
}

fn client_list_property(property_type: Atom, windows: &[Window]) -> Option<&[Window]> {
    (property_type != x11rb::NONE).then_some(windows)
}

fn fallback_window_is_listable(map_state: MapState) -> bool {
    map_state == MapState::VIEWABLE
}

fn get_atom(conn: &RustConnection, name: &str) -> Result<Atom> {
    Ok(conn.intern_atom(false, name.as_bytes())?.reply()?.atom)
}

/// Ask the X11 window manager to set one exact top-level window frame, then
/// read the window geometry back in the same desktop coordinate space exposed
/// by `list_windows`. Uses EWMH rather than configuring a client directly.
pub fn set_window_frame(
    xid: u64,
    pid: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(Option<WindowInfo>, bool, Option<String>)> {
    let xid = u32::try_from(xid).map_err(|_| anyhow::anyhow!("window_id is out of X11 range"))?;
    let (conn, screen_num) = RustConnection::connect(None)?;
    let root = conn.setup().roots[screen_num].root;
    match OwnerResolver::new(&conn).owner_pid(xid) {
        Some(owner) if owner == pid => {}
        Some(owner) => anyhow::bail!("window_id {xid} belongs to pid {owner}, not pid {pid}"),
        None => anyhow::bail!("window_id {xid} has no verifiable owner pid ({UNATTRIBUTED_OWNER})"),
    }

    let atom = get_atom(&conn, "_NET_MOVERESIZE_WINDOW")?;
    let fields = (1_u32 << 8) | (1 << 9) | (1 << 10) | (1 << 11);
    let source_indication = 1_u32 << 12; // normal application (EWMH §4.1.5)
    let event = ClientMessageEvent::new(
        32,
        xid,
        atom,
        ClientMessageData::from([
            fields | source_indication,
            x as u32,
            y as u32,
            width,
            height,
        ]),
    );
    let mutation_error = conn
        .send_event(
            false,
            root,
            EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
            event,
        )
        .and_then(|_| conn.flush())
        .err()
        .map(|error| format!("_NET_MOVERESIZE_WINDOW request failed: {error}"));

    let requested = (x, y, width, height);
    let mut observed = None;
    for _ in 0..8 {
        observed = list_windows(Some(pid))
            .into_iter()
            .find(|window| window.xid == u64::from(xid));
        if observed
            .as_ref()
            .is_some_and(|window| (window.x, window.y, window.width, window.height) == requested)
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
    let confirmed = observed
        .as_ref()
        .is_some_and(|window| (window.x, window.y, window.width, window.height) == requested);
    Ok((observed, confirmed, mutation_error))
}

fn get_window_pid(conn: &RustConnection, window: Window) -> Result<Option<u32>> {
    let atom = get_atom(conn, "_NET_WM_PID")?;
    let reply = conn
        .get_property(false, window, atom, AtomEnum::CARDINAL, 0, 1)?
        .reply()?;
    Ok(reply.value32().and_then(|mut i| i.next()))
}

/// Why an X11 toplevel can be listed with no owner pid.
const UNATTRIBUTED_OWNER: &str = "the client publishes no _NET_WM_PID and the X server's \
X-Resource extension could not attribute it to a local process: XRes 1.2 is unavailable, \
the client is remote or forwarded, or the server is outside this PID namespace";

/// Owner pid of client-list toplevels: `_NET_WM_PID` when published, else
/// the X-Resource `LocalClientPID` of the connection that created the window,
/// subject to the fail-closed rules in [`crate::x11_client_pid`]. The XRes
/// probe runs at most once per connection and only for windows that lack
/// `_NET_WM_PID`.
struct OwnerResolver<'c> {
    conn: &'c RustConnection,
    xres: std::cell::OnceCell<bool>,
    hostname: std::cell::OnceCell<Option<String>>,
}

impl<'c> OwnerResolver<'c> {
    fn new(conn: &'c RustConnection) -> Self {
        Self {
            conn,
            xres: std::cell::OnceCell::new(),
            hostname: std::cell::OnceCell::new(),
        }
    }

    fn owner_pid(&self, window: Window) -> Option<u32> {
        match get_window_pid(self.conn, window) {
            Ok(Some(pid)) => Some(pid),
            Ok(None) => self.xres_pid(window),
            Err(_) => None,
        }
    }

    fn xres_pid(&self, window: Window) -> Option<u32> {
        use crate::x11_client_pid::{
            client_base, client_machine_is_local, select_owner_pid, xres_supports_client_ids,
            XresClientValue,
        };
        let available = *self.xres.get_or_init(|| {
            self.conn
                .res_query_version(1, 2)
                .ok()
                .and_then(|cookie| cookie.reply().ok())
                .is_some_and(|v| xres_supports_client_ids(v.server_major, v.server_minor))
        });
        if !available {
            return None;
        }
        let machine = get_client_machine(self.conn, window).ok()?;
        let hostname = self.hostname.get_or_init(|| {
            std::fs::read_to_string("/proc/sys/kernel/hostname")
                .ok()
                .map(|h| h.trim().to_owned())
        });
        if !client_machine_is_local(machine.as_deref(), hostname.as_deref()) {
            return None;
        }
        let setup = self.conn.setup();
        let own_base = setup.resource_id_base;
        let specs = [
            ClientIdSpec {
                client: own_base,
                mask: ClientIdMask::LOCAL_CLIENT_PID,
            },
            ClientIdSpec {
                client: window,
                mask: ClientIdMask::LOCAL_CLIENT_PID,
            },
        ];
        let reply = self.conn.res_query_client_ids(&specs).ok()?.reply().ok()?;
        let values: Vec<XresClientValue<'_>> = reply
            .ids
            .iter()
            .map(|id| XresClientValue {
                client: id.spec.client,
                mask: u32::from(id.spec.mask),
                value: &id.value,
            })
            .collect();
        let pid = select_owner_pid(
            &values,
            own_base,
            std::process::id(),
            client_base(window, setup.resource_id_mask),
        )?;
        // The server keys the query by the client slot in the XID. A window
        // that still exists after the reply proves its creator held that slot
        // when the server answered, so a recycled slot cannot be attributed.
        self.conn.get_window_attributes(window).ok()?.reply().ok()?;
        Some(pid)
    }
}

/// `WM_CLIENT_MACHINE`, `None` when unset. Errors when the window is gone.
fn get_client_machine(conn: &RustConnection, window: Window) -> Result<Option<String>> {
    let reply = conn
        .get_property(
            false,
            window,
            AtomEnum::WM_CLIENT_MACHINE,
            AtomEnum::ANY,
            0,
            256,
        )?
        .reply()?;
    if reply.type_ == x11rb::NONE {
        return Ok(None);
    }
    let value = String::from_utf8_lossy(&reply.value);
    Ok(Some(value.trim_end_matches('\0').to_owned()))
}

fn get_window_title(conn: &RustConnection, window: Window) -> Result<String> {
    // Try _NET_WM_NAME (UTF-8) first.
    if let Ok(atom) = get_atom(conn, "_NET_WM_NAME") {
        if let Ok(utf8_atom) = get_atom(conn, "UTF8_STRING") {
            if let Ok(reply) = conn
                .get_property(false, window, atom, utf8_atom, 0, 1024)?
                .reply()
            {
                if !reply.value.is_empty() {
                    return Ok(String::from_utf8_lossy(&reply.value).into_owned());
                }
            }
        }
    }
    // Fallback: WM_NAME (latin-1 / ASCII).
    let reply = conn
        .get_property(false, window, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 1024)?
        .reply()?;
    Ok(String::from_utf8_lossy(&reply.value).into_owned())
}

/// Return the WM_CLASS pair for `xid` as `(instance, class)`.
///
/// X11's `WM_CLASS` property is two NUL-separated strings; the first is
/// the instance name, the second is the class name. Either field can
/// be empty. Used by [`crate::terminal::is_terminal_window`] to detect
/// terminal emulators that share a process tree with another GUI
/// (e.g. Ghostty's `WM_CLASS = "ghostty\0Ghostty\0"`).
///
/// Returns `None` when no X connection is available, the window has no
/// WM_CLASS atom set, or the property could not be read.
pub fn wm_class_for_window(xid: u64) -> Option<(String, String)> {
    let (conn, _) = RustConnection::connect(None).ok()?;
    get_window_class(&conn, xid as u32)
}

fn get_window_class(conn: &RustConnection, xid: Window) -> Option<(String, String)> {
    let reply = conn
        .get_property(
            false,
            xid as u32,
            AtomEnum::WM_CLASS,
            AtomEnum::STRING,
            0,
            512,
        )
        .ok()?
        .reply()
        .ok()?;
    let raw = reply.value;
    let mut parts = raw.split(|&b| b == 0).filter(|s| !s.is_empty());
    let instance = parts
        .next()
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .unwrap_or_default();
    let class = parts
        .next()
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .unwrap_or_default();
    if instance.is_empty() && class.is_empty() {
        return None;
    }
    Some((instance, class))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_window(xid: u64, z_index: Option<usize>) -> WindowInfo {
        WindowInfo {
            xid,
            pid: Some(42),
            app_name: "Fixture".into(),
            title: String::new(),
            is_on_screen: true,
            z_index,
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        }
    }

    #[test]
    fn app_target_follows_active_window_and_owned_dialog_then_returns_to_owner() {
        let mut windows = vec![app_window(1, Some(0)), app_window(2, Some(1))];
        assert_eq!(
            select_app_window_with_owner(&windows, Some(1), |id| (id == 2).then_some(1)),
            Some(2)
        );
        windows.pop();
        assert_eq!(
            select_app_window_with_owner(&windows, Some(99), |_| None),
            Some(1)
        );
        windows.push(app_window(3, Some(2)));
        assert_eq!(select_app_window(&windows, Some(99)), Some(3));
        assert_eq!(select_app_window(&windows, Some(1)), Some(1));
        windows[1].z_index = None;
        assert_eq!(select_app_window(&windows, Some(99)), None);
    }

    #[test]
    fn app_selection_uses_focus_without_stacking_and_keeps_minimized_identity() {
        let mut windows = vec![app_window(1, None), app_window(2, None)];
        assert_eq!(select_app_window(&windows, Some(2)), Some(2));
        assert_eq!(select_app_window(&windows, None), None);
        for window in &mut windows {
            window.is_on_screen = false;
        }
        assert_eq!(select_app_window(&windows, None), None);
        windows.pop();
        assert_eq!(select_app_window(&windows, None), Some(1));
    }

    #[test]
    fn empty_present_client_list_does_not_fall_back_to_query_tree() {
        assert_eq!(client_list_property(1, &[]), Some([].as_slice()));
    }

    #[test]
    fn absent_client_list_allows_query_tree_fallback() {
        assert_eq!(client_list_property(x11rb::NONE, &[]), None);
    }

    #[test]
    fn stale_or_reused_pid_window_owner_fails_closed() {
        assert!(window_owner_matches(Some(42), 42));
        assert!(!window_owner_matches(Some(43), 42));
        assert!(!window_owner_matches(None, 42));
    }

    #[test]
    fn query_tree_fallback_only_lists_viewable_windows() {
        assert!(fallback_window_is_listable(MapState::VIEWABLE));
        assert!(!fallback_window_is_listable(MapState::UNMAPPED));
        assert!(!fallback_window_is_listable(MapState::UNVIEWABLE));
    }

    #[test]
    fn ewmh_bottom_to_top_order_normalizes_to_higher_is_frontmost() {
        let indices: Vec<_> = (0..3).map(z_index_from_bottom_to_top).collect();
        assert_eq!(indices, vec![0, 1, 2]);
        assert!(indices[2] > indices[0]);
    }
}

pub fn window_info(xid: u64) -> Option<WindowInfo> {
    let window = u32::try_from(xid).ok()?;
    let (conn, screen_num) = RustConnection::connect(None).ok()?;
    let root = conn.setup().roots[screen_num].root;
    let attributes = conn.get_window_attributes(window).ok()?.reply().ok()?;
    let geom = conn.get_geometry(window).ok()?.reply().ok()?;
    let trans = conn
        .translate_coordinates(window, root, 0, 0)
        .ok()?
        .reply()
        .ok()?;
    let pid = OwnerResolver::new(&conn).owner_pid(window);
    let title = get_window_title(&conn, window).unwrap_or_default();
    let app_name = get_window_class(&conn, window)
        .map(|(instance, class)| if class.is_empty() { instance } else { class })
        .unwrap_or_default();
    Some(WindowInfo {
        xid,
        pid,
        app_name,
        title,
        is_on_screen: attributes.map_state == MapState::VIEWABLE,
        z_index: None,
        x: i32::from(trans.dst_x),
        y: i32::from(trans.dst_y),
        width: u32::from(geom.width),
        height: u32::from(geom.height),
    })
}

// Parent/child walks must not attribute a window-manager frame to the manager.
pub fn window_pid(xid: u64) -> Option<u32> {
    let xid = u32::try_from(xid).ok()?;
    let (conn, _) = RustConnection::connect(None).ok()?;
    get_window_pid(&conn, xid).ok().flatten()
}
