package com.alibaba.qwen.code.managedagent.harness;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilities;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.test.util.ReflectionTestUtils;

// Witness for the cold-burst wedge at
// https://github.com/QwenLM/qwen-code/issues/13333#user-content-creating:
// attachment creation of a Session runs a blocking Harness createSession
// call. If QwenHostedHarnessConnector did that inside
// attachments.computeIfAbsent, every such call holds the map's bin
// monitor while it blocks, so a cold burst of carriers+2 distinct
// Sessions pins every virtual-thread carrier on JDK 21 (measured on the
// packaged stack: 32 Turns failing with carriers pinned in
// ConcurrentHashMap and the thread holding the placement-domain row lock
// starved). With single-flight the same callers park on a per-key
// ReentrantLock instead — the fixture parks all createSession answers on
// one latch, then a probe must still complete, and when the latch opens
// every caller must settle.
class HostedHarnessCreateOrLoadPinningTest {
    private static final String BOOT_ID =
            "11111111-1111-4111-8111-111111111111";
    private static final String DIGEST = "sha256:"
            + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    private CountDownLatch open;

    @AfterEach
    void tearDown() {
        if (open != null) {
            open.countDown();
        }
    }

    @Test
    @Timeout(120)
    void coldBurstAttachmentMustNotStarveOtherVirtualThreads()
            throws Exception {
        open = new CountDownLatch(1);
        CountDownLatch arrived = new CountDownLatch(carrierCount() + 2);
        HostedHarnessCapabilities capabilities = mock(
                HostedHarnessCapabilities.class);
        when(capabilities.getBootId()).thenReturn(BOOT_ID);
        HostedHarnessClient client = mock(HostedHarnessClient.class);
        when(client.capabilities()).thenReturn(capabilities);
        when(client.createSession(any())).thenAnswer(invocation -> {
            arrived.countDown();
            try {
                open.await();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            HarnessSessionRef ref = mock(HarnessSessionRef.class);
            when(ref.getHarnessBootId()).thenReturn(BOOT_ID);
            return ref;
        });
        QwenHostedHarnessConnector connector = connector(client);
        AtomicBoolean allOk = new AtomicBoolean(true);
        AtomicInteger probeProgress = new AtomicInteger();
        List<Thread> callers = new ArrayList<>();
        List<String> sessionIds = new ArrayList<>();
        List<String> unsettled = new ArrayList<>();
        int callerCount = carrierCount() + 2;
        try {
            for (int index = 0; index < callerCount; index++) {
                String sessionId = java.util.UUID.randomUUID().toString();
                sessionIds.add(sessionId);
                callers.add(Thread.ofVirtual().start(() -> {
                    try {
                        connector.createOrLoad("tenant-burst", sessionId,
                                false);
                    } catch (RuntimeException error) {
                        System.err.println("PINNING-MARKER caller " + sessionId
                                + " failed: " + error);
                        allOk.set(false);
                    }
                }));
            }
            // Every caller must park inside its attachment creation
            // before the probe starts, exactly where an attachment
            // monitor would capture the carriers.
            if (!arrived.await(60, TimeUnit.SECONDS)) {
                throw new IllegalStateException("callers never reached"
                        + " the latched createSession call");
            }
            Thread.sleep(1000);
            Thread probe = Thread.ofVirtual().start(() -> {
                for (int tick = 0; tick < 400; tick++) {
                    probeProgress.incrementAndGet();
                }
            });
            probe.join(30_000);
            assertTrue(!probe.isAlive() && probeProgress.get() >= 400,
                    "virtual-thread probe starved by " + callerCount
                            + " blocked attachment creations (progress="
                            + probeProgress.get()
                            + ") — a map bin monitor pinned its carrier");
        } finally {
            open.countDown();
            // One shared deadline for the whole loop: a per-caller 30 s
            // join budgets (carriers + 2) half-minutes against the
            // method's @Timeout(120), so a wedged caller would abort the
            // run with a bare timeout before the unsettled Session ids
            // are ever reported.
            long deadline = System.nanoTime()
                    + TimeUnit.SECONDS.toNanos(20);
            for (int index = 0; index < callers.size(); index++) {
                callers.get(index).join(Math.max(1L,
                        TimeUnit.NANOSECONDS.toMillis(
                                deadline - System.nanoTime())));
                if (callers.get(index).isAlive()) {
                    unsettled.add(sessionIds.get(index));
                }
            }
        }
        assertTrue(unsettled.isEmpty(),
                "callers never settled after the latch opened: " + unsettled);
        assertTrue(allOk.get(), "callers failed after the latch opened");
    }

    // Sibling witness for the connector's remaining monitor: the first
    // client() call builds HostedHarnessClient, whose constructor blocks
    // on the capabilities round trip. With synchronized (this) every
    // other cold caller waits on monitorenter and pins its carrier; with
    // the ReentrantLock the waiters park and unmount. A cold burst of
    // carriers+2 callers on distinct Sessions therefore starves an
    // unrelated virtual-thread probe only under the monitor.
    @Test
    @Timeout(120)
    void coldClientInitMustNotStarveOtherVirtualThreads()
            throws Exception {
        open = new CountDownLatch(1);
        CountDownLatch capabilitiesRequested = new CountDownLatch(1);
        AtomicInteger capabilitiesHits = new AtomicInteger();
        HttpServer server = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        ExecutorService serverExecutor = Executors.newCachedThreadPool();
        server.setExecutor(serverExecutor);
        server.createContext("/capabilities", exchange -> {
            capabilitiesHits.incrementAndGet();
            capabilitiesRequested.countDown();
            try {
                open.await();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            byte[] bytes = ("{\"v\":1,\"mode\":\"http-bridge\","
                    + "\"features\":[\"hosted_harness_private_v1\","
                    + "\"managed_session_journal_delta_v1\"],"
                    + "\"transports\":[\"rest\"],\"hostedHarness\":{"
                    + "\"protocolVersions\":{\"current\":1,"
                    + "\"supported\":[1]},\"bootId\":\"" + BOOT_ID
                    + "\",\"capabilityDigest\":\"" + DIGEST
                    + "\"}}").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type",
                    "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        ObjectMapper json = new ObjectMapper();
        server.createContext("/session", exchange -> {
            String requested = json.readTree(exchange.getRequestBody())
                    .get("sessionId").asText();
            byte[] bytes = ("{\"sessionId\":\"" + requested
                    + "\",\"workspaceCwd\":\"/control\","
                    + "\"attached\":true,\"clientId\":\"client-1\"}")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type",
                    "application/json");
            exchange.getResponseHeaders().set(
                    "X-Qwen-Harness-Boot-Id", BOOT_ID);
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setToken("token");
        properties.getHarness().setCapabilityDigest(DIGEST);
        properties.getHarness().setBaseUrl("http://127.0.0.1:"
                + server.getAddress().getPort());
        properties.getHarness().setHeartbeatInterval(Duration.ZERO);
        AgentStateStore sessions = mock(AgentStateStore.class);
        when(sessions.requireSession(any(String.class), any(String.class)))
                .thenAnswer(invocation -> new SessionRecord(
                        invocation.getArgument(0),
                        invocation.getArgument(1), "qwen-code", null,
                        "ACTIVE", null, null, 0, 0, 1, 1, null, 1));
        // No client injection: every caller funnels through the cold
        // client() initialisation, which is the frame under test.
        QwenHostedHarnessConnector connector =
                new QwenHostedHarnessConnector(properties, sessions,
                        mock(WorkspaceExecutionStore.class));
        AtomicBoolean allOk = new AtomicBoolean(true);
        AtomicInteger probeProgress = new AtomicInteger();
        List<Thread> callers = new ArrayList<>();
        List<String> sessionIds = new ArrayList<>();
        List<String> unsettled = new ArrayList<>();
        int callerCount = carrierCount() + 2;
        try {
            for (int index = 0; index < callerCount; index++) {
                String sessionId = java.util.UUID.randomUUID().toString();
                sessionIds.add(sessionId);
                callers.add(Thread.ofVirtual().start(() -> {
                    try {
                        connector.createOrLoad("tenant-burst", sessionId,
                                false);
                    } catch (RuntimeException error) {
                        System.err.println("PINNING-MARKER caller "
                                + sessionId + " failed: " + error);
                        allOk.set(false);
                    }
                }));
            }
            // The first caller must be inside the blocking capabilities
            // round trip before the burst can pin anything.
            if (!capabilitiesRequested.await(30, TimeUnit.SECONDS)) {
                throw new IllegalStateException("the capabilities request"
                        + " never reached the stub");
            }
            // Wait until every caller is parked: a runnable caller would
            // occupy a carrier anyway, so a non-runnable burst is what
            // covers every carrier under a pinning client() frame.
            long parkedDeadline = System.nanoTime()
                    + TimeUnit.SECONDS.toNanos(20);
            while (System.nanoTime() < parkedDeadline) {
                boolean allParked = true;
                for (Thread caller : callers) {
                    if (caller.getState() == Thread.State.RUNNABLE) {
                        allParked = false;
                        break;
                    }
                }
                if (allParked) {
                    break;
                }
                Thread.sleep(10);
            }
            Thread probe = Thread.ofVirtual().start(() -> {
                for (int tick = 0; tick < 400; tick++) {
                    probeProgress.incrementAndGet();
                }
            });
            probe.join(30_000);
            assertTrue(!probe.isAlive() && probeProgress.get() >= 400,
                    "virtual-thread probe starved by " + callerCount
                            + " callers parked on the cold client()"
                            + " initialisation (progress="
                            + probeProgress.get()
                            + ") — a monitor pinned its carrier");
        } finally {
            open.countDown();
            long deadline = System.nanoTime()
                    + TimeUnit.SECONDS.toNanos(20);
            for (int index = 0; index < callers.size(); index++) {
                callers.get(index).join(Math.max(1L,
                        TimeUnit.NANOSECONDS.toMillis(
                                deadline - System.nanoTime())));
                if (callers.get(index).isAlive()) {
                    unsettled.add(sessionIds.get(index));
                }
            }
            server.stop(0);
            serverExecutor.shutdownNow();
            connector.close();
        }
        assertTrue(unsettled.isEmpty(),
                "callers never settled after the latch opened: "
                        + unsettled);
        assertTrue(allOk.get(), "callers failed after the latch opened");
        // The count is sound only while the fixture keeps the heartbeat
        // interval at zero: a live heartbeat scheduler would fire its own
        // timer-driven /capabilities hits that read as extra builds.
        assertTrue(capabilitiesHits.get() == 1,
                "cold burst built " + capabilitiesHits.get()
                        + " HostedHarnessClient instances for " + callerCount
                        + " callers");
    }

    private static int carrierCount() {
        return Integer.getInteger("jdk.virtualThreadScheduler.parallelism",
                Runtime.getRuntime().availableProcessors());
    }

    private static QwenHostedHarnessConnector connector(
            HostedHarnessClient client) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setToken("token");
        properties.getHarness().setCapabilityDigest("sha256:"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        AgentStateStore sessions = mock(AgentStateStore.class);
        when(sessions.requireSession(any(String.class), any(String.class)))
                .thenAnswer(invocation -> new SessionRecord(
                        invocation.getArgument(0),
                        invocation.getArgument(1), "qwen-code", null,
                        "ACTIVE", null, null, 0, 0, 1, 1, null, 1));
        QwenHostedHarnessConnector connector =
                new QwenHostedHarnessConnector(properties, sessions,
                        mock(WorkspaceExecutionStore.class));
        ReflectionTestUtils.setField(connector, "client", client);
        return connector;
    }
}
