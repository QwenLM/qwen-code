//! Private platform-runtime composition behind the public SDK boundary.
//!
//! This is deliberately not a second public interface. Both imported SDK
//! objects and the daemon host construct the same runtime here; transport
//! adapters are downstream consumers of `CuaDriver`.

use crate::{DriverActivityEvent, DriverActivityKind, DriverActivityObserver};
use cua_driver_core::{
    authorization::PermissionMode,
    protocol::ToolResult as CoreToolResult,
    session_authorization::{
        AuthenticatedActionConnection, DelegatedSessionRequest, EffectiveAuthorizationContext,
        SessionAuthorizationError, SessionAuthorizationRegistry, SessionModeCeiling,
        TrustedHostLease,
    },
    session_manifest::SessionManifest,
    tool::ToolRegistry,
};
use cursor_overlay::CursorConfig;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

const RECORDING_IDLE_TTL_SECS_DEFAULT: u64 = 300;
const SESSION_IDLE_TTL_SECS_DEFAULT: u64 = 300;
thread_local! {
    static NATIVE_UI_HOST_AVAILABLE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub(crate) fn set_native_ui_host_available(available: bool) -> bool {
    NATIVE_UI_HOST_AVAILABLE.with(|host| host.replace(available))
}

fn native_ui_host_available() -> bool {
    !cfg!(target_os = "macos") || NATIVE_UI_HOST_AVAILABLE.with(std::cell::Cell::get)
}
#[cfg(target_os = "macos")]
static ACTIVE_UI_RUNTIMES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub(crate) fn native_ui_needs_pump() -> bool {
    #[cfg(target_os = "macos")]
    return ACTIVE_UI_RUNTIMES.load(Ordering::Acquire) != 0;
    #[cfg(not(target_os = "macos"))]
    false
}

#[cfg(target_os = "macos")]
async fn finish_ui_lease() -> Result<(), String> {
    platform_macos::cursor::overlay::flush_on_main_thread().await?;
    ACTIVE_UI_RUNTIMES.fetch_sub(1, Ordering::AcqRel);
    Ok(())
}
#[cfg(test)]
pub(crate) static TEST_RUNTIME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum RuntimeCreateError {
    #[allow(dead_code)]
    #[error(
        "runtime_already_exists: one direct Cua Driver runtime is already active in this process"
    )]
    AlreadyExists,
    #[error("invalid runtime authorization configuration: {0}")]
    Authorization(String),
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    #[error("runtime_unavailable: {0}")]
    Unavailable(String),
}

#[derive(Clone)]
pub(crate) struct RuntimeOptions {
    pub cursor: CursorConfig,
    /// Whether the importing/embedding host owns macOS permission UX. Such a
    /// runtime may inspect TCC state but must never raise Cua-owned prompts.
    pub host_owns_permission_ux: bool,
    pub host_bundle_id: Option<String>,
    pub compatibility_mode: bool,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub prepare_desktop_environment: bool,
    pub register_host_tools: Option<fn(&mut ToolRegistry)>,
    pub authorization_ceiling: Option<SessionModeCeiling>,
    pub compatibility_authorization: Option<(PermissionMode, Option<Arc<SessionManifest>>)>,
    /// Constructor-only authorization host. This object is never reachable from
    /// public tool arguments or transport metadata.
    pub authorization_host: Option<Arc<dyn cua_driver_core::consent::ProtectedConsentProvider>>,
    pub activity_observer: Option<Arc<dyn DriverActivityObserver>>,
}

impl RuntimeOptions {
    pub(crate) fn embedded(compatibility_mode: bool) -> Self {
        let mut cursor = CursorConfig::from_args();
        cursor.enabled &= native_ui_host_available();
        Self {
            cursor,
            host_owns_permission_ux: true,
            host_bundle_id: None,
            compatibility_mode,
            prepare_desktop_environment: native_ui_host_available(),
            register_host_tools: None,
            authorization_ceiling: None,
            compatibility_authorization: None,
            authorization_host: None,
            activity_observer: None,
        }
    }

    pub(crate) fn embedded_with_ceiling(
        compatibility_mode: bool,
        authorization_ceiling: SessionModeCeiling,
        compatibility_permission_mode: PermissionMode,
        compatibility_manifest: Option<Arc<SessionManifest>>,
    ) -> Self {
        Self {
            authorization_ceiling: Some(authorization_ceiling),
            compatibility_authorization: Some((
                compatibility_permission_mode,
                compatibility_manifest,
            )),
            ..Self::embedded(compatibility_mode)
        }
    }
}

