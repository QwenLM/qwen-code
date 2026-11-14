use serde::{Deserialize, Serialize};
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use url::Url;

const RECORD_VERSION: u32 = 2;
const MAX_RECORD_BYTES: u64 = 16 * 1024;
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
static NEXT_WRITE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ProcessIdentity {
    boot_id: String,
    start_ticks: u64,
    pid_namespace: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryNamespace {
    qwen_home: Option<PathBuf>,
    qwen_runtime_dir: Option<PathBuf>,
    home: Option<PathBuf>,
    resolved_home: PathBuf,
    runtime_entry_override: Option<PathBuf>,
    desktop_version: String,
}

impl RecoveryNamespace {
    pub fn capture(
        resolved_home: PathBuf,
        runtime_entry_override: Option<&Path>,
        desktop_version: String,
    ) -> Result<Self, String> {
        Ok(Self {
            qwen_home: std::env::var_os("QWEN_HOME").map(PathBuf::from),
            qwen_runtime_dir: std::env::var_os("QWEN_RUNTIME_DIR").map(PathBuf::from),
            home: std::env::var_os("HOME").map(PathBuf::from),
            resolved_home,
            runtime_entry_override: runtime_entry_override
                .map(fs::canonicalize)
                .transpose()
                .map_err(|error| format!("Failed to identify Desktop runtime entry: {error}"))?,
            desktop_version,
        })
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct RecoveryRecord {
    v: u32,
    pid: u32,
    workspace: PathBuf,
    namespace: RecoveryNamespace,
    base_url: String,
    token: String,
    identity: ProcessIdentity,
}

pub struct RecoveryHandle {
    record: RecoveryRecord,
    path: PathBuf,
    url: Url,
    process: OwnedFd,
}

impl RecoveryHandle {
    pub fn find(
        directory: &Path,
        workspace: &Path,
        namespace: &RecoveryNamespace,
        persistence_disabled: bool,
    ) -> Result<Option<Self>, String> {
        if persistence_disabled {
            return Ok(None);
        }
        match fs::symlink_metadata(directory) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "Failed to inspect Desktop recovery directory: {error}"
                ))
            }
        }
        check_private(directory, true)?;
        let entries = fs::read_dir(directory)
            .map_err(|error| format!("Failed to read Desktop recovery directory: {error}"))?;
        let mut found = None;
        for entry in entries {
            let entry = entry.map_err(|error| format!("Failed to read recovery entry: {error}"))?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("runtime-") || !name.ends_with(".json") {
                continue;
            }
            let path = entry.path();
            let record = read_record(&path)?;
            if record.workspace != workspace || record.namespace != *namespace {
                continue;
            }
            let url = validate_record(&record)?;
            let boot_id =
                fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(inspect_error)?;
            if boot_id.trim() != record.identity.boot_id {
                remove_file(&path)?;
                continue;
            }
            let namespace = fs::read_link("/proc/self/ns/pid").map_err(inspect_error)?;
            if namespace.to_string_lossy() != record.identity.pid_namespace {
                return Err("Desktop daemon belongs to another PID namespace.".to_string());
            }
            let process = match open_process(record.pid) {
                Ok(process) => process,
                Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {
                    remove_file(&path)?;
                    continue;
                }
                Err(error) => return Err(format!("Failed to inspect Desktop daemon: {error}")),
            };
            if !process_alive(&process).map_err(inspect_error)? {
                remove_file(&path)?;
                continue;
            }
            let identity = match process_identity(record.pid) {
                Ok(identity) => identity,
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound
                        && !process_alive(&process).map_err(inspect_error)? =>
                {
                    remove_file(&path)?;
                    continue;
                }
                Err(error) => return Err(inspect_error(error)),
            };
            if identity.boot_id != record.identity.boot_id
                || identity.start_ticks != record.identity.start_ticks
            {
                remove_file(&path)?;
                continue;
            }
            if identity.pid_namespace != record.identity.pid_namespace {
                return Err("Desktop daemon belongs to another PID namespace.".to_string());
            }
            if !process_alive(&process).map_err(inspect_error)? {
                remove_file(&path)?;
                continue;
            }
            if found.is_some() {
                return Err("Multiple live Desktop backends own this workspace.".to_string());
            }
            found = Some(Self {
                record,
                path,
                url,
                process,
            });
        }
        Ok(found)
    }

    pub fn publish(
        directory: &Path,
        workspace: &Path,
        namespace: &RecoveryNamespace,
        pid: u32,
        url: &Url,
        token: &str,
        persistence_disabled: bool,
    ) -> Result<Option<Self>, String> {
        if persistence_disabled {
            return Ok(None);
        }
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)
            .map_err(|error| format!("Failed to create Desktop recovery directory: {error}"))?;
        check_private(directory, true)?;
        let process = open_process(pid).map_err(inspect_error)?;
        let record = RecoveryRecord {
            v: RECORD_VERSION,
            pid,
            workspace: workspace.to_path_buf(),
            namespace: namespace.clone(),
            base_url: url.to_string(),
            token: token.to_string(),
            identity: process_identity(pid).map_err(inspect_error)?,
        };
        validate_record(&record)?;
        if !process_alive(&process).map_err(inspect_error)? {
            return Err("Desktop daemon exited before recovery registration.".to_string());
        }
        let path = directory.join(format!(
            "runtime-{pid}-{}.json",
            record.identity.start_ticks
        ));
        let temporary = directory.join(format!(
            ".runtime-{pid}-{}-{}.tmp",
            record.identity.start_ticks,
            NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)
                .map_err(|error| format!("Failed to create Desktop recovery record: {error}"))?;
            serde_json::to_writer(&mut file, &record)
                .map_err(|error| format!("Failed to serialize Desktop recovery record: {error}"))?;
            file.write_all(b"\n")
                .and_then(|()| file.sync_all())
                .map_err(|error| format!("Failed to write Desktop recovery record: {error}"))?;
            fs::rename(&temporary, &path)
                .map_err(|error| format!("Failed to publish Desktop recovery record: {error}"))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        Ok(Some(Self {
            record,
            path,
            url: url.clone(),
            process,
        }))
    }

    pub fn url(&self) -> &Url {
        &self.url
    }

    pub fn token(&self) -> &str {
        &self.record.token
    }

    pub fn is_alive(&self) -> Result<bool, String> {
        process_alive(&self.process).map_err(inspect_error)
    }

    pub fn remove_if_stopped(&self) -> Result<(), String> {
        if !self.is_alive()? {
            remove_file(&self.path)?;
        }
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        if self.is_alive()? {
            // The pidfd refers to this process, even if its numeric PID is reused.
            let status = unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    self.process.as_raw_fd(),
                    libc::SIGTERM,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                )
            };
            if status < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(format!("Failed to stop adopted Desktop daemon: {error}"));
                }
            }
            let deadline = Instant::now() + STOP_TIMEOUT;
            while self.is_alive()? {
                if Instant::now() >= deadline {
                    return Err(
                        "Adopted Desktop daemon did not stop; its recovery record was retained."
                            .to_string(),
                    );
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        remove_file(&self.path)
    }
}

