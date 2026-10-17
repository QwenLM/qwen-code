package com.alibaba.qwen.code.managedagent;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

/**
 * TCP relay between Spring and the Hosted Harness for the event-stream
 * liveness gates (#14135). Each connection that carries a
 * {@code GET /session/:id/events} request is an events connection:
 * <ul>
 * <li>{@link #holdOnUpstreamDeath()} keeps the Spring side of an events
 * connection open after the Harness dies, the half-open shape a partition
 * or a moved pod leaves behind. Every other connection is reset, as a dead
 * peer's would be.</li>
 * <li>{@link #stallOpenEventStreams()} stops forwarding the Harness's bytes
 * on the events connections open now, while both peers stay alive.</li>
 * </ul>
 * The relay stamps every keepalive comment it forwards on an events
 * connection, so a gate can measure the cadence that reached Spring. It
 * rewrites the Host header to the Harness's own port, or the Harness's
 * host check refuses every request with 403.
 */
final class HostedEventStreamRelay implements AutoCloseable {
    private static final byte[] KEEPALIVE =
            ": keepalive".getBytes(StandardCharsets.US_ASCII);

    private final ServerSocket server;
    private final int upstreamPort;
    private final Pattern relayHost;
    private final Set<Connection> open = ConcurrentHashMap.newKeySet();
    private final List<Long> keepalives = new CopyOnWriteArrayList<>();
    private final AtomicInteger eventStreams = new AtomicInteger();
    private volatile boolean holdOnUpstreamDeath;
    private volatile long lastEventStreamByte;

    HostedEventStreamRelay(int upstreamPort) throws IOException {
        this.upstreamPort = upstreamPort;
        server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        relayHost = Pattern.compile("(?i)(\r\nhost:[ \t]*127\\.0\\.0\\.1):"
                + server.getLocalPort() + "(?=\r\n)");
        Thread acceptor = new Thread(this::accept, "event-relay-accept");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    int port() {
        return server.getLocalPort();
    }

    void holdOnUpstreamDeath() {
        holdOnUpstreamDeath = true;
    }

    void stallOpenEventStreams() {
        open.stream().filter(connection -> connection.events)
                .forEach(connection -> connection.stalled = true);
    }

    /** Events connections opened through the relay so far. */
    int eventStreams() {
        return eventStreams.get();
    }

    /** Events connections open now whose Spring side is still connected. */
    long openEventStreams() {
        return open.stream().filter(connection -> connection.events
                && !connection.client.isClosed()).count();
    }

    /** nanoTime of each keepalive forwarded to Spring, in order. */
    List<Long> keepalives() {
        return List.copyOf(keepalives);
    }

    /** nanoTime of the last Harness byte forwarded on an events connection. */
    long lastEventStreamByte() {
        return lastEventStreamByte;
    }

    @Override
    public void close() {
        try {
            server.close();
        } catch (IOException ignored) {
            // Nothing left to accept.
        }
        open.forEach(Connection::reset);
    }

    private void accept() {
        while (!server.isClosed()) {
            Socket client;
            try {
                client = server.accept();
            } catch (IOException closed) {
                return;
            }
            Socket upstream;
            try {
                upstream = new Socket(InetAddress.getLoopbackAddress(),
                        upstreamPort);
            } catch (IOException unreachable) {
                reset(client);
                continue;
            }
            Connection connection = new Connection(client, upstream);
            open.add(connection);
            start(connection::toUpstream);
            start(connection::toClient);
        }
    }

    private static void start(Runnable pump) {
        Thread thread = new Thread(pump, "event-relay-pump");
        thread.setDaemon(true);
        thread.start();
    }

    private static boolean contains(byte[] buffer, int length, byte[] token) {
        outer:
        for (int start = 0; start + token.length <= length; start++) {
            for (int index = 0; index < token.length; index++) {
                if (buffer[start + index] != token[index]) {
                    continue outer;
                }
            }
            return true;
        }
        return false;
    }

    private static void reset(Socket socket) {
        try {
            socket.setSoLinger(true, 0);
            socket.close();
        } catch (IOException ignored) {
            // Already closed.
        }
    }

    private final class Connection {
        private final Socket client;
        private final Socket upstream;
        private volatile boolean events;
        private volatile boolean stalled;

        Connection(Socket client, Socket upstream) {
            this.client = client;
            this.upstream = upstream;
        }

        void toUpstream() {
            byte[] buffer = new byte[16 * 1024];
            try {
                InputStream input = client.getInputStream();
                OutputStream output = upstream.getOutputStream();
                for (int read; (read = input.read(buffer)) >= 0;) {
                    // ISO-8859-1 maps every byte to one char, so the
                    // rewrite leaves any other byte as it was.
                    String chunk = new String(buffer, 0, read,
                            StandardCharsets.ISO_8859_1);
                    if (!events && chunk.startsWith("GET /session/")
                            && chunk.contains("/events ")) {
                        events = true;
                        eventStreams.incrementAndGet();
                    }
                    byte[] forwarded = relayHost.matcher(chunk)
                            .replaceAll("$1:" + upstreamPort)
                            .getBytes(StandardCharsets.ISO_8859_1);
                    try {
                        output.write(forwarded);
                        output.flush();
                    } catch (IOException upstreamGone) {
                        if (!(events && holdOnUpstreamDeath)) {
                            throw upstreamGone;
                        }
                        // Half-open: the Spring side keeps its socket, and
                        // what it writes lands nowhere.
                    }
                }
            } catch (IOException broken) {
                reset();
                return;
            }
            // Spring closed its side: the connection is done.
            reset();
        }

        void toClient() {
            byte[] buffer = new byte[16 * 1024];
            try {
                InputStream input = upstream.getInputStream();
                OutputStream output = client.getOutputStream();
                for (int read; (read = input.read(buffer)) >= 0;) {
                    if (events) {
                        if (stalled) {
                            continue;
                        }
                        long now = System.nanoTime();
                        lastEventStreamByte = now;
                        if (contains(buffer, read, KEEPALIVE)) {
                            keepalives.add(now);
                        }
                    }
                    output.write(buffer, 0, read);
                    output.flush();
                }
            } catch (IOException broken) {
                // Fall through: the Harness side ended.
            }
            if (events && holdOnUpstreamDeath) {
                // The Harness is gone, but nothing reaches Spring: no FIN,
                // no reset. Only Spring's own close ends this connection.
                return;
            }
            reset();
        }

        void reset() {
            open.remove(this);
            HostedEventStreamRelay.reset(client);
            HostedEventStreamRelay.reset(upstream);
        }
    }
}
