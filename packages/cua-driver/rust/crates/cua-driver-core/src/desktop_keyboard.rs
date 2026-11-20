use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::protocol::ToolResult;
use crate::tool::{
    current_dispatch_session_identity, DispatchSessionIdentity, Tool, ToolDef, ToolRegistry,
};
use serde_json::Value;

pub trait DesktopKeyboard: Send + Sync {
    fn resolve(&self, key: &str) -> Result<u32, String>;
    fn transition(&self, code: u32, down: bool, held: &[u32]) -> Result<(), String>;
}

struct HeldKey {
    manager: u64,
    owner: DispatchSessionIdentity,
    code: u32,
    keyboard: Arc<dyn DesktopKeyboard>,
}

fn held_keys() -> &'static Mutex<Vec<HeldKey>> {
    static KEYS: OnceLock<Mutex<Vec<HeldKey>>> = OnceLock::new();
    KEYS.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn held_codes() -> Vec<u32> {
    held_keys()
        .lock()
        .unwrap()
        .iter()
        .map(|key| key.code)
        .collect()
}

pub(crate) fn admit_input(name: &str, args: &Value) -> Result<(), ToolResult> {
    if matches!(name, "key_down" | "key_up") {
        return Ok(());
    }
    let held = held_keys().lock().unwrap();
    if held.is_empty() {
        return Ok(());
    }
    let owner = current_dispatch_session_identity();
    if held.iter().any(|key| Some(&key.owner) != owner.as_ref()) {
        return Err(crate::computer_use::error(
            "input_busy",
            "Another session holds desktop keys.",
            false,
        ));
    }
    if args["scope"] != "desktop"
        || !matches!(
            name,
            "click" | "double_click" | "right_click" | "scroll" | "drag"
        )
        || args.get("modifier").is_some()
        || args.get("key").is_some()
    {
        return Err(crate::computer_use::error("held_keys_active", "Release held desktop keys before app input, text, chords or clicks with explicit modifiers. Use key_down/key_up for held chords.", false));
    }
    Ok(())
}

fn transition(
    manager: u64,
    keyboard: Arc<dyn DesktopKeyboard>,
    owner: DispatchSessionIdentity,
    code: u32,
    down: bool,
) -> Result<(), ToolResult> {
    let mut held = held_keys().lock().unwrap();
    if held.iter().any(|key| key.owner != owner) {
        return Err(crate::computer_use::error(
            "input_busy",
            "Another session holds desktop keys.",
            false,
        ));
    }
    let index = held.iter().position(|key| key.code == code);
    if down {
        if index.is_some() {
            return Ok(());
        }
        held.push(HeldKey {
            manager,
            owner,
            code,
            keyboard: keyboard.clone(),
        });
        let codes = held.iter().map(|key| key.code).collect::<Vec<_>>();
        keyboard
            .transition(code, true, &codes)
            .map_err(|reason| crate::computer_use::error("operation_failed", reason, true))
    } else {
        let Some(index) = index else {
            return Ok(());
        };
        if held[index].manager != manager {
            return Err(crate::computer_use::error(
                "input_busy",
                "The held key belongs to another runtime.",
                false,
            ));
        }
        let codes = held
            .iter()
            .filter(|key| key.code != code)
            .map(|key| key.code)
            .collect::<Vec<_>>();
        keyboard
            .transition(code, false, &codes)
            .map_err(|reason| crate::computer_use::error("operation_failed", reason, true))?;
        held.remove(index);
        Ok(())
    }
}