fn inspect_error(error: io::Error) -> String {
    format!("Failed to verify Desktop daemon identity: {error}")
}

fn check_private(path: &Path, directory: bool) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect Desktop recovery path: {error}"))?;
    let expected_type = if directory {
        metadata.is_dir()
    } else {
        metadata.is_file()
    };
    if !expected_type
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(
            "Desktop recovery path must be private and owned by the current user.".to_string(),
        );
    }
    Ok(())
}

fn read_record(path: &Path) -> Result<RecoveryRecord, String> {
    check_private(path, false)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| format!("Failed to open Desktop recovery record: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Failed to inspect recovery record: {error}"))?;
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
        return Err(
            "Desktop recovery record must be private and owned by the current user.".to_string(),
        );
    }
    let mut contents = Vec::new();
    file.take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut contents)
        .map_err(|error| format!("Failed to read Desktop recovery record: {error}"))?;
    if contents.len() as u64 > MAX_RECORD_BYTES {
        return Err("Desktop recovery record exceeds its size limit.".to_string());
    }
    serde_json::from_slice(&contents)
        .map_err(|_| "Desktop recovery record is malformed.".to_string())
}

fn validate_record(record: &RecoveryRecord) -> Result<Url, String> {
    let url =
        Url::parse(&record.base_url).map_err(|_| "Desktop recovery URL is invalid.".to_string())?;
    if record.v != RECORD_VERSION
        || record.pid == 0
        || record.pid > i32::MAX as u32
        || record.identity.boot_id.is_empty()
        || record.identity.start_ticks == 0
        || record.identity.pid_namespace.is_empty()
        || !record.workspace.is_absolute()
        || !record.namespace.resolved_home.is_absolute()
        || record.namespace.desktop_version.is_empty()
        || record
            .namespace
            .runtime_entry_override
            .as_ref()
            .is_some_and(|entry| !entry.is_absolute())
        || record.token.len() != 64
        || !record.token.bytes().all(|byte| byte.is_ascii_hexdigit())
        || url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.port() == Some(0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Desktop recovery record has an invalid identity or address.".to_string());
    }
    Ok(url)
}

