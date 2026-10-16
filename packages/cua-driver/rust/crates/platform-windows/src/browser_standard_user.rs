// Portions adapted from trycua/cua 0.35.4, Copyright (c) 2025 Cua AI. MIT license.
//! Win32 side of the standard-user launch for isolated browsers.
//!
//! An elevated Driver derives a standard-user token from its own process token
//! with the SAFER "Normal User" level (the level `runas /trustlevel:0x20000`
//! uses): `BUILTIN\Administrators` and the other administrative groups become
//! deny-only and administrative privileges are removed. The Driver then lowers
//! the token to Medium integrity, removes any remaining privilege a standard
//! user does not hold, and verifies the result before use. Applications are created with that token. The Driver never falls back to its own elevated
//! token. Decision rules live in `browser_launch_token`.
//!
//! A restricted token from `CreateRestrictedToken` (with or without
//! `LUA_TOKEN`/`DISABLE_MAX_PRIVILEGE`) is deliberately not used: Chrome's
//! sandbox cannot launch its GPU and renderer processes under one.

use crate::browser_launch_token::{
    browser_launch_token, privileges_beyond_standard_user, standard_user_token_unavailable_message,
    validate_standard_user_token, AdministratorsMembership, BrowserLaunchToken, TokenFacts,
    MEDIUM_INTEGRITY_RID,
};
use cua_driver_core::browser::refusal::{BrowserRefusal, BrowserRefusalCode};
use std::ffi::c_void;
use std::sync::{Arc, Mutex};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_NOT_ALL_ASSIGNED, HANDLE, LUID};
use windows::Win32::Security::AppLocker::{
    SaferCloseLevel, SaferComputeTokenFromLevel, SaferCreateLevel,
    SAFER_COMPUTE_TOKEN_FROM_LEVEL_FLAGS, SAFER_LEVELID_NORMALUSER, SAFER_LEVEL_OPEN,
    SAFER_SCOPEID_USER,
};
use windows::Win32::Security::{
    AdjustTokenPrivileges, CreateWellKnownSid, EqualSid, GetLengthSid, GetSidSubAuthority,
    GetSidSubAuthorityCount, GetTokenInformation, LookupPrivilegeNameW, SetTokenInformation,
    TokenElevation, TokenGroups, TokenIntegrityLevel, TokenPrivileges, WinBuiltinAdministratorsSid,
    WinMediumLabelSid, LUID_AND_ATTRIBUTES, PSID, SAFER_LEVEL_HANDLE, SE_PRIVILEGE_REMOVED,
    SID_AND_ATTRIBUTES, TOKEN_ACCESS_MASK, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_ELEVATION,
    TOKEN_GROUPS, TOKEN_INFORMATION_CLASS, TOKEN_MANDATORY_LABEL, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

// `SE_GROUP_*` attribute bits from winnt.h.
const SE_GROUP_ENABLED: u32 = 0x0000_0004;
const SE_GROUP_USE_FOR_DENY_ONLY: u32 = 0x0000_0010;
const SE_GROUP_INTEGRITY: u32 = 0x0000_0020;

/// An owned kernel handle closed on drop.
pub(crate) struct OwnedHandle(HANDLE);

// SAFETY: a kernel handle value is process-wide and may be used and closed
// from any thread. The wrapper never hands out the handle for closing.
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl OwnedHandle {
    /// Take ownership of `handle`, which is closed on drop.
    pub(crate) fn new(handle: HANDLE) -> Self {
        Self(handle)
    }

    pub(crate) fn raw(&self) -> HANDLE {
        self.0
    }

    /// Release ownership without closing the handle.
    pub(crate) fn into_raw(self) -> HANDLE {
        let handle = self.0;
        std::mem::forget(self);
        handle
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

/// The token that will run the isolated browser.
#[derive(Clone)]
pub(crate) enum BrowserLaunchContext {
    /// The Driver is not elevated; the browser runs with the Driver's token.
    Driver,
    /// A verified standard-user token derived from the elevated Driver token.
    StandardUser(Arc<OwnedHandle>),
}

/// A process token cannot change after process start, so one verified
/// standard-user token serves every isolated launch. Failures are not cached.
static STANDARD_USER_TOKEN: Mutex<Option<Arc<OwnedHandle>>> = Mutex::new(None);

fn refusal(message: impl Into<String>) -> BrowserRefusal {
    BrowserRefusal::new(BrowserRefusalCode::BrowserRouteUnavailable, message)
}

/// Decide which token runs the isolated browser and, for an elevated Driver,
/// produce the verified standard-user token. Never returns the Driver's
/// elevated token for the browser.
pub(crate) fn browser_launch_context() -> Result<BrowserLaunchContext, BrowserRefusal> {
    let driver_token = current_process_token(TOKEN_QUERY)
        .map_err(|error| refusal(format!("could not open the Driver process token: {error}")))?;
    let driver = token_facts(driver_token.raw()).map_err(|error| {
        refusal(format!(
            "could not inspect the Driver process token: {error}"
        ))
    })?;
    if browser_launch_token(&driver) == BrowserLaunchToken::Driver {
        return Ok(BrowserLaunchContext::Driver);
    }
    let mut cached = STANDARD_USER_TOKEN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(token) = cached.as_ref() {
        return Ok(BrowserLaunchContext::StandardUser(token.clone()));
    }
    let token = derive_verified_standard_user_token(&driver)
        .map(Arc::new)
        .map_err(|reason| refusal(standard_user_token_unavailable_message(&reason)))?;
    *cached = Some(token.clone());
    Ok(BrowserLaunchContext::StandardUser(token))
}

fn current_process_token(access: TOKEN_ACCESS_MASK) -> Result<OwnedHandle, String> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut token) }
        .map_err(|error| format!("OpenProcessToken failed: {error}"))?;
    Ok(OwnedHandle(token))
}

