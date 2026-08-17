use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use network_interface::{Addr, NetworkInterface, NetworkInterfaceConfig};
use qrcode::{render::svg, QrCode};
use rand::RngCore;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use url::Url;

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_CONNECTIONS: usize = 64;
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
static NEXT_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LocalNetwork {
    address: Ipv4Addr,
    netmask: Ipv4Addr,
}

impl LocalNetwork {
    fn contains(&self, peer: IpAddr) -> bool {
        let IpAddr::V4(peer) = peer else {
            return false;
        };
        u32::from(peer) & u32::from(self.netmask)
            == u32::from(self.address) & u32::from(self.netmask)
    }
}

struct Connections {
    stopping: AtomicBool,
    streams: Mutex<HashMap<u64, Vec<TcpStream>>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalControlInfo {
    pub active: bool,
    pub url: Option<String>,
    pub qr_svg: Option<String>,
    pub sleep_inhibited: bool,
}

impl LocalControlInfo {
    pub fn inactive() -> Self {
        Self {
            active: false,
            url: None,
            qr_svg: None,
            sleep_inhibited: false,
        }
    }
}

pub struct LocalControlSession {
    info: LocalControlInfo,
    connections: Arc<Connections>,
    listener_thread: Option<JoinHandle<()>>,
    inhibitor: Option<Child>,
}

impl LocalControlSession {
    pub fn start(
        runtime_url: &Url,
        runtime_token: &str,
        current_url: &Url,
    ) -> Result<Self, String> {
        let target = runtime_socket_addr(runtime_url)?;
        let network = primary_lan_ipv4()?;
        let lan_ip = network.address;
        let listener = TcpListener::bind((lan_ip, 0))
            .map_err(|error| format!("Failed to open Local Control on the LAN: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Failed to configure Local Control: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("Failed to read the Local Control port: {error}"))?
            .port();
        let public_origin = format!("http://{lan_ip}:{port}");
        let pair_token = random_token();
        let url = local_control_url(current_url, lan_ip, port, &pair_token)?;
        let qr_svg = QrCode::new(url.as_bytes())
            .map_err(|error| format!("Failed to generate Local Control QR code: {error}"))?
            .render::<svg::Color>()
            .min_dimensions(240, 240)
            .dark_color(svg::Color("#111827"))
            .light_color(svg::Color("#ffffff"))
            .build();

        let connections = Arc::new(Connections {
            stopping: AtomicBool::new(false),
            streams: Mutex::new(HashMap::new()),
        });
        let listener_thread = spawn_proxy(
            listener,
            target,
            public_origin,
            pair_token,
            runtime_token.to_string(),
            network,
            Arc::clone(&connections),
        );
        let inhibitor = start_sleep_inhibitor();
        let info = LocalControlInfo {
            active: true,
            url: Some(url),
            qr_svg: Some(qr_svg),
            sleep_inhibited: inhibitor.is_some(),
        };
        Ok(Self {
            info,
            connections,
            listener_thread: Some(listener_thread),
            inhibitor,
        })
    }

    pub fn info(&self) -> LocalControlInfo {
        self.info.clone()
    }

    pub fn stop(&mut self) {
        let mut connections = lock(&self.connections.streams);
        self.connections.stopping.store(true, Ordering::SeqCst);
        for streams in connections.drain().map(|(_, streams)| streams) {
            for stream in streams {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
        drop(connections);
        if let Some(thread) = self.listener_thread.take() {
            let _ = thread.join();
        }
        if let Some(mut child) = self.inhibitor.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for LocalControlSession {
    fn drop(&mut self) {
        self.stop();
    }
}

fn spawn_proxy(
    listener: TcpListener,
    target: SocketAddr,
    public_origin: String,
    pair_token: String,
    runtime_token: String,
    network: LocalNetwork,
    connections: Arc<Connections>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while !connections.stopping.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut client, peer)) => {
                    if connections.stopping.load(Ordering::SeqCst) {
                        let _ = client.shutdown(Shutdown::Both);
                        break;
                    }
                    if client.set_nonblocking(false).is_err() {
                        continue;
                    }
                    if !network.contains(peer.ip()) {
                        let _ = write_rejection(&mut client, 403, "Forbidden (off-network)");
                        continue;
                    }
                    let connection_id = NEXT_CONNECTION_ID.fetch_add(1, Ordering::Relaxed);
                    let Ok(client_guard) = client.try_clone() else {
                        continue;
                    };
                    {
                        let mut active = lock(&connections.streams);
                        if active.len() >= MAX_CONNECTIONS {
                            drop(active);
                            let _ = write_rejection(&mut client, 503, "Service Unavailable");
                            continue;
                        }
                        active.insert(connection_id, vec![client_guard]);
                    }
                    let public_origin = public_origin.clone();
                    let pair_token = pair_token.clone();
                    let runtime_token = runtime_token.clone();
                    let connections = Arc::clone(&connections);
                    thread::spawn(move || {
                        if !connections.stopping.load(Ordering::SeqCst) {
                            handle_connection(
                                client,
                                target,
                                &public_origin,
                                &pair_token,
                                &runtime_token,
                                connection_id,
                                &connections,
                            );
                        }
                        lock(&connections.streams).remove(&connection_id);
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }
    })
}

fn handle_connection(
    mut client: TcpStream,
    target: SocketAddr,
    public_origin: &str,
    pair_token: &str,
    runtime_token: &str,
    connection_id: u64,
    connections: &Connections,
) {
    let deadline = Instant::now() + HEADER_TIMEOUT;
    let mut request = Vec::new();
    let header_end = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = write_rejection(&mut client, 408, "Request Timeout");
            return;
        }
        if client.set_read_timeout(Some(remaining)).is_err() {
            return;
        }
        let mut buffer = [0_u8; 4096];
        let read = match client.read(&mut buffer) {
            Ok(read) => read,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                let _ = write_rejection(&mut client, 408, "Request Timeout");
                return;
            }
            Err(_) => return,
        };
        if read == 0 {
            return;
        }
        request.extend_from_slice(&buffer[..read]);
        if let Some(end) = find_header_end(&request) {
            if end > MAX_HEADER_BYTES {
                let _ = write_rejection(&mut client, 431, "Request Header Fields Too Large");
                return;
            }
            break end;
        }
        if request.len() > MAX_HEADER_BYTES {
            let _ = write_rejection(&mut client, 431, "Request Header Fields Too Large");
            return;
        }
    };
    let target_authority = target.to_string();
    let target_origin = format!("http://{target_authority}");
    let rewritten = match rewrite_request(
        &request,
        header_end,
        public_origin,
        &target_origin,
        &target_authority,
        pair_token,
        runtime_token,
    ) {
        Ok(request) => request,
        Err(status) => {
            let _ = write_rejection(&mut client, status, "Forbidden");
            return;
        }
    };
    let Ok(mut upstream) = TcpStream::connect(target) else {
        let _ = write_rejection(&mut client, 502, "Bad Gateway");
        return;
    };
    let _ = client.set_read_timeout(None);
    let Ok(upstream_guard) = upstream.try_clone() else {
        return;
    };
    let mut active = lock(&connections.streams);
    let Some(streams) = active
        .get_mut(&connection_id)
        .filter(|_| !connections.stopping.load(Ordering::SeqCst))
    else {
        let _ = upstream.shutdown(Shutdown::Both);
        return;
    };
    streams.push(upstream_guard);
    drop(active);
    if upstream.write_all(&rewritten).is_err() {
        return;
    }
    let Ok(mut client_reader) = client.try_clone() else {
        return;
    };
    let Ok(mut upstream_writer) = upstream.try_clone() else {
        return;
    };
    let upload = thread::spawn(move || {
        let _ = std::io::copy(&mut client_reader, &mut upstream_writer);
        let _ = upstream_writer.shutdown(Shutdown::Write);
    });
    let _ = std::io::copy(&mut upstream, &mut client);
    let _ = client.shutdown(Shutdown::Both);
    let _ = upload.join();
}

fn rewrite_request(
    request: &[u8],
    header_end: usize,
    public_origin: &str,
    target_origin: &str,
    target_authority: &str,
    pair_token: &str,
    runtime_token: &str,
) -> Result<Vec<u8>, u16> {
    let header_bytes = &request[..header_end];
    if header_bytes
        .iter()
        .enumerate()
        .any(|(index, &byte)| match byte {
            b'\r' => header_bytes.get(index + 1) != Some(&b'\n'),
            b'\n' => index == 0 || header_bytes[index - 1] != b'\r',
            _ => false,
        })
    {
        return Err(400);
    }
    let header = std::str::from_utf8(header_bytes).map_err(|_| 400_u16)?;
    let public_authority = public_origin.strip_prefix("http://").ok_or(500_u16)?;
    let pair_protocol = format!("qwen-bearer.{}", URL_SAFE_NO_PAD.encode(pair_token));
    let runtime_protocol = format!("qwen-bearer.{}", URL_SAFE_NO_PAD.encode(runtime_token));
    let websocket = header.lines().any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("upgrade") && value.trim().eq_ignore_ascii_case("websocket")
        })
    });
    let mut rewritten = String::new();
    let mut saw_connection = false;
    for (index, line) in header
        .trim_end_matches("\r\n\r\n")
        .split("\r\n")
        .enumerate()
    {
        if index == 0 {
            rewritten.push_str(line);
            rewritten.push_str("\r\n");
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(400);
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("host") {
            if !value.eq_ignore_ascii_case(public_authority) {
                return Err(403);
            }
            rewritten.push_str(&format!("Host: {target_authority}\r\n"));
        } else if name.eq_ignore_ascii_case("origin") {
            if !value.eq_ignore_ascii_case(public_origin) {
                return Err(403);
            }
            rewritten.push_str(&format!("Origin: {target_origin}\r\n"));
        } else if name.eq_ignore_ascii_case("authorization") {
            if value != format!("Bearer {pair_token}") {
                return Err(403);
            }
            rewritten.push_str(&format!("Authorization: Bearer {runtime_token}\r\n"));
        } else if name.eq_ignore_ascii_case("sec-websocket-protocol") {
            let mut protocols = Vec::new();
            for protocol in value.split(',').map(str::trim) {
                if protocol == pair_protocol {
                    protocols.push(runtime_protocol.as_str());
                } else if protocol.contains("qwen-bearer.") {
                    return Err(403);
                } else {
                    protocols.push(protocol);
                }
            }
            rewritten.push_str(name);
            rewritten.push_str(": ");
            rewritten.push_str(&protocols.join(", "));
            rewritten.push_str("\r\n");
        } else if name.eq_ignore_ascii_case("connection") && !websocket {
            rewritten.push_str("Connection: close\r\n");
            saw_connection = true;
        } else {
            rewritten.push_str(line);
            rewritten.push_str("\r\n");
            if name.eq_ignore_ascii_case("connection") {
                saw_connection = true;
            }
        }
    }
    if !websocket && !saw_connection {
        rewritten.push_str("Connection: close\r\n");
    }
    rewritten.push_str("\r\n");
    let mut output = rewritten.into_bytes();
    output.extend_from_slice(&request[header_end..]);
    Ok(output)
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
}