pub(crate) struct RuntimeSession {
    runtime: Arc<DriverRuntime>,
    authorization_registry: Arc<SessionAuthorizationRegistry>,
    host: TrustedHostLease,
    connection: AuthenticatedActionConnection,
    context: Arc<EffectiveAuthorizationContext>,
    public_session: String,
}

impl RuntimeSession {
    pub(crate) async fn invoke(&self, name: &str, mut args: Value) -> Option<CoreToolResult> {
        cua_driver_core::tool_args::sanitize_reserved_args(&mut args);
        let Some(arguments) = args.as_object_mut() else {
            return Some(permission_denied_result(
                "session-bound actions require an object argument".to_owned(),
            ));
        };
        if arguments
            .get("session")
            .and_then(Value::as_str)
            .is_some_and(|session| session != self.public_session)
        {
            return Some(permission_denied_result(
                "public session substitution does not match the bound authorization context"
                    .to_owned(),
            ));
        }
        arguments.insert(
            "session".to_owned(),
            Value::String(self.public_session.clone()),
        );
        let result = self
            .runtime
            .invoke_with_context(name, args, self.context.clone())
            .await;
        if name == "end_session"
            && result
                .as_ref()
                .is_some_and(|result| result.is_error != Some(true))
        {
            self.authorization_registry
                .revoke_connection(&self.connection);
        }
        result
    }
}

impl Drop for RuntimeSession {
    fn drop(&mut self) {
        self.authorization_registry
            .revoke_connection(&self.connection);
        self.authorization_registry.revoke_host(&self.host);
    }
}

pub(crate) struct DriverRuntime {
    registry: Arc<ToolRegistry>,
    authorization_registry: Arc<SessionAuthorizationRegistry>,
    compatibility_context: Arc<EffectiveAuthorizationContext>,
    shutdown: AtomicBool,
    #[cfg(target_os = "macos")]
    ui_active: AtomicBool,
    last_activity: AtomicU64,
    /// Calls hold a read guard; shutdown takes the write guard after closing
    /// admission. Therefore shutdown is idempotent and does not return while a
    /// previously admitted operation is still executing.
    lifecycle: Arc<tokio::sync::RwLock<()>>,
    activity_observer: Option<Arc<dyn DriverActivityObserver>>,
}

impl DriverRuntime {
    pub(crate) fn create(options: RuntimeOptions) -> Result<Arc<Self>, RuntimeCreateError> {
        #[cfg(target_os = "windows")]
        if let Err(reason) = platform_windows::diagnostics::interactive_desktop_check() {
            return Err(RuntimeCreateError::Unavailable(format!(
                "Cua Driver requires an interactive Windows user session: {reason}"
            )));
        }
        let authorization_registry = Arc::new(match options.authorization_ceiling.clone() {
            Some(ceiling) => SessionAuthorizationRegistry::with_ceiling(ceiling),
            None => SessionAuthorizationRegistry::process()
                .map_err(RuntimeCreateError::Authorization)?,
        });
        let compatibility_context = match options.compatibility_authorization.clone() {
            Some((mode, manifest)) => authorization_registry
                .compatibility_context(mode, manifest)
                .map_err(RuntimeCreateError::Authorization)?,
            None => authorization_registry
                .legacy_context()
                .map_err(RuntimeCreateError::Authorization)?,
        };
        let registry = Arc::new(cua_driver_core::tool::with_runtime_scope(
            compatibility_context.runtime_scope_key(),
            || build_registry(&options),
        ));
        registry.init_self_weak();
        #[cfg(target_os = "macos")]
        let ui_active = registry.preview_enabled()
            || (options.cursor.enabled && platform_macos::cursor::overlay::is_started());
        #[cfg(target_os = "macos")]
        if ui_active {
            ACTIVE_UI_RUNTIMES.fetch_add(1, Ordering::AcqRel);
        }
        let runtime = Arc::new(Self {
            registry,
            authorization_registry,
            compatibility_context,
            shutdown: AtomicBool::new(false),
            #[cfg(target_os = "macos")]
            ui_active: AtomicBool::new(ui_active),
            last_activity: AtomicU64::new(now_unix_secs()),
            lifecycle: Arc::new(tokio::sync::RwLock::new(())),
            activity_observer: options.activity_observer.clone(),
        });
        spawn_lifecycle_maintenance(&runtime);
        Ok(runtime)
    }

    pub(crate) fn is_running(&self) -> bool {
        !self.shutdown.load(Ordering::Acquire)
    }

    pub(crate) fn runtime_scope_key(&self) -> String {
        self.compatibility_context.runtime_scope_key()
    }

