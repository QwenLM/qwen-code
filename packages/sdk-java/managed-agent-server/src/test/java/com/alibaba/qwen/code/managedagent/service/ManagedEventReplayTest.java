package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.alibaba.qwen.code.managedagent.api.ApiModels.SessionResyncRequired;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellResyncRequired;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayWindow;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.LongStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter.DataWithMediaType;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Replays committed events through JSON pages and both streams: resuming from
 * Last-Event-ID, switching from catch-up to live, falling back to the store
 * after the hub overflows, and expiring cursors below a floor that the test
 * advances. Every stream must deliver each sequence exactly once and in order.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-event-replay;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        // A stream reads the store only to catch up or after an overflow, so
        // live events must come through the hub. An idle stream also reads
        // the store after a heartbeat.
        "qwen.managed-agent.events.poll-interval=60s",
        "qwen.managed-agent.events.heartbeat-interval=60s",
        "qwen.managed-agent.events.materialize-interval=10ms"
})
// Streaming flows write the Mock response from a background thread while a
// printing handler would walk the same headers.
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
class ManagedEventReplayTest {
    private static final String TENANT = TenantContextFilter.HEADER;
    private static final Pattern ID = Pattern.compile("(?m)^id:(\\d+)$");
    // More events than SessionEventHub buffers for one Session.
    private static final int OVERFLOW = 600;
    private static final long RESUME_AFTER = 5;

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ManagedAgentStore store;

    @Autowired
    private ManagedAgentService agentService;

    @Autowired
    private SessionEventHub hub;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void jsonPagesFollowNextCursorWithoutGaps() throws Exception {
        String tenant = tenant();
        String sessionId = session(tenant);
        // 245 events fill exactly 35 pages of 7, so the last page is full.
        long last = append(tenant, sessionId, 244);
        assertThat(last).isEqualTo(245);

        List<Long> sequences = new ArrayList<>();
        String cursor = "0";
        JsonNode page;
        int pages = 0;
        do {
            page = json(mvc.perform(events(tenant, sessionId)
                            .param("after", cursor).param("limit", "7"))
                    .andReturn().getResponse());
            pages++;
            assertThat(page.get("data")).isNotEmpty();
            page.get("data").forEach(event ->
                    sequences.add(event.get("sequence").asLong()));
            cursor = page.get("next_cursor").asText();
        } while (page.get("has_more").asBoolean());

        assertThat(pages).isEqualTo(35);
        assertThat(sequences).containsExactlyElementsOf(range(1, last));
        assertThat(page.get("next_cursor").isNull()).isTrue();
        assertThat(mvc.perform(events(tenant, sessionId)
                        .param("limit", "1000"))
                .andReturn().getResponse().getStatus()).isEqualTo(200);
        MockHttpServletResponse tooMany = mvc.perform(events(tenant,
                sessionId).param("limit", "1001")).andReturn().getResponse();
        assertThat(tooMany.getStatus()).isEqualTo(400);
        assertThat(json(tooMany).at("/error/code").asText())
                .isEqualTo("invalid_limit");
    }

    @Test
    void lastEventIdResumesAcrossPagesAndThenGoesLive() throws Exception {
        String tenant = tenant();
        String sessionId = session(tenant);
        long caughtUp = append(tenant, sessionId, 250);
        MockHttpServletResponse stream = mvc.perform(events(tenant, sessionId)
                        .param("stream", "true").param("after", "5")
                        .header("Last-Event-ID", "120")
                        .accept(MediaType.TEXT_EVENT_STREAM))
                .andReturn().getResponse();
        // Append only after catch-up, so these events arrive live.
        await().atMost(Duration.ofSeconds(10))
                .until(() -> ids(stream).contains(caughtUp));
        append(tenant, sessionId, 3);
        long last = close(tenant, sessionId);

        await().atMost(Duration.ofSeconds(10))
                .until(() -> ids(stream).contains(last));
        assertThat(ids(stream)).containsExactlyElementsOf(range(121, last));
    }