fn write_rejection(stream: &mut TcpStream, status: u16, reason: &str) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
}

fn runtime_socket_addr(url: &Url) -> Result<SocketAddr, String> {
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Desktop runtime URL has no port.".to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return Err("Local Control requires the loopback Desktop runtime.".to_string());
    }
    Ok(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port))
}

fn local_control_url(
    current_url: &Url,
    lan_ip: Ipv4Addr,
    port: u16,
    pair_token: &str,
) -> Result<String, String> {
    let workspace = current_url
        .query_pairs()
        .find(|(name, value)| name == "workspace" && !value.is_empty())
        .map(|(_, value)| value.into_owned());
    let mut url = current_url.clone();
    url.set_host(Some(&lan_ip.to_string()))
        .map_err(|error| format!("Failed to construct the Local Control URL: {error}"))?;
    url.set_port(Some(port))
        .map_err(|_| "Failed to construct the Local Control URL.".to_string())?;
    url.set_query(None);
    if let Some(workspace) = workspace {
        url.query_pairs_mut().append_pair("workspace", &workspace);
    }
    url.set_fragment(Some(&format!("token={pair_token}")));
    Ok(url.into())
}

fn primary_lan_ipv4() -> Result<LocalNetwork, String> {
    select_lan_ipv4(routed_ipv4().ok(), NetworkInterface::show().ok())
}

