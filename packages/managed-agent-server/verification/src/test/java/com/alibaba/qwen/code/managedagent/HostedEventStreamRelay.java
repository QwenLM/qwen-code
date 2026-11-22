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
import java.util.regex.Matcher;
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
 * host check refuses every request with 403. TCP may split a request or a
 * keepalive at any byte, so the relay frames each request by its head and
 * {@code Content-Length}, and matches keepalives across reads. A request
 * it cannot frame is recorded in {@link #faults()} and reset.
 */
final class HostedEventStreamRelay implements AutoCloseable {
    private static final byte[] KEEPALIVE =
            ": keepalive".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] HEAD_END =
            "\r\n\r\n".getBytes(StandardCharsets.US_ASCII);
    // The SDK's request heads are a few hundred bytes.
    private static final int MAXIMUM_HEAD_BYTES = 64 * 1024;
    private static final Pattern EVENTS_REQUEST = Pattern.compile(
            "GET /session/[^ ]+/events(?:\\?[^ ]*)? HTTP/1\\.1\r\n");
    private static final Pattern CONTENT_LENGTH = Pattern.compile(
            "(?im)^content-length:[ \t]*(\\d+)[ \t]*$");
    private static final Pattern TRANSFER_ENCODING = Pattern.compile(
            "(?im)^transfer-encoding:");

    private final ServerSocket server;
    private final int upstreamPort;
    private final Pattern relayHost;
    private final Set<Connection> open = ConcurrentHashMap.newKeySet();
    private final List<Long> keepalives = new CopyOnWriteArrayList<>();
    private final List<String> faults = new CopyOnWriteArrayList<>();
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

    /** Requests the relay could not frame, each one reset. */
    List<String> faults() {
        return List.copyOf(faults);
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

    private static int occurrences(byte[] buffer, int length, byte[] token) {
        int found = 0;
        outer:
        for (int start = 0; start + token.length <= length; start++) {
            for (int index = 0; index < token.length; index++) {
                if (buffer[start + index] != token[index]) {
                    continue outer;
                }
            }
            found++;
            start += token.length - 1;
        }
        return found;
    }

    private static boolean endsWith(byte[] buffer, int length, byte[] token) {
        if (length < token.length) {
            return false;
        }
        for (int index = 0; index < token.length; index++) {
            if (buffer[length - token.length + index] != token[index]) {
                return false;
            }
        }
        return true;
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
            byte[] head = new byte[MAXIMUM_HEAD_BYTES];
            int headLength = 0;
            long body = 0;
            try {
                InputStream input = client.getInputStream();
                OutputStream output = upstream.getOutputStream();
                for (int read; (read = input.read(buffer)) >= 0;) {
                    int at = 0;
                    while (at < read) {
                        if (body > 0) {
                            int length = (int) Math.min(body, read - at);
                            forward(output, buffer, at, length);
                            body -= length;
                            at += length;
                        } else if (headLength == head.length) {
                            fault("a request head over " + head.length
                                    + " bytes");
                            return;
                        } else {
                            head[headLength++] = buffer[at++];
                            if (endsWith(head, headLength, HEAD_END)) {
                                body = forwardHead(output, new String(head, 0,
                                        headLength,
                                        StandardCharsets.ISO_8859_1));
                                headLength = 0;
                                if (body < 0) {
                                    return;
                                }
                            }
                        }
                    }
                }
            } catch (IOException broken) {
                reset();
                return;
            }
            // Spring closed its side: the connection is done.
            reset();
        }

        // Forwards one complete request head, and returns the length of
        // the body that follows it, or -1 after a fault.
        private long forwardHead(OutputStream output, String head)
                throws IOException {
            if (TRANSFER_ENCODING.matcher(head).find()) {
                // The SDK sends every body with a Content-Length.
                fault("a request with a Transfer-Encoding: "
                        + head.lines().findFirst().orElse(""));
                return -1;
            }
            // The flag is set before the request reaches the Harness, so
            // the response side counts the stream's first byte.
            if (!events && EVENTS_REQUEST.matcher(head).lookingAt()) {
                events = true;
                eventStreams.incrementAndGet();
            }
            Matcher length = CONTENT_LENGTH.matcher(head);
            long body = length.find() ? Long.parseLong(length.group(1)) : 0;
            // ISO-8859-1 maps every byte to one char, so the rewrite leaves
            // any other byte as it was.
            byte[] forwarded = relayHost.matcher(head)
                    .replaceAll("$1:" + upstreamPort)
                    .getBytes(StandardCharsets.ISO_8859_1);
            forward(output, forwarded, 0, forwarded.length);
            return body;
        }

        private void forward(OutputStream output, byte[] bytes, int offset,
                int length) throws IOException {
            try {
                output.write(bytes, offset, length);
                output.flush();
            } catch (IOException upstreamGone) {
                if (!(events && holdOnUpstreamDeath)) {
                    throw upstreamGone;
                }
                // Half-open: the Spring side keeps its socket, and what it
                // writes lands nowhere.
            }
        }

        private void fault(String fault) {
            faults.add(fault);
            reset();
        }

        void toClient() {
            byte[] buffer = new byte[16 * 1024];
            // The tail of the earlier reads ahead of each new one, so a
            // keepalive split across reads still counts. The tail is a byte
            // shorter than a keepalive, so none counts twice, and each of
            // the keepalives one read carries counts on its own.
            byte[] window = new byte[KEEPALIVE.length - 1 + buffer.length];
            int carried = 0;
            try {
                InputStream input = upstream.getInputStream();
                OutputStream output = client.getOutputStream();
                for (int read; (read = input.read(buffer)) >= 0;) {
                    if (events) {
                        if (stalled) {
                            carried = 0;
                            continue;
                        }
                        long now = System.nanoTime();
                        lastEventStreamByte = now;
                        System.arraycopy(buffer, 0, window, carried, read);
                        int length = carried + read;
                        for (int found = occurrences(window, length,
                                KEEPALIVE); found > 0; found--) {
                            keepalives.add(now);
                        }
                        carried = Math.min(KEEPALIVE.length - 1, length);
                        System.arraycopy(window, length - carried, window, 0,
                                carried);
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
