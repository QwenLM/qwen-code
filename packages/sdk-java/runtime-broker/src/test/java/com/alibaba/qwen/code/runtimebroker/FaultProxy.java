package com.alibaba.qwen.code.runtimebroker;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * HTTP forward proxy that sits between one Broker process and its Runtime
 * workers. The Broker's {@code HttpClient} sends every request here in
 * absolute form; the proxy forwards it and then applies the next fault
 * scheduled for that operation. Every request is logged when it arrives, so
 * a gate can count the transport calls a Broker made, including those whose
 * answer never came back.
 */
final class FaultProxy implements AutoCloseable {
    private static final int HEAD_LIMIT = 64 * 1024;

    enum Action {
        /** Forward the request and deliver the response. */
        PASS,
        /** Forward the request, read the response, then close silently. */
        DROP,
        /** Forward the request, read the response, then reset the socket. */
        RESET,
        /** Forward the request and deliver the response late. */
        DELAY,
        /** Hold the request before forwarding until released. */
        HOLD_REQUEST,
        /** Forward the request and hold the response until released. */
        HOLD_RESPONSE
    }

    /** One scheduled fault; hold faults report when they caught a request. */
    static final class Fault {
        private final Action action;
        private final Duration delay;
        private final CountDownLatch held = new CountDownLatch(1);
        private final CountDownLatch delivered = new CountDownLatch(1);
        private final CompletableFuture<Action> release =
                new CompletableFuture<>();

        private Fault(Action action, Duration delay) {
            this.action = action;
            this.delay = delay;
        }

        static Fault of(Action action) {
            return new Fault(action, Duration.ZERO);
        }

        static Fault delay(Duration delay) {
            return new Fault(Action.DELAY, delay);
        }