fn is_virtual_interface(name: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        name.starts_with("utun")
            || name.starts_with("llw")
            || name.starts_with("awdl")
            || name.starts_with("bridge")
            || name.starts_with("gif")
            || name.starts_with("stf")
            || name.starts_with("ap")
            || name.starts_with("XHC")
            || name.starts_with("pdp_ip")
            || name.contains("VPN")
            || name.contains("TAP")
    }
    #[cfg(target_os = "linux")]
    {
        name.starts_with("docker")
            || name.starts_with("veth")
            || name.starts_with("br-")
            || name.starts_with("virbr")
            || name.contains("tun")
            || name.contains("tap")
    }
    #[cfg(target_os = "windows")]
    {
        name.contains("Hyper-V")
            || name.starts_with("vEthernet")
            || name.contains("VPN")
            || name.contains("TAP")
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        false
    }
}

fn select_lan_ipv4(
    routed: Option<Ipv4Addr>,
    interfaces: Option<Vec<NetworkInterface>>,
) -> Result<LocalNetwork, String> {
    let interfaces =
        interfaces.ok_or_else(|| "Local Control could not inspect IPv4 networks.".to_string())?;
    let mut saw_unverified = false;
    let mut routed_unverified = false;
    let physical: Vec<LocalNetwork> = interfaces
        .into_iter()
        .filter(|interface| {
            !interface.internal
                && interface
                    .mac_addr
                    .as_deref()
                    .is_some_and(|mac| mac != "00:00:00:00:00:00")
                && !is_virtual_interface(&interface.name)
        })
        .flat_map(|interface| interface.addr)
        .filter_map(|address| match address {
            Addr::V4(address)
                if address.broadcast.is_some()
                    && !address.ip.is_loopback()
                    && !address.ip.is_unspecified() =>
            {
                match address
                    .netmask
                    .filter(|netmask| !netmask.is_unspecified() && *netmask != Ipv4Addr::BROADCAST)
                {
                    Some(netmask) => Some(LocalNetwork {
                        address: address.ip,
                        netmask,
                    }),
                    None => {
                        saw_unverified = true;
                        routed_unverified |= routed == Some(address.ip);
                        None
                    }
                }
            }
            _ => None,
        })
        .collect();
    if routed_unverified || (physical.is_empty() && saw_unverified) {
        return Err(
            "Local Control found an IPv4 adapter without a verifiable netmask.".to_string(),
        );
    }
    choose_lan_ipv4(routed, physical)
}

