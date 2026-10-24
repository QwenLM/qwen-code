use super::*;
use crate::x11_client_pid::client_base;
use std::time::Instant;
use x11rb::protocol::Event;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct QueueUnconfirmed(String);

pub(super) fn unconfirmed(reason: impl Into<String>) -> anyhow::Error {
    QueueUnconfirmed(reason.into()).into()
}

pub(super) fn dispatch<T>(send: impl FnOnce() -> Result<T>) -> Result<T> {
    send().map_err(|error| unconfirmed(format!("{error:#}")))
}

pub(crate) fn delivery_is_unconfirmed(error: &anyhow::Error) -> bool {
    error.is::<QueueUnconfirmed>()
}

/// A server round-trip does not let a busy client translate queued keycodes.
/// Keep temporary mappings until that same X client services a later ping.
/// This acknowledges its event queue, not the application's resulting text.
pub(super) struct KeymapBarrier<'a> {
    conn: &'a RustConnection,
    window: u32,
    root: u32,
    protocols: u32,
    words: [u32; 5],
    focused_client: Option<u32>,
}

impl<'a> KeymapBarrier<'a> {
    pub(super) fn prepare(
        conn: &'a RustConnection,
        target: Option<u32>,
        mapping: &GetKeyboardMappingReply,
        keysyms: impl IntoIterator<Item = u32>,
    ) -> Result<Option<Self>> {
        if !keysyms
            .into_iter()
            .any(|key| !mapping.keysyms.contains(&key))
        {
            return Ok(None);
        }
        Self::prepare_client(conn, target).map(Some).map_err(|error| {
            anyhow!("not_settable: temporary keyboard mapping needs a responsive X11 client queue: {error:#}; no input was sent")
        })
    }

    fn prepare_client(conn: &'a RustConnection, target: Option<u32>) -> Result<Self> {
        let mut window = match target {
            Some(window) => window,
            None => conn.get_input_focus()?.reply()?.focus,
        };
        let mask = conn.setup().resource_id_mask;
        let owner = client_base(window, mask);
        if window <= 1 || owner == 0 {
            bail!("no client window owns the target");
        }
        let protocols = conn.intern_atom(false, b"WM_PROTOCOLS")?.reply()?.atom;
        let ping = conn.intern_atom(false, b"_NET_WM_PING")?.reply()?.atom;
        for _ in 0..64 {
            if client_base(window, mask) != owner {
                break;
            }
            let tree = conn.query_tree(window)?.reply()?;
            let advertised = conn
                .get_property(false, window, protocols, AtomEnum::ATOM, 0, 256)?
                .reply()?;
            if advertised
                .value32()
                .is_some_and(|mut atoms| atoms.any(|atom| atom == ping))
            {
                conn.change_window_attributes(
                    tree.root,
                    &ChangeWindowAttributesAux::new().event_mask(EventMask::SUBSTRUCTURE_NOTIFY),
                )?
                .check()?;
                let nonce = uuid::Uuid::new_v4().as_u128();
                return Ok(Self {
                    conn,
                    window,
                    root: tree.root,
                    protocols,
                    words: [
                        ping,
                        nonce as u32,
                        window,
                        (nonce >> 32) as u32,
                        (nonce >> 64) as u32,
                    ],
                    focused_client: target.is_none().then_some(owner),
                });
            }
            if tree.parent == tree.root || tree.parent == window {
                break;
            }
            window = tree.parent;
        }
        bail!("the target's X client does not advertise _NET_WM_PING");
    }

    pub(super) fn check_focus(&self) -> Result<()> {
        if let Some(owner) = self.focused_client {
            let focus = self.conn.get_input_focus()?.reply()?.focus;
            if client_base(focus, self.conn.setup().resource_id_mask) != owner {
                bail!("text_delivery_stalled: the input focus changed to another X client; input may have been sent; inspect before retrying");
            }
        }
        Ok(())
    }

    pub(super) fn wait(&self) -> Result<()> {
        self.wait_inner()
            .map_err(|error| unconfirmed(format!("{error:#}")))
    }

    fn wait_inner(&self) -> Result<()> {
        self.check_focus()?;
        let request = ClientMessageEvent::new(32, self.window, self.protocols, self.words);
        self.conn
            .send_event(false, self.window, EventMask::NO_EVENT, request)?
            .check()?;
        self.conn.flush()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            while let Some(event) = self.conn.poll_for_event()? {
                if let Event::ClientMessage(event) = event {
                    if event.window == self.root
                        && event.format == 32
                        && event.type_ == self.protocols
                        && event.data.as_data32() == self.words
                    {
                        self.check_focus()?;
                        return Ok(());
                    }
                }
                if Instant::now() >= deadline {
                    break;
                }
            }
            if Instant::now() >= deadline {
                bail!("the X client did not acknowledge its input queue within 5000ms");
            }
            sleep(Duration::from_millis(5));
        }
    }
}