    pub(crate) async fn shutdown(&self) -> Result<(), String> {
        self.shutdown.store(true, Ordering::Release);
        let _drained = self.lifecycle.write().await;
        self.authorization_registry.revoke_all();
        let runtime_prefix = format!(
            "__cua_runtime_{}:",
            self.compatibility_context.runtime_scope_key()
        );
        cua_driver_core::session::revoke_sessions_with_prefix(&runtime_prefix);
        cua_driver_core::session::forget_ended_sessions_with_prefix(&runtime_prefix);
        cua_driver_core::session::forget_suspended_runtime_scope(
            &self.compatibility_context.runtime_scope_key(),
        );
        cua_driver_core::element_token::global()
            .clear_runtime_scope(&self.compatibility_context.runtime_scope_key());
        let recording = self.registry.recording.clone();
        let _ = tokio::task::spawn_blocking(move || recording.stop_owner(None)).await;
        cua_driver_core::pip_hook::remove_runtime(&runtime_prefix);
        #[cfg(target_os = "macos")]
        platform_macos::pip::flush_runtime(&runtime_prefix)
            .await
            .map_err(|error| error.to_string())?;
        #[cfg(target_os = "macos")]
        if self.ui_active.load(Ordering::Acquire) {
            finish_ui_lease().await?;
            self.ui_active.store(false, Ordering::Release);
        }
        Ok(())
    }

    pub(crate) fn tools_list(&self) -> Option<Value> {
        self.is_running().then(|| self.registry.tools_list())
    }

    pub(crate) async fn invoke(
        self: &Arc<Self>,
        name: &str,
        args: Value,
    ) -> Option<CoreToolResult> {
        self.invoke_with_context(name, args, self.compatibility_context.clone())
            .await
    }

    pub(crate) async fn invoke_from_trusted_adapter(
        self: &Arc<Self>,
        name: &str,
        mut args: Value,
    ) -> Option<CoreToolResult> {
        let evidence =
            cua_driver_core::tool::TrustedInvocationEvidence::extract_from_adapter_args(&mut args);
        self.invoke_with_context_and_evidence(
            name,
            args,
            self.compatibility_context.clone(),
            evidence,
        )
        .await
    }

    async fn invoke_with_context(
        self: &Arc<Self>,
        name: &str,
        args: Value,
        context: Arc<EffectiveAuthorizationContext>,
    ) -> Option<CoreToolResult> {
        self.invoke_with_context_and_evidence(
            name,
            args,
            context,
            cua_driver_core::tool::TrustedInvocationEvidence::default(),
        )
        .await
    }