fn open_process(pid: u32) -> io::Result<OwnedFd> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid process ID",
        ));
    }
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
}

fn process_alive(process: &OwnedFd) -> io::Result<bool> {
    let mut poll = libc::pollfd {
        fd: process.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let status = unsafe { libc::poll(&mut poll, 1, 0) };
    if status < 0 {
        return Err(io::Error::last_os_error());
    }
    if poll.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "invalid Desktop process handle",
        ));
    }
    Ok(poll.revents & (libc::POLLIN | libc::POLLHUP) == 0)
}

fn process_identity(pid: u32) -> io::Result<ProcessIdentity> {
    let process = PathBuf::from(format!("/proc/{pid}"));
    if fs::metadata(&process)?.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "daemon owner differs",
        ));
    }
    let stat = fs::read_to_string(process.join("stat"))?;
    let start_ticks = stat
        .rsplit_once(')')
        .and_then(|(_, fields)| fields.split_whitespace().nth(19))
        .and_then(|field| field.parse().ok())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "invalid process start identity")
        })?;
    Ok(ProcessIdentity {
        boot_id: fs::read_to_string("/proc/sys/kernel/random/boot_id")?
            .trim()
            .to_string(),
        start_ticks,
        pid_namespace: fs::read_link(process.join("ns/pid"))?
            .to_string_lossy()
            .into_owned(),
    })
}

