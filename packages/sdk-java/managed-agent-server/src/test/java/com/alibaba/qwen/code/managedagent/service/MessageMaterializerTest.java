package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/**
 * Pins the scanner half of issue #13182 finding 1: a session whose batch
 * keeps throwing must not be retried at the 10Hz scan rate forever. The
 * materializer backs off per session, surfaces the stuck projection once at
 * ERROR past the budget, and a later success resets the backoff.
 */
class MessageMaterializerTest {
    private static final MaterializationTarget TARGET =
            new MaterializationTarget("tenant", "session");
    private final AtomicLong now = new AtomicLong(1_000);

    private final Clock clock = new Clock() {
        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return Instant.ofEpochMilli(now.get());
        }
    };

    @Test
    void aDeterministicallyFailingSessionBacksOffAndSurfacesOnce() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.findMaterializationTargets(32)).thenReturn(List.of(TARGET));
        doThrow(new IllegalStateException("Stored event is invalid"))
                .when(store).materializeNextBatch(eq("tenant"), eq("session"),
                        anyInt());
        Logger materializerLog = (Logger) LoggerFactory.getLogger(
                MessageMaterializer.class);
        ListAppender<ILoggingEvent> logged = new ListAppender<>();
        logged.start();
        materializerLog.addAppender(logged);
        try {
            MessageMaterializer materializer =
                    new MessageMaterializer(store, clock);
            // Ten failures spend the budget; the scans between them are
            // skipped by the backoff, so the store sees far fewer calls than
            // the 10Hz scan rate would produce.
            for (int failure = 0; failure < 10; failure++) {
                materializer.materialize();
                materializer.materialize();
                materializer.materialize();
                now.addAndGet(60_000);
            }
            verify(store, times(10)).materializeNextBatch(eq("tenant"),
                    eq("session"), anyInt());
            // The stuck projection is surfaced loudly exactly once; every
            // other failure stays a warning.
            assertThat(logged.list)
                    .filteredOn(event -> event.getLevel() == Level.ERROR)
                    .singleElement()
                    .satisfies(event -> assertThat(event.getFormattedMessage())
                            .contains("projection is stuck")
                            .contains("session"));
            assertThat(logged.list)
                    .filteredOn(event -> event.getLevel() == Level.WARN)
                    .hasSize(9);
        } finally {
            materializerLog.detachAppender(logged);
        }
    }

    // A session that leaves the target list (caught up or deleted) never
    // fails again: its entry is swept, so if it reappears its backoff starts
    // from the smallest step instead of a stale count.
    @Test
    void aSessionThatLeavesTheTargetListLosesItsBackoff() {
        AgentStateStore store = mock(AgentStateStore.class);
        java.util.concurrent.atomic.AtomicBoolean listed =
                new java.util.concurrent.atomic.AtomicBoolean(true);
        when(store.findMaterializationTargets(32)).thenAnswer(
                invocation -> listed.get() ? List.of(TARGET) : List.of());
        doThrow(new IllegalStateException("Stored event is invalid"))
                .when(store).materializeNextBatch(eq("tenant"),
                        eq("session"), anyInt());
        MessageMaterializer materializer =
                new MessageMaterializer(store, clock);

        // Two failures build a 400ms backoff.
        materializer.materialize();
        now.addAndGet(100);
        materializer.materialize();
        verify(store, times(2)).materializeNextBatch(eq("tenant"),
                eq("session"), anyInt());

        // The session leaves the target list; its failure entry is swept.
        listed.set(false);
        materializer.materialize();

        // Back and failing again: the backoff is the fresh 100ms, so a scan
        // 150ms later reaches the store — a stale count would still be
        // backing off.
        listed.set(true);
        materializer.materialize();
        now.addAndGet(150);
        materializer.materialize();
        verify(store, times(4)).materializeNextBatch(eq("tenant"),
                eq("session"), anyInt());
    }

    @Test
    void aSuccessfulBatchResetsTheBackoff() {
        AgentStateStore store = mock(AgentStateStore.class);
        when(store.findMaterializationTargets(32)).thenReturn(List.of(TARGET));
        MessageMaterializer materializer =
                new MessageMaterializer(store, clock);

        doThrow(new IllegalStateException("Stored event is invalid"))
                .when(store).materializeNextBatch(eq("tenant"), eq("session"),
                        anyInt());
        materializer.materialize();
        materializer.materialize();
        verify(store, times(1)).materializeNextBatch(eq("tenant"),
                eq("session"), anyInt());

        // The failure backs the session off briefly; a success clears it, so
        // the very next scan reaches the store again.
        now.addAndGet(100);
        org.mockito.Mockito.doReturn(
                new com.alibaba.qwen.code.managedagent.store.StoreModels
                        .MaterializationResult(true, 1))
                .when(store).materializeNextBatch(eq("tenant"),
                        eq("session"), anyInt());
        materializer.materialize();
        verify(store, times(2)).materializeNextBatch(eq("tenant"),
                eq("session"), anyInt());

        // And a later failure starts from the smallest backoff again.
        doThrow(new IllegalStateException("Stored event is invalid"))
                .when(store).materializeNextBatch(eq("tenant"), eq("session"),
                        anyInt());
        materializer.materialize();
        materializer.materialize();
        verify(store, times(3)).materializeNextBatch(eq("tenant"),
                eq("session"), anyInt());
    }
}
