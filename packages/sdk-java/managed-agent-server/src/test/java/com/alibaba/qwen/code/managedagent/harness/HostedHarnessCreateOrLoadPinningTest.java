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
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
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
            for (int index = 0; index < callers.size(); index++) {
                callers.get(index).join(30_000);
                if (callers.get(index).isAlive()) {
                    unsettled.add(sessionIds.get(index));
                }
            }
        }
        assertTrue(unsettled.isEmpty(),
                "callers never settled after the latch opened: " + unsettled);
        assertTrue(allOk.get(), "callers failed after the latch opened");
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
