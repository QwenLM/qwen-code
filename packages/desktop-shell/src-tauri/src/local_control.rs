use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
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
#[cfg(not(test))]
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(test)]
const HEADER_TIMEOUT: Duration = Duration::from_millis(250);
static NEXT_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

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
    pub fn start(runtime_url: &Url, runtime_token: &str) -> Result<Self, String> {
        let target = runtime_socket_addr(runtime_url)?;
        let lan_ip = primary_lan_ipv4()?;
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
        let url = format!("{public_origin}/#token={pair_token}");
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
    connections: Arc<Connections>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while !connections.stopping.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut client, _)) => {
                    if connections.stopping.load(Ordering::SeqCst) {
                        let _ = client.shutdown(Shutdown::Both);
                        break;
                    }
                    if client.set_nonblocking(false).is_err() {
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
    let header = std::str::from_utf8(&request[..header_end]).map_err(|_| 400_u16)?;
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
        } else if name.eq_ignore_ascii_case("authorization")
            && value == format!("Bearer {pair_token}")
        {
            rewritten.push_str(&format!("Authorization: Bearer {runtime_token}\r\n"));
        } else if name.eq_ignore_ascii_case("sec-websocket-protocol") {
            rewritten.push_str(name);
            rewritten.push_str(": ");
            rewritten.push_str(&value.replace(&pair_protocol, &runtime_protocol));
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

fn primary_lan_ipv4() -> Result<Ipv4Addr, String> {
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
    let command = ("caffeinate", vec!["-is"]);
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

    Command::new(command.0)
        .args(command.1)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
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
        find_header_end, lock, rewrite_request, runtime_socket_addr, spawn_proxy, Connections,
        HEADER_TIMEOUT,
    };
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    use std::thread;
    use std::time::Duration;
    use url::Url;

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
        for _ in 0..500 {
            if lock(&connections.streams).is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(lock(&connections.streams).is_empty());

        connections.stopping.store(true, Ordering::SeqCst);
        proxy_thread.join().expect("stop proxy");
        upstream_thread.join().expect("stop upstream");
    }

    #[test]
    fn bounds_the_complete_header_read() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).expect("upstream listener");
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
            upstream.local_addr().expect("upstream address"),
            format!("http://{public_address}"),
            "pair-token".to_string(),
            "runtime-token".to_string(),
            Arc::clone(&connections),
        );

        let mut client = TcpStream::connect(public_address).expect("proxy connection");
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("read timeout");
        for _ in 0..4 {
            let _ = client.write_all(b"x");
            thread::sleep(HEADER_TIMEOUT / 3);
        }
        let mut response = String::new();
        let _ = client.read_to_string(&mut response);
        assert!(response.starts_with("HTTP/1.1 408 Request Timeout"));

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

        assert_eq!(
            runtime_socket_addr(&Url::parse("http://127.0.0.1:4170/").expect("url"))
                .expect("target")
                .to_string(),
            "127.0.0.1:4170",
        );
        assert!(runtime_socket_addr(&Url::parse("http://0.0.0.0:4170/").expect("url")).is_err());
    }
}