/// Derive, harden, and verify the standard-user token for `driver`.
fn derive_verified_standard_user_token(driver: &TokenFacts) -> Result<OwnedHandle, String> {
    let driver_token = current_process_token(TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY)?;
    let derived = safer_normal_user_token(driver_token.raw())?;
    let facts = token_facts(derived.raw())?;
    if facts.integrity_rid > MEDIUM_INTEGRITY_RID {
        set_medium_integrity(derived.raw())?;
    }
    remove_privileges(derived.raw(), &facts)?;
    let verified = token_facts(derived.raw())?;
    validate_standard_user_token(driver, &verified).map_err(|reason| {
        format!(
            "{reason}; derived token: integrity=0x{:04x}, administrators={:?}, privileges=[{}]",
            verified.integrity_rid,
            verified.administrators,
            verified.privileges.join(", ")
        )
    })?;
    Ok(derived)
}

fn safer_normal_user_token(driver_token: HANDLE) -> Result<OwnedHandle, String> {
    let mut level = SAFER_LEVEL_HANDLE::default();
    unsafe {
        SaferCreateLevel(
            SAFER_SCOPEID_USER,
            SAFER_LEVELID_NORMALUSER,
            SAFER_LEVEL_OPEN,
            &mut level,
            None,
        )
    }
    .map_err(|error| format!("SaferCreateLevel failed: {error}"))?;
    let mut derived = HANDLE::default();
    let computed = unsafe {
        SaferComputeTokenFromLevel(
            level,
            driver_token,
            &mut derived,
            SAFER_COMPUTE_TOKEN_FROM_LEVEL_FLAGS(0),
            None,
        )
    };
    let _ = unsafe { SaferCloseLevel(level) };
    computed.map_err(|error| format!("SaferComputeTokenFromLevel failed: {error}"))?;
    Ok(OwnedHandle(derived))
}

fn set_medium_integrity(token: HANDLE) -> Result<(), String> {
    // SECURITY_MAX_SID_SIZE is 68 bytes; use u64 storage for alignment.
    let mut sid_buffer = [0u64; 12];
    let mut sid_size = std::mem::size_of_val(&sid_buffer) as u32;
    let sid = PSID(sid_buffer.as_mut_ptr().cast());
    unsafe { CreateWellKnownSid(WinMediumLabelSid, PSID::default(), sid, &mut sid_size) }
        .map_err(|error| format!("could not build the Medium integrity SID: {error}"))?;
    let label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: sid,
            Attributes: SE_GROUP_INTEGRITY,
        },
    };
    let size = std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 + unsafe { GetLengthSid(sid) };
    unsafe {
        SetTokenInformation(
            token,
            TokenIntegrityLevel,
            std::ptr::from_ref(&label).cast(),
            size,
        )
    }
    .map_err(|error| format!("could not lower the token to Medium integrity: {error}"))
}

fn remove_privileges(token: HANDLE, facts: &TokenFacts) -> Result<(), String> {
    let extra = privileges_beyond_standard_user(&facts.privileges);
    if extra.is_empty() {
        return Ok(());
    }
    for (name, luid) in token_privileges(token)? {
        if !extra.contains(&name.as_str()) {
            continue;
        }
        let state = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_REMOVED,
            }],
        };
        unsafe { AdjustTokenPrivileges(token, false, Some(&state), 0, None, None) }
            .map_err(|error| format!("could not remove {name}: {error}"))?;
        if unsafe { GetLastError() } == ERROR_NOT_ALL_ASSIGNED {
            return Err(format!(
                "could not remove {name}: not all privileges assigned"
            ));
        }
    }
    Ok(())
}

