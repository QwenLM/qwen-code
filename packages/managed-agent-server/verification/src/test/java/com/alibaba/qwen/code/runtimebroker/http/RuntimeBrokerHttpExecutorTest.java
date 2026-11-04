package com.alibaba.qwen.code.runtimebroker.http;

import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class RuntimeBrokerHttpExecutorTest {
    private static final String SESSION = "11111111-1111-1111-1111-111111111111";
    private static final String PATH = "/internal/managed-session-store/v1/sessions/"
            + SESSION + "/csi-retirement:worker-authority";

    @Test
    void saturatedDispatchClosesExcessConnectionsAndRecovers() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.fillWorkers();
            for (int index = 0; index < 64; index++) {
                fixture.connect();
            }
            await().atMost(5, TimeUnit.SECONDS).until(() -> fixture.executor.getQueue().size() == 64);
            try (Socket rejected = fixture.open()) {
                assertDisconnected(rejected);
            }
            assertEquals(32, fixture.executor.getLargestPoolSize());
            assertEquals(32, fixture.threads.size());
            assertTrue(fixture.threads.stream().allMatch(thread -> thread.isDaemon()
                    && thread.getName().startsWith("runtime-broker-http-")));
            assertEquals(32, fixture.threads.stream().map(Thread::getName).distinct().count());
            fixture.release.countDown();
            for (Socket accepted : fixture.sockets) {
                assertResponse(accepted);
            }
            try (Socket next = fixture.open()) {
                assertResponse(next);
            }
        }
    }

    @Test
    void closeDisconnectsRunningAndQueuedRequestsAndStopsWorkers() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.fillWorkers();
            fixture.connect();
            await().atMost(5, TimeUnit.SECONDS).until(() -> fixture.executor.getQueue().size() == 1);
            fixture.server.close();
            for (Socket socket : fixture.sockets) {
                assertDisconnected(socket);
            }
            assertTrue(fixture.executor.awaitTermination(5, TimeUnit.SECONDS));
            verify(fixture.service).close();
        }
    }

    private static void assertDisconnected(Socket socket) throws Exception {
        try {
            assertEquals(-1, socket.getInputStream().read());
        } catch (SocketException reset) {
            // JDK/OS may report a reset instead of EOF for the refused connection.
        }
    }

    private static void assertResponse(Socket socket) throws Exception {
        String response = new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertTrue(response.startsWith("HTTP/1.1 200"), response);
        assertTrue(response.endsWith("{\"accepted\":true}"), response);
    }

    private static final class Fixture implements AutoCloseable {
        private final RuntimeBrokerService service = mock(RuntimeBrokerService.class);
        private final RuntimeBrokerHttpServer server;
        private final ThreadPoolExecutor executor;
        private final CountDownLatch entered = new CountDownLatch(32);
        private final CountDownLatch release = new CountDownLatch(1);
        private final Set<Thread> threads = ConcurrentHashMap.newKeySet();
        private final List<Socket> sockets = new ArrayList<>();

        private Fixture() throws Exception {
            server = new RuntimeBrokerHttpServer(new InetSocketAddress("127.0.0.1", 0), "secret", service);
            var field = RuntimeBrokerHttpServer.class.getDeclaredField("executor");
            field.setAccessible(true);
            executor = (ThreadPoolExecutor) field.get(server);
            server.registerCsiApplicationAuthority("tenant", SESSION, (token, body) -> {
                threads.add(Thread.currentThread());
                entered.countDown();
                try {
                    release.await();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                return Map.of("accepted", true);
            });
            server.start();
        }

        private void fillWorkers() throws Exception {
            for (int index = 0; index < 32; index++) {
                connect();
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS));
        }

        private void connect() throws Exception {
            sockets.add(open());
        }

        private Socket open() throws Exception {
            Socket socket = new Socket();
            try {
                socket.connect(new InetSocketAddress("127.0.0.1", server.getBaseUri().getPort()), 5000);
                socket.setSoTimeout(5000);
                String request = "POST " + PATH + " HTTP/1.1\r\nHost: localhost\r\n"
                        + "Authorization: Bearer worker\r\nX-Qwen-Tenant-Id: tenant\r\n"
                        + "Content-Type: application/json\r\nCache-Control: no-store\r\n"
                        + "Content-Length: 2\r\nConnection: close\r\n\r\n{}";
                socket.getOutputStream().write(request.getBytes(StandardCharsets.UTF_8));
                return socket;
            } catch (Exception failure) {
                socket.close();
                throw failure;
            }
        }

        @Override
        public void close() throws Exception {
            release.countDown();
            server.close();
            for (Socket socket : sockets) {
                socket.close();
            }
            assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS));
        }
    }
}
