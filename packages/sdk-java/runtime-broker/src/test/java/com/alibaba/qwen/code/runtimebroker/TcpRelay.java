package com.alibaba.qwen.code.runtimebroker;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * TCP relay in front of the database server. {@link #cut()} makes the
 * database unreachable for everything behind the relay: open connections are
 * reset and new ones are refused until {@link #restore()}.
 */
final class TcpRelay implements AutoCloseable {
    private final ServerSocket server;
    private final int upstreamPort;
    private final AtomicBoolean available = new AtomicBoolean(true);
    private final AtomicInteger refused = new AtomicInteger();
    private final Set<Socket> open = ConcurrentHashMap.newKeySet();

    TcpRelay(int upstreamPort) throws IOException {
        this.upstreamPort = upstreamPort;
        server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        Thread acceptor = new Thread(this::accept, "tcp-relay-accept");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    int port() {
        return server.getLocalPort();
    }

    void cut() {
        available.set(false);
        open.forEach(TcpRelay::reset);
    }

    void restore() {
        available.set(true);
    }

    /** Connection attempts refused while the relay was cut. */
    int refused() {
        return refused.get();
    }

    /** Whether no connection is open through the relay right now. */
    boolean idle() {
        return open.isEmpty();
    }

    @Override
    public void close() {
        try {
            server.close();
        } catch (IOException ignored) {
            // Nothing left to accept.
        }
        open.forEach(TcpRelay::reset);
    }

    private void accept() {
        while (!server.isClosed()) {
            Socket client;
            try {
                client = server.accept();
            } catch (IOException closed) {
                return;
            }
            if (!available.get()) {
                refused.incrementAndGet();
                reset(client);
                continue;
            }
            Socket upstream;
            try {
                upstream = new Socket(InetAddress.getLoopbackAddress(),
                        upstreamPort);
            } catch (IOException unreachable) {
                reset(client);
                continue;
            }
            open.add(client);
            open.add(upstream);
            AtomicInteger directions = new AtomicInteger(2);
            pump(client, upstream, directions);
            pump(upstream, client, directions);
        }
    }

    private void pump(Socket from, Socket to, AtomicInteger directions) {
        Thread thread = new Thread(() -> {
            byte[] buffer = new byte[16 * 1024];
            try {
                InputStream input = from.getInputStream();
                OutputStream output = to.getOutputStream();
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    output.write(buffer, 0, read);
                    output.flush();
                }
                to.shutdownOutput();
            } catch (IOException broken) {
                reset(from);
                reset(to);
            } finally {
                if (directions.decrementAndGet() == 0) {
                    open.remove(from);
                    open.remove(to);
                    close(from);
                    close(to);
                }
            }
        }, "tcp-relay-pump");
        thread.setDaemon(true);
        thread.start();
    }

    private static void close(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // Already closed.
        }
    }

    private static void reset(Socket socket) {
        try {
            socket.setSoLinger(true, 0);
            socket.close();
        } catch (IOException ignored) {
            // Already closed.
        }
    }
}