/// Read one variable-length token information class into aligned storage.
fn token_information(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<u64>, String> {
    let mut needed = 0u32;
    let _ = unsafe { GetTokenInformation(token, class, None, 0, &mut needed) };
    if needed == 0 {
        return Err(format!("GetTokenInformation({}) reported no data", class.0));
    }
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    unsafe {
        GetTokenInformation(
            token,
            class,
            Some(buffer.as_mut_ptr().cast()),
            needed,
            &mut needed,
        )
    }
    .map_err(|error| format!("GetTokenInformation({}) failed: {error}", class.0))?;
    Ok(buffer)
}

fn sid_last_rid(sid: PSID) -> Option<u32> {
    unsafe {
        let count = GetSidSubAuthorityCount(sid);
        if count.is_null() || *count == 0 {
            return None;
        }
        let rid = GetSidSubAuthority(sid, u32::from(*count - 1));
        (!rid.is_null()).then(|| *rid)
    }
}

fn token_privileges(token: HANDLE) -> Result<Vec<(String, LUID)>, String> {
    let buffer = token_information(token, TokenPrivileges)?;
    let header = buffer.as_ptr().cast::<TOKEN_PRIVILEGES>();
    let count = unsafe { (*header).PrivilegeCount } as usize;
    let first = unsafe { std::ptr::addr_of!((*header).Privileges).cast::<LUID_AND_ATTRIBUTES>() };
    let mut privileges = Vec::with_capacity(count);
    for index in 0..count {
        let luid = unsafe { (*first.add(index)).Luid };
        let mut name = [0u16; 128];
        let mut length = name.len() as u32;
        let resolved = unsafe {
            LookupPrivilegeNameW(PCWSTR::null(), &luid, PWSTR(name.as_mut_ptr()), &mut length)
        };
        // An unresolvable privilege keeps a synthetic name, which is never on
        // the standard-user allow list, so validation fails closed.
        let name = match resolved {
            Ok(()) => String::from_utf16_lossy(&name[..length as usize]),
            Err(_) => format!("LUID({:#x}:{:#x})", luid.HighPart, luid.LowPart),
        };
        privileges.push((name, luid));
    }
    Ok(privileges)
}

fn administrators_membership(token: HANDLE) -> Result<AdministratorsMembership, String> {
    let mut sid_buffer = [0u64; 12];
    let mut sid_size = std::mem::size_of_val(&sid_buffer) as u32;
    let administrators = PSID(sid_buffer.as_mut_ptr().cast());
    unsafe {
        CreateWellKnownSid(
            WinBuiltinAdministratorsSid,
            PSID::default(),
            administrators,
            &mut sid_size,
        )
    }
    .map_err(|error| format!("could not build the Administrators SID: {error}"))?;
    let buffer = token_information(token, TokenGroups)?;
    let header = buffer.as_ptr().cast::<TOKEN_GROUPS>();
    let count = unsafe { (*header).GroupCount } as usize;
    let first = unsafe { std::ptr::addr_of!((*header).Groups).cast::<SID_AND_ATTRIBUTES>() };
    for index in 0..count {
        let group = unsafe { *first.add(index) };
        if unsafe { EqualSid(group.Sid, administrators) }.is_ok() {
            let attributes = group.Attributes;
            return Ok(if attributes & SE_GROUP_USE_FOR_DENY_ONLY != 0 {
                AdministratorsMembership::DenyOnly
            } else if attributes & SE_GROUP_ENABLED != 0 {
                AdministratorsMembership::Enabled
            } else {
                // A present, disabled, allow-capable group can be re-enabled
                // by the token holder, so treat it as enabled.
                AdministratorsMembership::Enabled
            });
        }
    }
    Ok(AdministratorsMembership::Absent)
}

/// Gather the security-relevant facts of `token`.
pub(crate) fn token_facts(token: HANDLE) -> Result<TokenFacts, String> {
    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned = 0u32;
    unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            Some(std::ptr::from_mut(&mut elevation).cast::<c_void>()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    }
    .map_err(|error| format!("GetTokenInformation(TokenElevation) failed: {error}"))?;
    let label = token_information(token, TokenIntegrityLevel)?;
    let label = label.as_ptr().cast::<TOKEN_MANDATORY_LABEL>();
    let integrity_rid = sid_last_rid(unsafe { (*label).Label.Sid })
        .ok_or_else(|| "the token integrity label has no RID".to_owned())?;
    Ok(TokenFacts {
        elevated: elevation.TokenIsElevated != 0,
        integrity_rid,
        administrators: administrators_membership(token)?,
        privileges: token_privileges(token)?
            .into_iter()
            .map(|(name, _)| name)
            .collect(),
    })
}