        void awaitHeld(Duration timeout) throws InterruptedException {
            if (!held.await(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                throw new AssertionError(action + " fault caught nothing in "
                        + timeout);
            }
        }

        void awaitDelivered(Duration timeout) throws InterruptedException {
            if (!delivered.await(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                throw new AssertionError(action + " fault delivered nothing in "
                        + timeout);
            }
        }

        /** PASS delivers the held exchange; DROP or RESET ends it. */
        void release(Action outcome) {
            release.complete(outcome);
        }
    }

    record Exchange(String operation, long arrivedNanos) {
    }

    private final ServerSocket server;
    private final Map<String, Queue<Fault>> faults = new ConcurrentHashMap<>();
    private final List<Fault> scheduled = new CopyOnWriteArrayList<>();
    private final List<Exchange> exchanges = new CopyOnWriteArrayList<>();
    private final Set<Socket> open = ConcurrentHashMap.newKeySet();

    FaultProxy() throws IOException {
        server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        Thread acceptor = new Thread(this::accept, "fault-proxy-accept");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    int port() {
        return server.getLocalPort();
    }

    /** Queues a fault for the next request of {@code operation}. */
    Fault schedule(String operation, Fault fault) {
        faults.computeIfAbsent(operation,
                ignored -> new ConcurrentLinkedQueue<>()).add(fault);
        scheduled.add(fault);
        return fault;
    }

    Fault schedule(String operation, Action action) {
        return schedule(operation, Fault.of(action));
    }

    long count(String operation) {
        return exchanges.stream()
                .filter(exchange -> exchange.operation().equals(operation))
                .count();
    }

    long countSince(long nanos) {
        return exchanges.stream()
                .filter(exchange -> exchange.arrivedNanos() >= nanos)
                .count();
    }

    List<Exchange> exchanges() {
        return List.copyOf(exchanges);
    }

    @Override
    public void close() {
        try {
            server.close();
        } catch (IOException ignored) {
            // Nothing left to accept.
        }
        scheduled.forEach(fault -> fault.release(Action.RESET));
        open.forEach(FaultProxy::reset);
    }

    private void accept() {
        while (!server.isClosed()) {
            Socket client;
            try {
                client = server.accept();
            } catch (IOException closed) {
                return;
            }
            Thread handler = new Thread(() -> serve(client),
                    "fault-proxy-exchange");
            handler.setDaemon(true);
            handler.start();
        }
    }

    private void serve(Socket client) {
        open.add(client);
        try (client) {
            Request request = readRequest(new BufferedInputStream(
                    client.getInputStream()));
            String path = request.target().getRawPath();
            String operation = path.substring(path.lastIndexOf('/') + 1);
            exchanges.add(new Exchange(operation, System.nanoTime()));
            Queue<Fault> queue = faults.get(operation);
            Fault polled = queue == null ? null : queue.poll();
            Fault fault = polled == null ? Fault.of(Action.PASS) : polled;
            if (fault.action == Action.HOLD_REQUEST) {
                fault.held.countDown();
                Action outcome = fault.release.join();
                if (outcome != Action.PASS) {
                    end(client, outcome);
                    return;
                }
            }
            byte[] response;
            try {
                response = forward(request);
            } catch (IOException unreachable) {
                // A dead worker refuses the connection; so does the proxy.
                reset(client);
                return;
            }
            Action outcome = switch (fault.action) {
                case DROP, RESET -> fault.action;
                case DELAY -> {
                    Thread.sleep(fault.delay.toMillis());
                    yield Action.PASS;
                }
                case HOLD_RESPONSE -> {
                    fault.held.countDown();
                    yield fault.release.join();
                }
                default -> Action.PASS;
            };
            if (outcome != Action.PASS) {
                end(client, outcome);
                return;
            }
            OutputStream output = client.getOutputStream();
            output.write(response);
            output.flush();
            fault.delivered.countDown();
        } catch (IOException | InterruptedException ignored) {
            // The Broker gave up on this exchange; nothing to deliver.
        } finally {
            open.remove(client);
        }
    }

    private static void end(Socket client, Action outcome) {
        if (outcome == Action.RESET) {
            reset(client);
        }
        // DROP: the enclosing try closes the socket without a response.
    }

    private static void reset(Socket socket) {
        try {
            socket.setSoLinger(true, 0);
            socket.close();
        } catch (IOException ignored) {
            // Already closed.
        }
    }

    private byte[] forward(Request request) throws IOException {
        URI target = request.target();
        Socket upstream = new Socket(target.getHost(), target.getPort());
        open.add(upstream);
        try (upstream) {
            StringBuilder head = new StringBuilder()
                    .append(request.method()).append(' ')
                    .append(target.getRawPath()).append(" HTTP/1.1\r\n");
            for (String[] header : request.headers()) {
                String name = header[0].toLowerCase(Locale.ROOT);
                if (!name.equals("connection")
                        && !name.equals("proxy-connection")
                        && !name.equals("keep-alive")) {
                    head.append(header[0]).append(": ").append(header[1])
                            .append("\r\n");
                }
            }
            head.append("Connection: close\r\n\r\n");
            OutputStream output = upstream.getOutputStream();
            output.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
            output.write(request.body());
            output.flush();
            // The worker closes after its response, so the whole exchange
            // is what arrives before end of stream.
            return upstream.getInputStream().readAllBytes();
        } finally {
            open.remove(upstream);
        }
    }

    private static Request readRequest(InputStream input) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int lastFour = 0;
        while (lastFour != 0x0D0A0D0A) {
            int value = input.read();
            if (value < 0 || head.size() >= HEAD_LIMIT) {
                throw new IOException("incomplete request head");
            }
            head.write(value);
            lastFour = (lastFour << 8) | value;
        }
        String[] lines = head.toString(StandardCharsets.ISO_8859_1)
                .split("\r\n");
        String[] requestLine = lines[0].split(" ");
        if (requestLine.length != 3) {
            throw new IOException("malformed request line");
        }
        List<String[]> headers = new ArrayList<>();
        int length = 0;
        for (int index = 1; index < lines.length; index++) {
            int colon = lines[index].indexOf(':');
            if (colon <= 0) {
                continue;
            }
            String name = lines[index].substring(0, colon).trim();
            String value = lines[index].substring(colon + 1).trim();
            if (name.equalsIgnoreCase("transfer-encoding")) {
                throw new IOException("chunked requests are not proxied");
            }
            if (name.equalsIgnoreCase("content-length")) {
                length = Integer.parseInt(value);
            }
            headers.add(new String[] {name, value});
        }
        return new Request(requestLine[0], URI.create(requestLine[1]),
                headers, input.readNBytes(length));
    }

    private record Request(String method, URI target, List<String[]> headers,
            byte[] body) {
    }
}