    async fn invoke_with_context_and_evidence(
        self: &Arc<Self>,
        name: &str,
        args: Value,
        context: Arc<EffectiveAuthorizationContext>,
        evidence: cua_driver_core::tool::TrustedInvocationEvidence,
    ) -> Option<CoreToolResult> {
        if !self.is_running() {
            return None;
        }
        self.last_activity.store(now_unix_secs(), Ordering::Relaxed);
        let operation = self.lifecycle.clone().read_owned().await;
        if !self.is_running() {
            return None;
        }
        let ending_session = (name == "end_session")
            .then(|| {
                args.get("session")
                    .and_then(Value::as_str)
                    .map(|session| context.runtime_session_key(session))
            })
            .flatten();
        let public_session = args
            .get("session")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let risk = cua_driver_core::authorization::classify_tool_call(name, &args);
        let adapters = cua_driver_core::authorization::enforcement_adapters_for_call(name, &args)
            .into_iter()
            .map(|adapter| adapter.id.to_owned())
            .collect::<Vec<_>>();
        let evidence = evidence.with_runtime_operation((self.clone(), operation));
        let result = self
            .registry
            .invoke_with_context_and_evidence(name, args, context, evidence.clone())
            .await;
        if let Some(observer) = self.activity_observer.as_ref() {
            let refusal_code = result
                .structured_content
                .as_ref()
                .and_then(|value| value.pointer("/refusal/code"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let success = result.is_error != Some(true);
            observer.on_activity(DriverActivityEvent {
                kind: if success {
                    DriverActivityKind::AuthorizedAction
                } else if refusal_code.is_some() {
                    DriverActivityKind::AuthorizationRefused
                } else {
                    DriverActivityKind::ActionFailed
                },
                unix_ms: now_unix_ms(),
                tool_name: name.to_owned(),
                adapter_ids: adapters.clone(),
                risk_class: risk.class.as_str().to_owned(),
                public_session: public_session.clone(),
                refusal_code,
            });
            if success && name == "start_session" {
                observer.on_activity(activity_lifecycle_event(
                    DriverActivityKind::SessionStarted,
                    name,
                    public_session.clone(),
                ));
            }
            if success
                && adapters
                    .iter()
                    .any(|adapter| adapter == "browser_prepare.existing_profile")
            {
                observer.on_activity(activity_lifecycle_event(
                    DriverActivityKind::GrantIssued,
                    name,
                    public_session.clone(),
                ));
            }
            if success && name == "end_session" {
                observer.on_activity(activity_lifecycle_event(
                    DriverActivityKind::GrantRevoked,
                    name,
                    public_session.clone(),
                ));
                observer.on_activity(activity_lifecycle_event(
                    DriverActivityKind::SessionEnded,
                    name,
                    public_session,
                ));
            }
        }
        if let Some(session) = ending_session {
            // `end_session` is a lifecycle boundary: do not report completion
            // until any recording owned by the session has finalized.
            let recording = self.registry.recording.clone();
            let _ = tokio::task::spawn_blocking(move || recording.stop_owner(Some(&session))).await;
        }
        Some(result)
    }

    pub(crate) fn create_trusted_session(
        self: &Arc<Self>,
        request: DelegatedSessionRequest,
    ) -> Result<Arc<RuntimeSession>, SessionAuthorizationError> {
        if !self.is_running() {
            return Err(SessionAuthorizationError::RuntimeUnavailable);
        }
        let public_session = request.public_session.clone();
        let transport_session = request.transport_session.clone();
        let (host, connection) = self.authorization_registry.trusted_in_process_binding();
        self.authorization_registry
            .bind_delegated_session(&host, &connection, request)?;
        let context = self.authorization_registry.resolve_delegated(
            &connection,
            &public_session,
            &transport_session,
        )?;
        Ok(Arc::new(RuntimeSession {
            runtime: self.clone(),
            authorization_registry: self.authorization_registry.clone(),
            host,
            connection,
            context,
            public_session,
        }))
    }
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn activity_lifecycle_event(
    kind: DriverActivityKind,
    tool_name: &str,
    public_session: Option<String>,
) -> DriverActivityEvent {
    DriverActivityEvent {
        kind,
        unix_ms: now_unix_ms(),
        tool_name: tool_name.to_owned(),
        adapter_ids: Vec::new(),
        risk_class: "r0".to_owned(),
        public_session,
        refusal_code: None,
    }
}

impl Drop for DriverRuntime {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        self.authorization_registry.revoke_all();
        let runtime_scope = self.compatibility_context.runtime_scope_key();
        let runtime_prefix = format!("__cua_runtime_{runtime_scope}:");
        cua_driver_core::session::revoke_sessions_with_prefix(&runtime_prefix);
        cua_driver_core::pip_hook::remove_runtime(&runtime_prefix);
        #[cfg(target_os = "macos")]
        if self.ui_active.swap(false, Ordering::AcqRel) {
            let ui_prefix = runtime_prefix.clone();
            std::thread::spawn(move || {
                match tokio::runtime::Builder::new_current_thread()
                    .enable_time()
                    .build()
                {
                    Ok(executor) => executor.block_on(async {
                        if let Err(error) = platform_macos::pip::flush_runtime(&ui_prefix).await {
                            tracing::warn!("window preview did not finish cleanup: {error}");
                            return;
                        }
                        if let Err(error) = finish_ui_lease().await {
                            tracing::warn!("native UI cleanup did not complete: {error}");
                        }
                    }),
                    Err(error) => {
                        tracing::warn!("native UI cleanup executor unavailable: {error}");
                    }
                }
            });
        }
        cua_driver_core::session::forget_ended_sessions_with_prefix(&runtime_prefix);
        cua_driver_core::session::forget_suspended_runtime_scope(&runtime_scope);
        cua_driver_core::element_token::global().clear_runtime_scope(&runtime_scope);
        // Explicit `shutdown()` drains work and finalizes recordings. Drop is
        // runtime-scoped and non-blocking so a retained binding cannot affect
        // another generation.
        let recording = self.registry.recording.clone();
        std::thread::spawn(move || {
            let _ = recording.stop_owner(None);
        });
    }
}

fn permission_denied_result(message: String) -> CoreToolResult {
    CoreToolResult::error(message.clone()).with_structured(serde_json::json!({
        "status": "refused",
        "refusal": {
            "code": "permission_denied",
            "message": message,
        }
    }))
}

fn configured_ttl(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn spawn_lifecycle_maintenance(runtime: &Arc<DriverRuntime>) {
    let runtime = Arc::downgrade(runtime);
    let recording_ttl = configured_ttl(
        "CUA_DRIVER_RS_RECORDING_IDLE_TTL_SECS",
        RECORDING_IDLE_TTL_SECS_DEFAULT,
    );
    let session_ttl = std::time::Duration::from_secs(configured_ttl(
        "CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS",
        SESSION_IDLE_TTL_SECS_DEFAULT,
    ));
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let Some(runtime) = runtime.upgrade() else {
            break;
        };
        if !runtime.is_running() {
            break;
        }
        let ended = cua_driver_core::session::evict_idle_with_prefix(
            session_ttl,
            &format!(
                "__cua_runtime_{}:",
                runtime.compatibility_context.runtime_scope_key()
            ),
        );
        if !ended.is_empty() {
            tracing::info!(
                count = ended.len(),
                "idle-TTL reclaimed runtime-owned sessions"
            );
        }
        let idle = now_unix_secs().saturating_sub(runtime.last_activity.load(Ordering::Relaxed));
        if idle >= recording_ttl && runtime.registry.recording.current_state().enabled {
            tracing::warn!("recording idle {idle}s ≥ {recording_ttl}s TTL; auto-stopping");
            let _ = runtime.registry.recording.stop_owner(None);
        }
    });
}

/// Build the canonical SDK tool inventory without acquiring runtime ownership.
///
/// This metadata-only path cannot dispatch actions and therefore remains
/// available when the host has no interactive desktop (for example Windows
/// Session 0). Finite CLI inspection commands use it to preserve their
/// desktop-free compatibility contract without weakening runtime admission.
pub(crate) fn tool_inventory(options: RuntimeOptions) -> Value {
    build_registry(&options).tools_list()
}

fn build_registry(options: &RuntimeOptions) -> ToolRegistry {
    #[cfg(target_os = "macos")]
    let mut registry = {
        configure_macos_runtime();
        let mut registry = platform_macos::register_tools_with_cursor_and_provider(
            options.authorization_host.clone(),
            options.cursor.clone(),
            options.compatibility_mode,
            options.host_owns_permission_ux,
            options.host_bundle_id.clone(),
        );
        if options.prepare_desktop_environment && platform_macos::session::has_graphic_access() {
            let config = pip_preview::default_config_path()
                .map(|path| pip_preview::PipConfig::from_args_and_file(&path))
                .unwrap_or_else(pip_preview::PipConfig::from_args);
            if config.enabled {
                match platform_macos::pip::initialize(&config) {
                    Ok(()) => registry.set_preview_enabled(true),
                    Err(error) => tracing::debug!("window preview unavailable: {error}"),
                }
            }
        }
        registry
    };

    #[cfg(target_os = "windows")]
    let mut registry = {
        configure_windows_runtime();
        platform_windows::register_tools_with_cursor_and_provider(
            options.authorization_host.clone(),
            options.cursor.clone(),
            options.compatibility_mode,
        )
    };

    #[cfg(target_os = "linux")]
    let mut registry = {
        configure_linux_runtime(options.prepare_desktop_environment);
        platform_linux::register_tools_with_cursor_and_provider(
            options.authorization_host.clone(),
            options.cursor.clone(),
            options.compatibility_mode,
        )
    };

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let mut registry = {
        let _ = options;
        ToolRegistry::new()
    };

    if let Some(register_host_tools) = options.register_host_tools {
        register_host_tools(&mut registry);
    }
    registry.enable_computer_use();
    let recording = Arc::downgrade(&registry.recording);
    let recording_session_end = cua_driver_core::session::register_scoped_fallible_session_end_hook(
        "recording",
        move |session| {
            let Some(recording) = recording.upgrade() else {
                return Ok(());
            };
            recording
                .stop_owner(Some(session))
                .map_err(|error| error.to_string())
        },
    );
    registry.retain_session_end_hook(recording_session_end);
    registry
}

#[cfg(target_os = "macos")]
fn configure_macos_runtime() {
    cua_driver_core::recording::set_screenshot_fn(|window_id, pid| {
        if let Some(window_id) = window_id {
            platform_macos::capture::screenshot_window_bytes(window_id as u32).ok()
        } else if let Some(pid) = pid {
            platform_macos::windows::resolve_main_window_id(pid as i32)
                .ok()
                .and_then(|window_id| {
                    platform_macos::capture::screenshot_window_bytes(window_id).ok()
                })
        } else {
            platform_macos::capture::screenshot_display_bytes().ok()
        }
    });
    cua_driver_core::recording::set_click_marker_fn(|png_bytes, x, y| {
        platform_macos::capture::crosshair_png_bytes(png_bytes, x, y).ok()
    });
    cua_driver_core::recording::set_ax_snapshot_fn(|window_id, pid| {
        platform_macos::recording_hooks::app_state_json_for(window_id, pid)
    });
    cua_driver_core::recording::set_element_bounds_fn(|window_id, pid, index, binding| {
        platform_macos::recording_hooks::element_window_local_xy(window_id, pid, index, binding)
    });
    cua_driver_core::video::set_video_backend_factory(Box::new(
        platform_macos::video_sckit::SckitVideoBackendFactory,
    ));
}

#[cfg(target_os = "windows")]
fn configure_windows_runtime() {
    cua_driver_core::recording::set_classified_screenshot_fn(|window_id, pid| {
        platform_windows::recording_hooks::screenshot_for_recording(window_id, pid)
    });
    cua_driver_core::recording::set_click_marker_fn(|png_bytes, x, y| {
        platform_windows::capture::crosshair_png_bytes(png_bytes, x, y).ok()
    });
    cua_driver_core::recording::set_ax_snapshot_fn(|window_id, pid| {
        platform_windows::recording_hooks::app_state_json_for(window_id, pid)
    });
    cua_driver_core::recording::set_element_bounds_fn(|window_id, pid, index, binding| {
        platform_windows::recording_hooks::element_window_local_xy(window_id, pid, index, binding)
    });
    cua_driver_core::video::set_video_backend_factory(Box::new(
        cua_driver_core::video_ffmpeg::FfmpegVideoBackendFactory,
    ));
}

#[cfg(target_os = "linux")]
fn configure_linux_runtime(prepare_desktop_environment: bool) {
    if prepare_desktop_environment {
        platform_linux::xauth::ensure_xauthority_discovered();
        platform_linux::session_bus::ensure_session_bus_discovered();
        platform_linux::a11y::ensure_chromium_accessibility_enabled();
        if let Err(error) = platform_linux::atspi::ensure_listener_active() {
            tracing::warn!("could not activate the persistent AT-SPI listener: {error}");
        }
    }
    cua_driver_core::recording::set_screenshot_fn(|window_id, pid| {
        platform_linux::recording_hooks::screenshot_for_recording(window_id, pid)
    });
    cua_driver_core::recording::set_click_marker_fn(|png_bytes, x, y| {
        platform_linux::capture::crosshair_png_bytes(png_bytes, x, y).ok()
    });
    cua_driver_core::recording::set_ax_snapshot_fn(|window_id, pid| {
        platform_linux::recording_hooks::app_state_json_for(window_id, pid)
    });
    cua_driver_core::recording::set_element_bounds_fn(|window_id, pid, index, binding| {
        platform_linux::recording_hooks::element_window_local_xy(window_id, pid, index, binding)
    });
    {
        cua_driver_core::video::set_video_backend_factory(Box::new(
            cua_driver_core::video_ffmpeg::FfmpegVideoBackendFactory,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use cua_driver_core::consent::{
        ConsentAction, ConsentRequest, ProtectedConsentProvider, ProviderDecision,
    };
    use std::time::Duration;

    #[test]
    fn embedded_ui_requires_a_thread_local_host_on_macos() {
        let previous = set_native_ui_host_available(false);
        assert_eq!(
            RuntimeOptions::embedded(false).cursor.enabled,
            !cfg!(target_os = "macos")
        );
        assert!(!set_native_ui_host_available(true));
        assert!(RuntimeOptions::embedded(false).cursor.enabled);
        assert!(RuntimeOptions::embedded(false).prepare_desktop_environment);
        assert!(set_native_ui_host_available(false));
        let other_thread = std::thread::spawn(|| RuntimeOptions::embedded(false).cursor.enabled);
        assert_eq!(other_thread.join().unwrap(), !cfg!(target_os = "macos"));
        set_native_ui_host_available(previous);
    }

    struct TestProtectedHost;

    #[async_trait]
    impl ProtectedConsentProvider for TestProtectedHost {
        fn provider_id(&self) -> &'static str {
            "test.runtime-protected-host"
        }

        async fn request_consent(
            &self,
            request: &ConsentRequest,
        ) -> Result<ProviderDecision, String> {
            Ok(ProviderDecision {
                action: ConsentAction::Accept,
                request_digest: request.request_digest.clone(),
            })
        }
    }

    fn standard_options() -> RuntimeOptions {
        let ceiling = SessionModeCeiling::for_trusted_sessions(
            [PermissionMode::Standard],
            false,
            Duration::from_secs(60),
            Duration::from_secs(30),
        )
        .unwrap();
        let mut options =
            RuntimeOptions::embedded_with_ceiling(false, ceiling, PermissionMode::Standard, None);
        options.authorization_host = Some(Arc::new(TestProtectedHost));
        options
    }

    #[tokio::test]
    async fn authorized_dispatch_refreshes_only_the_runtime_private_activity_key() {
        let _runtime_test = TEST_RUNTIME_LOCK.lock().unwrap();
        let runtime = DriverRuntime::create(standard_options()).unwrap();
        let public = "runtime-activity-refresh";
        let internal = runtime.compatibility_context.runtime_session_key(public);
        let prefix = format!(
            "__cua_runtime_{}:",
            runtime.compatibility_context.runtime_scope_key()
        );

        runtime
            .invoke(
                "start_session",
                serde_json::json!({"session": public, "capture_scope": "auto"}),
            )
            .await
            .unwrap();
        assert!(cua_driver_core::session::has_session_activity(&internal));
        assert!(!cua_driver_core::session::has_session_activity(public));

        std::thread::sleep(Duration::from_millis(20));
        let idle_before_refresh =
            cua_driver_core::session::session_idle_duration(&internal).unwrap();
        runtime
            .invoke("start_session", serde_json::json!({"session": public}))
            .await
            .unwrap();
        let idle_after_refresh =
            cua_driver_core::session::session_idle_duration(&internal).unwrap();
        assert!(
            idle_after_refresh < idle_before_refresh,
            "authorized traffic must reset the private idle clock: before={idle_before_refresh:?} after={idle_after_refresh:?} ended={}",
            cua_driver_core::session::is_session_ended(&internal)
        );
        let evicted =
            cua_driver_core::session::evict_idle_with_prefix(idle_before_refresh, &prefix);
        assert!(
            !evicted.contains(&internal),
            "continuous authorized traffic must refresh the private idle clock"
        );

        runtime.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn idle_eviction_finalizes_the_owning_runtime_recording() {
        let _runtime_test = TEST_RUNTIME_LOCK.lock().unwrap();
        let runtime = DriverRuntime::create(standard_options()).unwrap();
        let public = "runtime-recording-idle";
        let internal = runtime.compatibility_context.runtime_session_key(public);
        let prefix = format!(
            "__cua_runtime_{}:",
            runtime.compatibility_context.runtime_scope_key()
        );
        runtime
            .invoke(
                "start_session",
                serde_json::json!({"session": public, "capture_scope": "auto"}),
            )
            .await
            .unwrap();
        let output = tempfile::tempdir().unwrap();
        let started = runtime
            .invoke(
                "start_recording",
                serde_json::json!({
                    "session": public,
                    "output_dir": output.path(),
                    "record_video": false,
                }),
            )
            .await
            .unwrap();
        assert_ne!(started.is_error, Some(true));
        assert!(runtime.registry.recording.current_state().enabled);

        let evicted = cua_driver_core::session::evict_idle_with_prefix(Duration::ZERO, &prefix);
        assert!(evicted.contains(&internal));
        for _ in 0..100 {
            if !runtime.registry.recording.current_state().enabled {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !runtime.registry.recording.current_state().enabled,
            "session-end hook must finalize recording after idle eviction"
        );

        runtime.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn incomplete_end_keeps_trusted_authorization_live_for_cleanup_retry() {
        let _runtime_test = TEST_RUNTIME_LOCK.lock().unwrap();
        let runtime = DriverRuntime::create(standard_options()).unwrap();
        let public_session = "runtime-end-cleanup-retry";
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let attempts_for_hook = attempts.clone();
        let _hook = cua_driver_core::session::register_scoped_fallible_session_end_hook(
            "runtime-end-cleanup-retry-test",
            move |_| {
                if attempts_for_hook.fetch_add(1, Ordering::SeqCst) == 0 {
                    Err("synthetic first-attempt failure".into())
                } else {
                    Ok(())
                }
            },
        );
        let session = runtime
            .create_trusted_session(DelegatedSessionRequest {
                public_session: public_session.into(),
                transport_session: "runtime-end-cleanup-retry-transport".into(),
                mode: PermissionMode::Standard,
                ttl: Duration::from_secs(60),
                idle_ttl: Duration::from_secs(30),
                capability_manifest: None,
            })
            .unwrap();

        let started = session
            .invoke("start_session", serde_json::json!({}))
            .await
            .unwrap();
        assert_ne!(started.is_error, Some(true));
        let runtime_prefix = format!(
            "__cua_runtime_{}:",
            runtime.compatibility_context.runtime_scope_key()
        );
        let started_sessions = cua_driver_core::session::list_session_snapshots_with_prefix(
            &runtime_prefix,
            Duration::from_secs(300),
        );
        assert_eq!(started_sessions.len(), 1, "{started_sessions:?}");

        let first_end = session
            .invoke("end_session", serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(
            first_end.is_error,
            Some(true),
            "result={first_end:?} started={started_sessions:?} attempts={}",
            attempts.load(Ordering::SeqCst)
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 1);

        let retried_end = session
            .invoke("end_session", serde_json::json!({}))
            .await
            .unwrap();
        assert_ne!(retried_end.is_error, Some(true));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);

        let after_end = session
            .invoke("health_report", serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(
            after_end
                .structured_content
                .as_ref()
                .and_then(|value| value.pointer("/refusal/code"))
                .and_then(Value::as_str),
            Some("authorization_revoked")
        );

        runtime.shutdown().await.unwrap();
    }

    struct PendingNativeTool {
        release: std::sync::Mutex<Option<std::sync::mpsc::Receiver<()>>>,
        finished: std::sync::mpsc::Sender<()>,
    }

    static PENDING_NATIVE_TOOL: std::sync::Mutex<Option<PendingNativeTool>> =
        std::sync::Mutex::new(None);

    #[async_trait]
    impl cua_driver_core::tool::Tool for PendingNativeTool {
        fn def(&self) -> &cua_driver_core::tool::ToolDef {
            static DEF: std::sync::OnceLock<cua_driver_core::tool::ToolDef> =
                std::sync::OnceLock::new();
            DEF.get_or_init(|| cua_driver_core::tool::ToolDef {
                name: "get_screen_size".into(),
                description: "test-only native operation with an early ACK".into(),
                input_schema: serde_json::json!({"type": "object"}),
                read_only: true,
                destructive: false,
                idempotent: true,
                open_world: false,
            })
        }

        async fn invoke(&self, _args: Value) -> CoreToolResult {
            let lifetime = cua_driver_core::tool::retain_dispatch_lifetime();
            let release = self.release.lock().unwrap().take().unwrap();
            let finished = self.finished.clone();
            tokio::task::spawn_blocking(move || {
                let _lifetime = lifetime;
                release.recv().unwrap();
                drop(_lifetime);
                finished.send(()).unwrap();
            });
            CoreToolResult::text("pending native call; observe before retrying")
        }
    }

    #[tokio::test]
    async fn early_ack_retains_native_session_cleanup_and_runtime_drain() {
        let _runtime_test = TEST_RUNTIME_LOCK.lock().unwrap();
        let (release, receiver) = std::sync::mpsc::channel();
        let (finished, completed) = std::sync::mpsc::channel();
        *PENDING_NATIVE_TOOL.lock().unwrap() = Some(PendingNativeTool {
            release: std::sync::Mutex::new(Some(receiver)),
            finished,
        });
        let mut options = standard_options();
        options.register_host_tools = Some(|registry| {
            registry.register(Box::new(
                PENDING_NATIVE_TOOL.lock().unwrap().take().unwrap(),
            ));
        });
        let runtime = DriverRuntime::create(options).unwrap();
        let public = "early-native-ack";
        let internal = runtime.compatibility_context.runtime_session_key(public);
        let cleanup_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cleanup_count_for_hook = cleanup_count.clone();
        let _hook = cua_driver_core::session::register_scoped_session_end_hook(move |id| {
            if id == internal {
                cleanup_count_for_hook.fetch_add(1, Ordering::SeqCst);
            }
        });
        let result = runtime
            .invoke("get_screen_size", serde_json::json!({"session": public}))
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true), "{result:?}");
        runtime
            .invoke("end_session", serde_json::json!({"session": public}))
            .await
            .unwrap();
        let cleanup_before_native_return = cleanup_count.load(Ordering::SeqCst);
        let mut shutdown = Box::pin(runtime.shutdown());
        let shutdown_returned_early =
            tokio::time::timeout(Duration::from_millis(50), &mut shutdown)
                .await
                .is_ok();
        release.send(()).unwrap();
        tokio::task::spawn_blocking(move || {
            completed.recv_timeout(Duration::from_secs(2)).unwrap()
        })
        .await
        .unwrap();
        if !shutdown_returned_early {
            tokio::time::timeout(Duration::from_secs(2), shutdown)
                .await
                .unwrap();
        }
        assert_eq!(
            cleanup_before_native_return, 0,
            "ACK must not finalize an in-flight native session"
        );
        assert!(
            !shutdown_returned_early,
            "shutdown must drain a native call that outlived its ACK"
        );
        assert_eq!(cleanup_count.load(Ordering::SeqCst), 1);
    }
}
