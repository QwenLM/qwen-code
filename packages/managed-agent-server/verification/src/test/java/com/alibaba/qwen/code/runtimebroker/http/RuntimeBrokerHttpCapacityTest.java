package com.alibaba.qwen.code.runtimebroker.http;

import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

class RuntimeBrokerHttpCapacityTest {
    @Test
    void refusesAnExcessConnectionAndServesRequestsAfterCapacityReturns() throws Exception {
        var entered = new CountDownLatch(64);
        var release = new CountDownLatch(1);
        String session = UUID.randomUUID().toString();
        String path = "/internal/managed-session-store/v1/sessions/" + session + "/csi-retirement:worker-authority";
        List<Socket> held = new ArrayList<>();
        try (var server = new RuntimeBrokerHttpServer(new InetSocketAddress("127.0.0.1", 0),
                "test-token", mock(RuntimeBrokerService.class))) {
            server.registerCsiApplicationAuthority("tenant", session, (token, body) -> {
                entered.countDown();
                try {
                    if (!release.await(10, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("test did not release HTTP handlers");
                    }
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
                return Map.of("ready", true);
            });
            server.start();
            int port = server.getBaseUri().getPort();
            try {
                for (int index = 0; index < 64; index++) {
                    Socket connection = connect(port);
                    held.add(connection);
                    send(connection, path);
                }
                assertTrue(entered.await(5, TimeUnit.SECONDS), "64 requests must enter the handler");
                try (Socket excess = connect(port)) {
                    try {
                        send(excess, path);
                        assertEquals(-1, excess.getInputStream().read(), "overflow must be rejected without a response queue");
                    } catch (SocketException reset) {
                        // The JDK dispatcher may reset or close a rejected connection.
                    }
                }
                release.countDown();
                for (Socket connection : held) {
                    assertOk(connection);
                }
                try (Socket recovered = connect(port)) {
                    send(recovered, path);
                    assertOk(recovered);
                }
            } finally {
                release.countDown();
                for (Socket connection : held) {
                    connection.close();
                }
            }
        }
    }

    private static Socket connect(int port) throws IOException {
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress("127.0.0.1", port), 3000);
            socket.setSoTimeout(3000);
            return socket;
        } catch (IOException failure) {
            socket.close();
            throw failure;
        }
    }

    private static void send(Socket connection, String path) throws IOException {
        String request = "POST " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                + "Authorization: Bearer test-token\r\nX-Qwen-Tenant-Id: tenant\r\n"
                + "Content-Type: application/json\r\nCache-Control: no-store\r\n"
                + "Connection: close\r\nContent-Length: 2\r\n\r\n{}";
        connection.getOutputStream().write(request.getBytes(StandardCharsets.UTF_8));
        connection.getOutputStream().flush();
    }

    private static void assertOk(Socket connection) throws IOException {
        String response = new String(connection.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertTrue(response.startsWith("HTTP/1.1 200"), response);
    }
}