fn release_matching(manager: u64, session: Option<&str>) -> Result<(), String> {
    let mut held = held_keys().lock().unwrap();
    let mut failures = Vec::new();
    for index in (0..held.len()).rev() {
        let key = &held[index];
        if key.manager != manager
            || session.is_some_and(|session| {
                key.owner.session_id != session && key.owner.transport_session_id != session
            })
        {
            continue;
        }
        let codes = held
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != index)
            .map(|(_, key)| key.code)
            .collect::<Vec<_>>();
        match key.keyboard.transition(key.code, false, &codes) {
            Ok(()) => {
                held.remove(index);
            }
            Err(reason) => failures.push(reason),
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

struct KeyTool {
    def: ToolDef,
    manager: u64,
    keyboard: Arc<dyn DesktopKeyboard>,
    down: bool,
}

#[async_trait::async_trait]
impl Tool for KeyTool {
    fn def(&self) -> &ToolDef {
        &self.def
    }
    async fn invoke(&self, args: Value) -> ToolResult {
        let Some(owner) = current_dispatch_session_identity() else {
            return crate::computer_use::error(
                "session_unavailable",
                "Holding keys requires a bound session.",
                false,
            );
        };
        if args["scope"] != "desktop" {
            return crate::computer_use::error(
                "invalid_arguments",
                "key_down/key_up require scope:desktop.",
                false,
            );
        }
        let Some(key) = args["key"].as_str() else {
            return crate::computer_use::error("invalid_arguments", "Provide a key name.", false);
        };
        let code = match self.keyboard.resolve(key) {
            Ok(code) => code,
            Err(reason) => return crate::computer_use::error("invalid_arguments", reason, false),
        };
        match transition(self.manager, self.keyboard.clone(), owner, code, self.down) {
            Ok(()) => ToolResult::text("Key state sent; observe before retrying.")
                .with_structured(serde_json::json!({"computer_use":1,"sent":true})),
            Err(result) => result,
        }
    }
}

pub fn register(registry: &mut ToolRegistry, keyboard: Arc<dyn DesktopKeyboard>) {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let manager = NEXT.fetch_add(1, Ordering::Relaxed);
    registry.retain_session_end_hook(crate::session::register_scoped_fallible_session_end_hook(
        "desktop_keyboard",
        move |session| release_matching(manager, Some(session)),
    ));
    registry.retain_runtime_cleanup(move || {
        if let Err(reason) = release_matching(manager, None) {
            eprintln!("[cua-driver] key cleanup incomplete: {reason}");
        }
    });
    for spec in cua_driver_contract::computer_use::tools()
        .into_iter()
        .filter(|spec| matches!(spec.name, "key_down" | "key_up"))
    {
        let down = spec.name == "key_down";
        registry.register(Box::new(KeyTool {
            def: ToolDef {
                name: spec.name.into(),
                description: spec.description.into(),
                input_schema: spec.input_schema,
                read_only: false,
                destructive: false,
                idempotent: true,
                open_world: true,
            },
            manager,
            keyboard: keyboard.clone(),
            down,
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    #[derive(Default)]
    struct Keyboard {
        events: Mutex<Vec<(u32, bool)>>,
        fail: AtomicBool,
    }
    impl DesktopKeyboard for Keyboard {
        fn resolve(&self, _: &str) -> Result<u32, String> {
            Ok(1)
        }
        fn transition(&self, code: u32, down: bool, _: &[u32]) -> Result<(), String> {
            self.events.lock().unwrap().push((code, down));
            if self.fail.swap(false, Ordering::SeqCst) {
                Err("uncertain dispatch".into())
            } else {
                Ok(())
            }
        }
    }
    #[test]
    fn uncertain_down_is_owned_until_successful_release_and_cleanup_retries() {
        let keyboard = Arc::new(Keyboard::default());
        let owner = DispatchSessionIdentity {
            runtime_scope: "keyboard-test".into(),
            session_id: "keyboard-session".into(),
            transport_session_id: "keyboard-transport".into(),
        };
        let mut other = owner.clone();
        other.session_id = "other".into();
        keyboard.fail.store(true, Ordering::SeqCst);
        assert!(transition(991, keyboard.clone(), owner.clone(), 10001, true).is_err());
        assert!(transition(992, keyboard.clone(), other, 10001, false).is_err());
        assert_eq!(*keyboard.events.lock().unwrap(), vec![(10001, true)]);
        assert!(transition(991, keyboard.clone(), owner, 10001, true).is_ok());
        keyboard.fail.store(true, Ordering::SeqCst);
        assert!(release_matching(991, Some("keyboard-session")).is_err());
        assert!(held_codes().contains(&10001));
        release_matching(991, Some("keyboard-transport")).unwrap();
        assert!(!held_codes().contains(&10001));
        assert_eq!(
            *keyboard.events.lock().unwrap(),
            vec![(10001, true), (10001, false), (10001, false)]
        );
    }
}