fn choose_lan_ipv4(
    routed: Option<Ipv4Addr>,
    mut physical: Vec<LocalNetwork>,
) -> Result<LocalNetwork, String> {
    physical.sort_unstable_by_key(|network| (network.address, std::cmp::Reverse(network.netmask)));
    physical.dedup_by_key(|network| network.address);
    if let Some(network) = routed.and_then(|routed| {
        physical
            .iter()
            .find(|network| network.address == routed)
            .copied()
    }) {
        return Ok(network);
    }
    physical.retain(|network| network.address.is_private() || network.address.is_link_local());
    match physical.as_slice() {
        [address] => Ok(*address),
        [] => Err("Local Control could not find a usable IPv4 network.".to_string()),
        _ => Err(
            "Local Control found multiple local networks. Disconnect unused adapters or the VPN."
                .to_string(),
        ),
    }
}

fn routed_ipv4() -> Result<Ipv4Addr, String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| format!("Failed to inspect the local network: {error}"))?;
    socket
        .connect((Ipv4Addr::new(1, 1, 1, 1), 80))
        .map_err(|error| format!("Failed to select a local network: {error}"))?;
    match socket.local_addr().map(|address| address.ip()) {
        Ok(IpAddr::V4(address)) if !address.is_loopback() && !address.is_unspecified() => {
            Ok(address)
        }
        _ => Err("Local Control could not find a usable IPv4 network.".to_string()),
    }
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn start_sleep_inhibitor() -> Option<Child> {
    #[cfg(target_os = "macos")]
    let parent_pid = std::process::id().to_string();
    #[cfg(target_os = "macos")]
    let command = ("caffeinate", vec!["-is", "-w", parent_pid.as_str()]);
    #[cfg(target_os = "linux")]
    let command = (
        "systemd-inhibit",
        vec![
            "--what=sleep",
            "--who=Qwen Code",
            "--why=Local Control is active",
            "--mode=block",
            "sleep",
            "infinity",
        ],
    );
    #[cfg(target_os = "windows")]
    let command = (
        "powershell.exe",
        vec![
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "Add-Type -Namespace QwenCode -Name SleepUtil -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'; [QwenCode.SleepUtil]::SetThreadExecutionState(0x80000001) | Out-Null; try { while ($true) { Start-Sleep -Seconds 3600 } } finally { [QwenCode.SleepUtil]::SetThreadExecutionState(0x80000000) | Out-Null }",
        ],
    );
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    return None;

    let mut child_command = Command::new(command.0);
    child_command
        .args(command.1)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        child_command.creation_flags(CREATE_NO_WINDOW);
    }
    child_command.spawn().ok()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        choose_lan_ipv4, find_header_end, local_control_url, rewrite_request, runtime_socket_addr,
        select_lan_ipv4, spawn_proxy, Connections, LocalNetwork,
    };
    use network_interface::NetworkInterface;
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, TcpListener, TcpStream};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    use std::thread;
    use std::time::Duration;
    use url::Url;

    fn network(address: &str, netmask: &str) -> LocalNetwork {
        LocalNetwork {
            address: address.parse().expect("network address"),
            netmask: netmask.parse().expect("network mask"),
        }
    }

    #[test]
    fn selects_and_limits_the_physical_lan() {
        assert_eq!(
            choose_lan_ipv4(
                Some("10.8.0.2".parse::<Ipv4Addr>().expect("VPN address")),
                vec![network("192.168.1.20", "255.255.255.0")],
            )
            .expect("LAN address"),
            network("192.168.1.20", "255.255.255.0"),
        );
        let enterprise = network("203.0.113.10", "255.255.255.0");
        assert_eq!(
            choose_lan_ipv4(Some(enterprise.address), vec![enterprise]).expect("enterprise LAN"),
            enterprise,
        );
        assert!(enterprise.contains("203.0.113.20".parse().expect("same subnet")));
        assert!(!enterprise.contains("198.51.100.20".parse().expect("other subnet")));
        assert!(choose_lan_ipv4(None, vec![enterprise]).is_err());
        let routed = Ipv4Addr::new(192, 168, 1, 20);
        assert_eq!(
            choose_lan_ipv4(
                Some(routed),
                vec![
                    network("192.168.1.20", "255.255.255.0"),
                    network("192.168.2.5", "255.255.255.0"),
                ],
            )
            .expect("routed LAN")
            .address,
            routed
        );
        assert_eq!(
            choose_lan_ipv4(
                Some(routed),
                vec![
                    network("192.168.1.20", "255.255.0.0"),
                    network("192.168.1.20", "255.255.255.0"),
                ],
            )
            .expect("narrowest duplicate"),
            network("192.168.1.20", "255.255.255.0"),
        );
        assert!(choose_lan_ipv4(None, vec![]).is_err());
        assert!(choose_lan_ipv4(
            None,
            vec![
                network("192.168.1.20", "255.255.255.0"),
                network("192.168.2.5", "255.255.255.0"),
            ],
        )
        .is_err());
    }

    #[test]
    fn rejects_unverified_networks_when_interface_enumeration_fails() {
        let routed = Ipv4Addr::new(192, 168, 1, 20);
        assert!(select_lan_ipv4(Some(routed), None).is_err());

        let interface = |name, address, netmask| {
            NetworkInterface::new_afinet(name, address, netmask, Some(address), 1, false)
                .with_mac_addr(Some("00:11:22:33:44:55".to_string()))
        };
        assert!(select_lan_ipv4(Some(routed), Some(vec![interface("en0", routed, None)])).is_err());
        assert!(select_lan_ipv4(
            Some(routed),
            Some(vec![interface("en0", routed, Some(Ipv4Addr::UNSPECIFIED))]),
        )
        .is_err());
        assert!(select_lan_ipv4(
            Some(routed),
            Some(vec![interface("en0", routed, Some(Ipv4Addr::BROADCAST))]),
        )
        .is_err());
        assert!(select_lan_ipv4(
            Some(routed),
            Some(vec![
                interface("en0", routed, None),
                interface(
                    "en1",
                    Ipv4Addr::new(192, 168, 2, 5),
                    Some(Ipv4Addr::new(255, 255, 255, 0)),
                ),
            ]),
        )
        .is_err());
        assert_eq!(
            select_lan_ipv4(
                Some(routed),
                Some(vec![interface(
                    "en0",
                    routed,
                    Some(Ipv4Addr::new(255, 255, 255, 0)),
                )]),
            )
            .expect("verified network"),
            network("192.168.1.20", "255.255.255.0"),
        );
    }

    #[test]
    fn shares_only_the_current_local_session() {
        let url = local_control_url(
            &Url::parse(
                "http://127.0.0.1:4170/session/a%20b?token=runtime&workspace=work%2Ftree&theme=light#old",
            )
            .expect("current URL"),
            "192.168.1.20".parse().expect("LAN address"),
            49152,
            "pair-token",
        )
        .expect("Local Control URL");
        assert_eq!(
            url,
            "http://192.168.1.20:49152/session/a%20b?workspace=work%2Ftree#token=pair-token"
        );

        let url = local_control_url(
            &Url::parse("http://127.0.0.1:4170/").expect("runtime URL"),
            "192.168.1.20".parse().expect("LAN address"),
            49152,
            "pair-token",
        )
        .expect("Local Control URL");
        assert_eq!(url, "http://192.168.1.20:49152/#token=pair-token");

        let url = local_control_url(
            &Url::parse("http://127.0.0.1:4170/session/x?workspace=")
                .expect("current URL"),
            "192.168.1.20".parse().expect("LAN address"),
            49152,
            "pair-token",
        )
        .expect("Local Control URL");
        assert_eq!(
            url,
            "http://192.168.1.20:49152/session/x#token=pair-token"
        );
    }

    #[test]
    fn relays_a_delayed_http_response() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).expect("upstream listener");
        let upstream_address = upstream.local_addr().expect("upstream address");
        let upstream_thread = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().expect("upstream connection");
            let mut request = Vec::new();
            while find_header_end(&request).is_none() {
                let mut buffer = [0_u8; 1024];
                let read = stream.read(&mut buffer).expect("read request");
                assert_ne!(read, 0, "proxy closed upstream before response");
                request.extend_from_slice(&buffer[..read]);
            }
            thread::sleep(Duration::from_millis(100));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .expect("write response");
        });

        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("proxy listener");
        let public_address = listener.local_addr().expect("proxy address");
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");
        let connections = Arc::new(Connections {
            stopping: AtomicBool::new(false),
            streams: Mutex::new(HashMap::new()),
        });
        let proxy_thread = spawn_proxy(
            listener,
            upstream_address,
            format!("http://{public_address}"),
            "pair-token".to_string(),
            "runtime-token".to_string(),
            network("127.0.0.1", "255.0.0.0"),
            Arc::clone(&connections),
        );

        let mut client = TcpStream::connect(public_address).expect("proxy connection");
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("read timeout");
        write!(client, "GET / HTTP/1.1\r\nHost: {public_address}\r\n\r\n").expect("write request");
        let mut response = String::new();
        client.read_to_string(&mut response).expect("read response");
        assert!(response.ends_with("\r\n\r\nok"), "{response}");

        connections.stopping.store(true, Ordering::SeqCst);
        proxy_thread.join().expect("stop proxy");
        upstream_thread.join().expect("stop upstream");
    }

    #[test]
    fn rejects_off_subnet_peers() {
        let target = TcpListener::bind(("127.0.0.1", 0)).expect("target listener");
        let target_address = target.local_addr().expect("target address");
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("proxy listener");
        let proxy_address = listener.local_addr().expect("proxy address");
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");
        let connections = Arc::new(Connections {
            stopping: AtomicBool::new(false),
            streams: Mutex::new(HashMap::new()),
        });
        let proxy_thread = spawn_proxy(
            listener,
            target_address,
            format!("http://{proxy_address}"),
            "pair-token".to_string(),
            "runtime-token".to_string(),
            network("192.168.1.20", "255.255.255.0"),
            Arc::clone(&connections),
        );

        let mut client = TcpStream::connect(proxy_address).expect("proxy connection");
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("read timeout");
        let mut response = String::new();
        client.read_to_string(&mut response).expect("read response");
        assert!(response.starts_with("HTTP/1.1 403"), "{response}");

        connections.stopping.store(true, Ordering::SeqCst);
        proxy_thread.join().expect("stop proxy");
    }

    #[test]
    fn enforces_the_pairing_boundary() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

        let pair_token = "pair-token";
        let runtime_token = "runtime-token";
        let request = b"POST /session HTTP/1.1\r\nHost: 192.168.1.10:49152\r\nOrigin: http://192.168.1.10:49152\r\nAuthorization: Bearer pair-token\r\nContent-Length: 2\r\n\r\n{}";
        let rewritten = rewrite_request(
            request,
            find_header_end(request).expect("header"),
            "http://192.168.1.10:49152",
            "http://127.0.0.1:4170",
            "127.0.0.1:4170",
            pair_token,
            runtime_token,
        )
        .expect("rewrite");
        let rewritten = String::from_utf8(rewritten).expect("utf8");
        assert!(rewritten.contains("Host: 127.0.0.1:4170\r\n"));
        assert!(rewritten.contains("Origin: http://127.0.0.1:4170\r\n"));
        assert!(rewritten.contains("Authorization: Bearer runtime-token\r\n"));
        assert!(rewritten.contains("Connection: close\r\n"));
        assert!(rewritten.ends_with("\r\n\r\n{}"));

        let request = b"POST /session HTTP/1.1\r\nHost: 192.168.1.10:49152\r\nOrigin: https://attacker.example\r\n\r\n";
        assert_eq!(
            rewrite_request(
                request,
                find_header_end(request).expect("header"),
                "http://192.168.1.10:49152",
                "http://127.0.0.1:4170",
                "127.0.0.1:4170",
                "pair-token",
                "runtime-token",
            ),
            Err(403),
        );

        let request = b"GET / HTTP/1.1\nHost: 127.0.0.1:4170\n\n\r\n\r\n";
        assert_eq!(
            rewrite_request(
                request,
                find_header_end(request).expect("header"),
                "http://192.168.1.10:49152",
                "http://127.0.0.1:4170",
                "127.0.0.1:4170",
                "pair-token",
                "runtime-token",
            ),
            Err(400),
        );

        let request =
            b"GET / HTTP/1.1\r\nHost: 192.168.1.10:49152\r\nX-Inject: a\r\r\n\r\n";
        assert_eq!(
            rewrite_request(
                request,
                find_header_end(request).expect("header"),
                "http://192.168.1.10:49152",
                "http://127.0.0.1:4170",
                "127.0.0.1:4170",
                "pair-token",
                "runtime-token",
            ),
            Err(400),
        );

        let pair = URL_SAFE_NO_PAD.encode("pair-token");
        let runtime = URL_SAFE_NO_PAD.encode("runtime-token");
        let request = format!(
            "GET /acp HTTP/1.1\r\nHost: 192.168.1.10:49152\r\nOrigin: http://192.168.1.10:49152\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: qwen-ws, qwen-bearer.{pair}\r\n\r\n"
        );
        let rewritten = rewrite_request(
            request.as_bytes(),
            find_header_end(request.as_bytes()).expect("header"),
            "http://192.168.1.10:49152",
            "http://127.0.0.1:4170",
            "127.0.0.1:4170",
            "pair-token",
            "runtime-token",
        )
        .expect("rewrite");
        let rewritten = String::from_utf8(rewritten).expect("utf8");
        assert!(rewritten.contains(&format!("qwen-bearer.{runtime}")));
        assert!(!rewritten.contains(&format!("qwen-bearer.{pair}")));
        assert!(rewritten.contains("Connection: Upgrade\r\n"));

        let request = format!(
            "GET /acp HTTP/1.1\r\nHost: 192.168.1.10:49152\r\nOrigin: http://192.168.1.10:49152\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: leak-qwen-bearer.{pair}, qwen-bearer.{pair}\r\n\r\n"
        );
        assert_eq!(
            rewrite_request(
                request.as_bytes(),
                find_header_end(request.as_bytes()).expect("header"),
                "http://192.168.1.10:49152",
                "http://127.0.0.1:4170",
                "127.0.0.1:4170",
                "pair-token",
                "runtime-token",
            ),
            Err(403),
        );

        let request = b"GET /session HTTP/1.1\r\nHost: 192.168.1.10:49152\r\nAuthorization: Bearer runtime-token\r\n\r\n";
        assert_eq!(
            rewrite_request(
                request,
                find_header_end(request).expect("header"),
                "http://192.168.1.10:49152",
                "http://127.0.0.1:4170",
                "127.0.0.1:4170",
                "pair-token",
                "runtime-token",
            ),
            Err(403),
        );

        assert_eq!(
            runtime_socket_addr(&Url::parse("http://127.0.0.1:4170/").expect("url"))
                .expect("target")
                .to_string(),
            "127.0.0.1:4170",
        );
        assert!(runtime_socket_addr(&Url::parse("http://0.0.0.0:4170/").expect("url")).is_err());
    }

    #[test]
    fn excludes_virtual_interfaces() {
        let routed = Ipv4Addr::new(192, 168, 1, 20);
        let interface = |name, address, netmask| {
            NetworkInterface::new_afinet(name, address, netmask, Some(address), 1, false)
                .with_mac_addr(Some("00:11:22:33:44:55".to_string()))
        };
        let en0 = interface(
            "en0",
            routed,
            Some(Ipv4Addr::new(255, 255, 255, 0)),
        );
        // A virtual VPN adapter with the same routed address must not win
        // over the physical LAN.
        let virtual_name = if cfg!(target_os = "macos") {
            "utun3"
        } else if cfg!(target_os = "windows") {
            "vEthernet (Default Switch)"
        } else {
            "tun0"
        };
        let virtual_interface = interface(
            virtual_name,
            Ipv4Addr::new(100, 64, 0, 10),
            Some(Ipv4Addr::new(255, 192, 0, 0)),
        );
        let result = select_lan_ipv4(
            Some(Ipv4Addr::new(100, 64, 0, 10)),
            Some(vec![en0, virtual_interface]),
        )
        .expect("physical LAN");
        assert_eq!(result.address, routed);
        assert_eq!(result.netmask, Ipv4Addr::new(255, 255, 255, 0));
    }
}