fn remove_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove Desktop recovery record: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::process::{Child, Command};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "qwen-recovery-{}-{}",
                std::process::id(),
                NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
            ));
            DirBuilder::new().mode(0o700).create(&path).unwrap();
            Self(path)
        }

        fn namespace(&self) -> RecoveryNamespace {
            RecoveryNamespace {
                qwen_home: None,
                qwen_runtime_dir: None,
                home: None,
                resolved_home: self.0.clone(),
                runtime_entry_override: None,
                desktop_version: "test-runtime".to_string(),
            }
        }

        fn publish(&self, pid: u32) -> RecoveryHandle {
            RecoveryHandle::publish(
                &self.0,
                &self.0,
                &self.namespace(),
                pid,
                &Url::parse("http://127.0.0.1:49152/").unwrap(),
                &"a".repeat(64),
                false,
            )
            .unwrap()
            .unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct TestChild(Child);

    impl TestChild {
        fn sleep() -> Self {
            Self(Command::new("sleep").arg("60").spawn().unwrap())
        }
    }

    impl Drop for TestChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn publishes_private_record_and_recovers_the_same_process() {
        let fixture = Fixture::new();
        let original = fixture.publish(std::process::id());
        assert_eq!(fs::metadata(&fixture.0).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(&original.path).unwrap().mode() & 0o777, 0o600);
        let recovered = RecoveryHandle::find(&fixture.0, &fixture.0, &fixture.namespace(), false)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.record.pid, original.record.pid);
        assert!(recovered.record.identity == original.record.identity);
        assert_eq!(recovered.url(), original.url());
        assert_eq!(recovered.token(), original.token());
        assert!(recovered.is_alive().unwrap());
    }

    #[test]
    fn disabled_persistence_neither_reads_nor_writes_recovery_records() {
        let fixture = Fixture::new();
        let path = fixture.0.join("runtime-disabled.json");
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap()
            .write_all(b"{")
            .unwrap();
        assert!(
            RecoveryHandle::find(&fixture.0, &fixture.0, &fixture.namespace(), true)
                .unwrap()
                .is_none()
        );
        assert!(RecoveryHandle::find(&fixture.0, &fixture.0, &fixture.namespace(), false).is_err());
        let untouched = fixture.0.join("no-recovery-directory");
        assert!(RecoveryHandle::publish(
            &untouched,
            &fixture.0,
            &fixture.namespace(),
            0,
            &Url::parse("http://127.0.0.1:49152/").unwrap(),
            "",
            true,
        )
        .unwrap()
        .is_none());
        assert!(!untouched.exists());
    }

    #[test]
    fn ignores_a_different_workspace_without_removing_its_record() {
        let fixture = Fixture::new();
        let handle = fixture.publish(std::process::id());
        assert!(RecoveryHandle::find(
            &fixture.0,
            &fixture.0.join("another"),
            &fixture.namespace(),
            false
        )
        .unwrap()
        .is_none());
        assert!(handle.path.exists());
    }

    #[test]
    fn ignores_different_storage_namespaces_before_inspecting_the_process() {
        let fixture = Fixture::new();
        let handle = fixture.publish(std::process::id());
        let original = fixture.namespace();
        let mut variants = Vec::new();
        let mut changed = original.clone();
        changed.qwen_home = Some(fixture.0.join("config"));
        variants.push(changed);
        let mut changed = original.clone();
        changed.qwen_runtime_dir = Some(fixture.0.join("transcripts"));
        variants.push(changed);
        let mut changed = original.clone();
        changed.home = Some(fixture.0.join("home"));
        variants.push(changed);
        let mut changed = original.clone();
        changed.resolved_home = fixture.0.join("fallback-home");
        variants.push(changed);
        let mut changed = original.clone();
        changed.runtime_entry_override = Some(fixture.0.join("cli-entry.js"));
        variants.push(changed);
        let mut changed = original;
        changed.desktop_version = "another-runtime".to_string();
        variants.push(changed);
        // A mismatched namespace must be filtered before process inspection,
        // including the foreign-PID-namespace error for a matching record.
        let mut record = handle.record.clone();
        record.identity.pid_namespace = "pid:[0]".to_string();
        fs::write(&handle.path, serde_json::to_vec(&record).unwrap()).unwrap();
        for requested in variants {
            assert!(
                RecoveryHandle::find(&fixture.0, &fixture.0, &requested, false)
                    .unwrap()
                    .is_none()
            );
            assert!(handle.is_alive().unwrap());
            assert!(handle.path.exists());
        }
    }

    #[test]
    fn captures_only_storage_inputs_and_canonical_runtime_override() {
        let fixture = Fixture::new();
        let entry = fixture.0.join("cli-entry.js");
        fs::write(&entry, b"test-runtime").unwrap();
        let alias = fixture.0.join("entry-link.js");
        symlink(&entry, &alias).unwrap();
        let namespace =
            RecoveryNamespace::capture(fixture.0.clone(), Some(&alias), "test-runtime".to_string())
                .unwrap();
        assert_eq!(
            namespace.qwen_home,
            std::env::var_os("QWEN_HOME").map(PathBuf::from)
        );
        assert_eq!(
            namespace.qwen_runtime_dir,
            std::env::var_os("QWEN_RUNTIME_DIR").map(PathBuf::from)
        );
        assert_eq!(namespace.home, std::env::var_os("HOME").map(PathBuf::from));
        assert_eq!(
            namespace.runtime_entry_override,
            Some(fs::canonicalize(entry).unwrap())
        );
        assert_eq!(
            serde_json::to_value(namespace)
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            6
        );
    }

    #[test]
    fn refuses_records_without_storage_namespace_identity() {
        let fixture = Fixture::new();
        let handle = fixture.publish(std::process::id());
        let mut record = serde_json::to_value(&handle.record).unwrap();
        record.as_object_mut().unwrap().remove("namespace");
        fs::write(&handle.path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(RecoveryHandle::find(&fixture.0, &fixture.0, &fixture.namespace(), false).is_err());
        assert!(handle.is_alive().unwrap());
        assert!(handle.path.exists());
    }

    #[test]
    fn refuses_group_readable_records() {
        let fixture = Fixture::new();
        let handle = fixture.publish(std::process::id());
        fs::set_permissions(&handle.path, fs::Permissions::from_mode(0o640)).unwrap();
        assert!(RecoveryHandle::find(&fixture.0, &fixture.0, &fixture.namespace(), false).is_err());
    }

    #[test]
    fn refuses_group_accessible_recovery_directories() {
        let fixture = Fixture::new();
        fixture.publish(std::process::id());
        fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o750)).unwrap();
        assert!(RecoveryHandle::find(&fixture.0, &fixture.0, &fixture.namespace(), false).is_err());
    }

    #[test]
    fn refuses_symlinked_records() {
        let fixture = Fixture::new();
        let handle = fixture.publish(std::process::id());
        let target = fixture.0.join("saved.json");
        fs::rename(&handle.path, &target).unwrap();
        symlink(&target, &handle.path).unwrap();
        assert!(RecoveryHandle::find(&fixture.0, &fixture.0, &fixture.namespace(), false).is_err());
    }

    #[test]
    fn refuses_foreign_pid_namespace_before_adopting() {
        let fixture = Fixture::new();
        let handle = fixture.publish(std::process::id());
        let mut record = handle.record.clone();
        record.identity.pid_namespace = "pid:[0]".to_string();
        fs::write(&handle.path, serde_json::to_vec(&record).unwrap()).unwrap();
        let error = RecoveryHandle::find(&fixture.0, &fixture.0, &fixture.namespace(), false)
            .err()
            .unwrap();
        assert!(error.contains("namespace"));
        assert!(handle.is_alive().unwrap());
        assert!(handle.path.exists());
    }

    #[test]
    fn discards_an_old_boot_before_comparing_pid_namespace() {
        let fixture = Fixture::new();
        let handle = fixture.publish(std::process::id());
        let mut record = handle.record.clone();
        record.identity.boot_id = "previous-boot".to_string();
        record.identity.pid_namespace = "pid:[0]".to_string();
        fs::write(&handle.path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(
            RecoveryHandle::find(&fixture.0, &fixture.0, &fixture.namespace(), false)
                .unwrap()
                .is_none()
        );
        assert!(handle.is_alive().unwrap());
        assert!(!handle.path.exists());
    }

    #[test]
    fn discards_changed_start_identity_without_signalling_the_process() {
        let fixture = Fixture::new();
        let handle = fixture.publish(std::process::id());
        let mut record = handle.record.clone();
        record.identity.start_ticks += 1;
        fs::write(&handle.path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(
            RecoveryHandle::find(&fixture.0, &fixture.0, &fixture.namespace(), false)
                .unwrap()
                .is_none()
        );
        assert!(handle.is_alive().unwrap());
        assert!(!handle.path.exists());
    }

    #[test]
    fn discards_a_dead_process_record() {
        let fixture = Fixture::new();
        let mut child = TestChild::sleep();
        let handle = fixture.publish(child.0.id());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(
            RecoveryHandle::find(&fixture.0, &fixture.0, &fixture.namespace(), false)
                .unwrap()
                .is_none()
        );
        assert!(!handle.path.exists());
    }

    #[test]
    fn rejects_non_loopback_and_credential_carrying_addresses() {
        let fixture = Fixture::new();
        let handle = fixture.publish(std::process::id());
        for address in [
            "http://example.com:4170/",
            "http://localhost:4170/",
            "https://127.0.0.1:4170/",
            "http://127.0.0.1:0/",
            "http://user:pass@127.0.0.1:4170/",
            "http://127.0.0.1:4170/path",
            "http://127.0.0.1:4170/?token=value",
            "http://127.0.0.1:4170/#token=value",
        ] {
            let mut record = handle.record.clone();
            record.base_url = address.to_string();
            assert!(validate_record(&record).is_err(), "accepted {address}");
        }
    }

    #[test]
    fn rejects_malformed_or_oversized_records() {
        let fixture = Fixture::new();
        let handle = fixture.publish(std::process::id());
        fs::write(&handle.path, b"{").unwrap();
        assert!(RecoveryHandle::find(&fixture.0, &fixture.0, &fixture.namespace(), false).is_err());
        fs::write(&handle.path, vec![b' '; MAX_RECORD_BYTES as usize + 1]).unwrap();
        assert!(RecoveryHandle::find(&fixture.0, &fixture.0, &fixture.namespace(), false).is_err());
    }

    #[test]
    fn leaves_a_live_record_when_only_detaching() {
        let fixture = Fixture::new();
        let handle = fixture.publish(std::process::id());
        handle.remove_if_stopped().unwrap();
        assert!(handle.path.exists());
        drop(handle);
        assert!(
            RecoveryHandle::find(&fixture.0, &fixture.0, &fixture.namespace(), false)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn stops_an_adopted_process_through_its_pidfd() {
        let fixture = Fixture::new();
        let mut child = TestChild::sleep();
        let handle = fixture.publish(child.0.id());
        handle.stop().unwrap();
        assert!(!handle.is_alive().unwrap());
        assert!(!handle.path.exists());
        child.0.wait().unwrap();
    }
}