    @Test
    void catchUpHandsOverToLiveEventsWithoutGapsOrDuplicates()
            throws Exception {
        String tenant = tenant();
        String sessionId = session(tenant);
        append(tenant, sessionId, 150);
        CompletableFuture<Long> writer = CompletableFuture.supplyAsync(
                () -> append(tenant, sessionId, 300));
        MockHttpServletResponse stream = mvc.perform(events(tenant, sessionId)
                        .param("stream", "true")
                        .accept(MediaType.TEXT_EVENT_STREAM))
                .andReturn().getResponse();
        writer.get(30, TimeUnit.SECONDS);
        long last = close(tenant, sessionId);

        await().atMost(Duration.ofSeconds(10))
                .until(() -> ids(stream).contains(last));
        assertThat(ids(stream)).containsExactlyElementsOf(range(1, last));
    }

    @ParameterizedTest(name = "web shell: {0}")
    @ValueSource(booleans = {false, true})
    void overflowFallsBackToTheStoreWithoutGapsOrDuplicates(boolean webShell)
            throws Exception {
        assertThat(SessionEventHub.CAPACITY).isLessThan(OVERFLOW);
        String tenant = tenant();
        String sessionId = session(tenant);
        long caughtUp = append(tenant, sessionId, 20);
        RecordingEmitter emitter = new RecordingEmitter(caughtUp + 1);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            open(streams(executor, emitter), webShell, tenant, sessionId);
            await().atMost(Duration.ofSeconds(5))
                    .until(() -> emitter.ids().contains(caughtUp));
            append(tenant, sessionId, 1);
            assertThat(emitter.blocked.await(5, TimeUnit.SECONDS)).isTrue();
            // The hub drops the oldest events while the client is stuck.
            append(tenant, sessionId, OVERFLOW);
            emitter.release.countDown();
            long last = close(tenant, sessionId);

            assertThat(emitter.completed.await(10, TimeUnit.SECONDS))
                    .isTrue();
            assertThat(emitter.ids())
                    .containsExactlyElementsOf(range(RESUME_AFTER + 1, last));
            assertThat(emitter.failed).isEmpty();
            // Catching up from the store needs no Snapshot reload.
            assertThat(emitter.resync).isEmpty();
        } finally {
            executor.shutdownNow();
        }
    }

    @ParameterizedTest(name = "web shell: {0}")
    @ValueSource(booleans = {false, true})
    void aFloorAdvancedPastALaggingStreamSendsOneResyncFrame(boolean webShell)
            throws Exception {
        String tenant = tenant();
        String sessionId = session(tenant);
        long caughtUp = append(tenant, sessionId, 20);
        RecordingEmitter emitter = new RecordingEmitter(caughtUp + 1);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            open(streams(executor, emitter), webShell, tenant, sessionId);
            await().atMost(Duration.ofSeconds(5))
                    .until(() -> emitter.ids().contains(caughtUp));
            long stuck = append(tenant, sessionId, 1);
            assertThat(emitter.blocked.await(5, TimeUnit.SECONDS)).isTrue();
            long last = append(tenant, sessionId, OVERFLOW);
            ReplayWindow window = advanceFloor(tenant, sessionId, last);
            emitter.release.countDown();

            assertThat(emitter.completed.await(10, TimeUnit.SECONDS))
                    .isTrue();
            assertThat(emitter.ids())
                    .containsExactlyElementsOf(range(RESUME_AFTER + 1, stuck));
            assertThat(emitter.resync).containsExactly(webShell
                    ? new WebShellResyncRequired(
                            ManagedEventStreamService.RESYNC, sessionId,
                            window.floorSequence(),
                            window.snapshotThroughSequence(),
                            ManagedEventStreamService.RESYNC_ACTION)
                    : new SessionResyncRequired(
                            ManagedEventStreamService.RESYNC, sessionId,
                            window.floorSequence(),
                            window.snapshotThroughSequence(),
                            ManagedEventStreamService.RESYNC_ACTION));
            assertThat(emitter.failed).isEmpty();
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void expiredCursorsGetConflictOrOneResyncFrame() throws Exception {
        String tenant = tenant();
        String sessionId = session(tenant);
        long last = append(tenant, sessionId, 30);
        ReplayWindow window = advanceFloor(tenant, sessionId, last + 100);
        long floor = window.floorSequence();
        assertThat(floor).isEqualTo(last)
                .isEqualTo(window.snapshotThroughSequence());
        assertThat(store.advanceReplayFloor(tenant, sessionId, 1))
                .isEqualTo(window);

        MockHttpServletResponse expired = mvc.perform(events(tenant,
                sessionId).param("after", Long.toString(floor - 1)))
                .andReturn().getResponse();
        assertThat(expired.getStatus()).isEqualTo(409);
        JsonNode error = json(expired).get("error");
        assertThat(error.get("code").asText()).isEqualTo("cursor_expired");
        assertThat(error.get("replay_floor_sequence").asLong())
                .isEqualTo(floor);
        assertThat(error.get("snapshot_through_sequence").asLong())
                .isEqualTo(floor);
        assertThat(error.get("request_id").asText())
                .isEqualTo(expired.getHeader("X-Request-Id"));
        assertThat(mvc.perform(events(tenant, sessionId)
                        .param("after", Long.toString(floor)))
                .andReturn().getResponse().getStatus()).isEqualTo(200);
        assertThat(json(mvc.perform(get("/v1/agents/sessions/{id}",
                        sessionId).header(TENANT, tenant))
                .andReturn().getResponse())
                .get("replay_floor_sequence").asLong()).isEqualTo(floor);

        MockHttpServletResponse publicStream = mvc.perform(events(tenant,
                        sessionId).param("stream", "true")
                        .accept(MediaType.TEXT_EVENT_STREAM))
                .andReturn().getResponse();
        MockHttpServletResponse webShellStream = mvc.perform(
                        post("/api/agent/web-shell/v1/events/stream")
                                .header(TENANT, tenant)
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("{\"sessionId\":\"%s\",\"afterSequence\":0}"
                                        .formatted(sessionId))
                                .accept(MediaType.TEXT_EVENT_STREAM))
                .andReturn().getResponse();
        await().atMost(Duration.ofSeconds(5)).until(() ->
                content(publicStream).contains("data:")
                        && content(webShellStream).contains("data:"));
        assertThat(resyncFrame(publicStream)).isEqualTo(
                objectMapper.readTree("""
                        {"type":"agent.session.resync_required",
                         "session_id":"%s","replay_floor_sequence":%d,
                         "snapshot_through_sequence":%d,
                         "action":"reload_snapshot"}
                        """.formatted(sessionId, floor, floor)));
        assertThat(resyncFrame(webShellStream)).isEqualTo(
                objectMapper.readTree("""
                        {"type":"agent.session.resync_required",
                         "sessionId":"%s","replayFloorSequence":%d,
                         "snapshotThroughSequence":%d,
                         "action":"reload_snapshot"}
                        """.formatted(sessionId, floor, floor)));
    }

    // The only frame of the stream, without an id.
    private JsonNode resyncFrame(MockHttpServletResponse stream)
            throws Exception {
        String prefix = "event:" + ManagedEventStreamService.RESYNC
                + "\ndata:";
        String frame = content(stream);
        assertThat(frame).startsWith(prefix).endsWith("\n\n");
        assertThat(frame.indexOf("\n\n")).as("frames in %s", frame)
                .isEqualTo(frame.length() - 2);
        return objectMapper.readTree(frame.substring(prefix.length()));
    }

    // Both transports have their own delivery loop; resume from a cursor.
    private static void open(ManagedEventStreamService streams,
            boolean webShell, String tenant, String sessionId) {
        if (webShell) {
            streams.webShellStream(tenant, null, sessionId, RESUME_AFTER);
        } else {
            streams.publicStream(tenant, null, sessionId, RESUME_AFTER);
        }
    }

    private ManagedEventStreamService streams(ExecutorService executor,
            SseEmitter emitter) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        // Only an overflow or the end of catch-up makes the stream read
        // the store again.
        properties.getEvents().setPollInterval(Duration.ofSeconds(60));
        properties.getEvents().setHeartbeatInterval(Duration.ofSeconds(60));
        return new ManagedEventStreamService(agentService, hub, executor,
                properties) {
            @Override
            SseEmitter emitter() {
                return emitter;
            }
        };
    }

    private ReplayWindow advanceFloor(String tenant, String sessionId,
            long floor) {
        long last = store.requireSession(tenant, sessionId).lastSequence();
        await().atMost(Duration.ofSeconds(10)).until(() ->
                store.findReplayWindow(tenant, sessionId)
                        .snapshotThroughSequence() == last);
        return store.advanceReplayFloor(tenant, sessionId, floor);
    }

    private String session(String tenant) {
        return store.insertSessionCommand(tenant, "CREATE_SESSION",
                "replay-" + UUID.randomUUID(), "digest", "qwen-code", null,
                null, List.of(), "payload").sessionId();
    }

    private long append(String tenant, String sessionId, int count) {
        for (int index = 0; index < count; index++) {
            store.appendPublicEventIfAbsent(tenant, sessionId, "turn_replay",
                    "test.progress", Map.of("index", index), false,
                    "replay:" + UUID.randomUUID());
        }
        return store.requireSession(tenant, sessionId).lastSequence();
    }

    // A stream ends after the deletion event.
    private long close(String tenant, String sessionId) {
        store.appendPublicEventIfAbsent(tenant, sessionId, null,
                "session.deleted", Map.of(), true, "replay:end");
        return store.requireSession(tenant, sessionId).lastSequence();
    }

    private MockHttpServletRequestBuilder events(String tenant,
            String sessionId) {
        return get("/v1/agents/sessions/{id}/events", sessionId)
                .header(TENANT, tenant).accept(MediaType.APPLICATION_JSON);
    }

    private JsonNode json(MockHttpServletResponse response) throws Exception {
        return objectMapper.readTree(content(response));
    }

    private static String content(MockHttpServletResponse response)
            throws Exception {
        return response.getContentAsString(StandardCharsets.UTF_8);
    }

    private static List<Long> ids(MockHttpServletResponse response)
            throws Exception {
        List<Long> ids = new ArrayList<>();
        Matcher matcher = ID.matcher(content(response));
        while (matcher.find()) {
            ids.add(Long.parseLong(matcher.group(1)));
        }
        return ids;
    }

    private static List<Long> range(long first, long last) {
        return LongStream.rangeClosed(first, last).boxed().toList();
    }

    private static String tenant() {
        return "tenant-replay-" + UUID.randomUUID();
    }

    /** Records frames and blocks the stream thread on one sequence. */
    private static final class RecordingEmitter extends SseEmitter {
        private final long blockOn;
        private final List<Long> sent = new CopyOnWriteArrayList<>();
        private final List<Object> resync = new CopyOnWriteArrayList<>();
        private final List<Throwable> failed = new CopyOnWriteArrayList<>();
        private final CountDownLatch blocked = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);
        private final CountDownLatch completed = new CountDownLatch(1);

        RecordingEmitter(long blockOn) {
            this.blockOn = blockOn;
        }

        @Override
        public void send(SseEventBuilder builder) {
            StringBuilder text = new StringBuilder();
            Object data = null;
            for (DataWithMediaType part : builder.build()) {
                if (part.getData() instanceof String value) {
                    text.append(value);
                } else {
                    data = part.getData();
                }
            }
            Matcher matcher = ID.matcher(text);
            if (!matcher.find()) {
                if (text.toString().contains(
                        "event:" + ManagedEventStreamService.RESYNC)) {
                    resync.add(data);
                }
                return;
            }
            long id = Long.parseLong(matcher.group(1));
            sent.add(id);
            if (id == blockOn) {
                blocked.countDown();
                try {
                    release.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                }
            }
        }

        @Override
        public void complete() {
            completed.countDown();
        }

        @Override
        public void completeWithError(Throwable error) {
            failed.add(error);
            completed.countDown();
        }

        List<Long> ids() {
            return List.copyOf(sent);
        }
    }
}
