package com.alibaba.qwen.code.managedagent;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

// TCP may split a request or a keepalive at any byte, or join pieces into
// one read. Each send below goes out on its own, so the relay mostly reads
// the pieces apart, and every assertion holds however the reads fall.
class HostedEventStreamRelayTest {
    @Test
    @Timeout(15)
    void framesRequestsAndKeepalivesSplitAcrossReads() throws Exception {
        try (ServerSocket harness = new ServerSocket(0, 50,
                InetAddress.getLoopbackAddress());
                HostedEventStreamRelay relay =
                        new HostedEventStreamRelay(harness.getLocalPort())) {
            String relayPort = Integer.toString(relay.port());
            String harnessHost = "Host: 127.0.0.1:" + harness.getLocalPort();

            // A body that names the events route is a body, not a stream.
            String body = "GET /session/decoy/events HTTP/1.1\r\n";
            try (Socket client = connect(relay);
                    Socket upstream = harness.accept()) {
                send(client, "POST /session/demo/prompt HTTP/1.1\r\n"
                        + "Host: 127.0.0.1:" + relayPort + "\r\n"
                        + "Content-Length: " + body.length() + "\r\n\r\n");
                send(client, body);
                assertThat(receive(upstream, "\r\n\r\n" + body))
                        .contains(harnessHost + "\r\n");
                assertThat(relay.eventStreams()).isZero();
            }

            // The request line and the Host port each split mid-token.
            try (Socket client = connect(relay);
                    Socket upstream = harness.accept()) {
                send(client, "GET /session/demo/");
                send(client, "events HTTP/1.1\r\nHost: 127.0.0.1:"
                        + relayPort.substring(0, 2));
                send(client, relayPort.substring(2) + "\r\n\r\n");
                assertThat(receive(upstream, "\r\n\r\n"))
                        .startsWith("GET /session/demo/events HTTP/1.1\r\n"
                                + harnessHost + "\r\n");
                assertThat(relay.eventStreams()).isEqualTo(1);

                send(upstream, "HTTP/1.1 200 OK\r\n\r\n: keep");
                send(upstream, "alive\n\n");
                send(upstream, ": keepalive\n\n");
                receive(client, ": keepalive\n\n: keepalive\n\n");
                await(() -> relay.keepalives().size() == 2);
                assertThat(relay.keepalives()).hasSize(2);
            }
            assertThat(relay.faults()).isEmpty();
        }
    }

    @Test
    @Timeout(15)
    void countsEachKeepaliveOneReadCarries() throws Exception {
        try (ServerSocket harness = new ServerSocket(0, 50,
                InetAddress.getLoopbackAddress());
                HostedEventStreamRelay relay =
                        new HostedEventStreamRelay(harness.getLocalPort());
                Socket client = connect(relay);
                Socket upstream = harness.accept()) {
            send(client, "GET /session/demo/events HTTP/1.1\r\n"
                    + "Host: 127.0.0.1:" + relay.port() + "\r\n\r\n");
            receive(upstream, "\r\n\r\n");
            // One write, so both keepalives reach the relay in one read.
            send(upstream, "HTTP/1.1 200 OK\r\n\r\n"
                    + ": keepalive\n\n: keepalive\n\n");
            receive(client, ": keepalive\n\n: keepalive\n\n");
            await(() -> relay.keepalives().size() == 2);
            assertThat(relay.keepalives()).hasSize(2);
        }
    }

    @Test
    @Timeout(15)
    void resetsARequestItCannotFrame() throws Exception {
        try (ServerSocket harness = new ServerSocket(0, 50,
                InetAddress.getLoopbackAddress());
                HostedEventStreamRelay relay =
                        new HostedEventStreamRelay(harness.getLocalPort());
                Socket client = connect(relay);
                Socket upstream = harness.accept()) {
            send(client, "POST /session/demo/prompt HTTP/1.1\r\n"
                    + "Transfer-Encoding: chunked\r\n\r\n4\r\nbody\r\n0\r\n\r\n");
            await(() -> !relay.faults().isEmpty());
            assertThat(relay.faults()).singleElement().asString()
                    .contains("Transfer-Encoding");
            int first;
            try {
                first = upstream.getInputStream().read();
            } catch (IOException reset) {
                first = -1;
            }
            assertThat(first).as("bytes that reached the Harness").isEqualTo(-1);
        }
    }

    private static Socket connect(HostedEventStreamRelay relay)
            throws IOException {
        Socket socket = new Socket(InetAddress.getLoopbackAddress(),
                relay.port());
        socket.setSoTimeout(5000);
        return socket;
    }

    private static void send(Socket socket, String text) throws Exception {
        socket.setTcpNoDelay(true);
        OutputStream output = socket.getOutputStream();
        output.write(text.getBytes(StandardCharsets.ISO_8859_1));
        output.flush();
        // Long enough for the relay to read this piece on its own.
        Thread.sleep(100);
    }

    private static String receive(Socket socket, String end)
            throws IOException {
        socket.setSoTimeout(5000);
        InputStream input = socket.getInputStream();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        while (!bytes.toString(StandardCharsets.ISO_8859_1).endsWith(end)) {
            int value = input.read();
            if (value < 0) {
                break;
            }
            bytes.write(value);
        }
        return bytes.toString(StandardCharsets.ISO_8859_1);
    }

    private static void await(BooleanSupplier condition)
            throws InterruptedException {
        long deadline = System.nanoTime() + 5_000_000_000L;
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) {
            Thread.sleep(20);
        }
    }
}
