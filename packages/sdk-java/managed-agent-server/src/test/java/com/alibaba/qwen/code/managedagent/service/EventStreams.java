package com.alibaba.qwen.code.managedagent.service;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.LongStream;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter.DataWithMediaType;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * The harness the event read-path tests share: a RecordingEmitter capturing
 * event ids, resync frames, failures and completion — able to stall the
 * stream thread on one sequence so a test can overflow the hub behind it —
 * plus the stream-service factory with poll and heartbeat pinned past the
 * test, so frames come only from the opening read or a live publish.
 */
final class EventStreams {
    private EventStreams() {
    }

    /**
     * An idle stream re-reads the store on a poll or heartbeat; pin both
     * past the test so the frames come only from the opening read.
     */
    static ManagedAgentProperties pinnedProperties() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getEvents().setPollInterval(Duration.ofSeconds(60));
        properties.getEvents().setHeartbeatInterval(Duration.ofSeconds(60));
        return properties;
    }

    static ManagedEventStreamService streams(ManagedAgentService service,
            SessionEventHub hub, ExecutorService executor,
            SseEmitter emitter) {
        return streams(service, hub, executor, pinnedProperties(), emitter);
    }

    static ManagedEventStreamService streams(ManagedAgentService service,
            SessionEventHub hub, ExecutorService executor,
            ManagedAgentProperties properties, SseEmitter emitter) {
        return new ManagedEventStreamService(service, hub, executor,
                properties) {
            @Override
            SseEmitter emitter() {
                return emitter;
            }
        };
    }

    static MockHttpServletRequestBuilder events(String tenant,
            String sessionId) {
        return get("/v1/agents/sessions/{id}/events", sessionId)
                .header(TenantContextFilter.HEADER, tenant)
                .accept(MediaType.APPLICATION_JSON);
    }

    static JsonNode json(ObjectMapper objectMapper,
            MockHttpServletResponse response) throws Exception {
        return objectMapper.readTree(
                response.getContentAsString(StandardCharsets.UTF_8));
    }

    static List<Long> range(long first, long last) {
        return LongStream.rangeClosed(first, last).boxed().toList();
    }

    /** Records the sequences and resync frames a stream delivers. */
    static final class RecordingEmitter extends SseEmitter {
        private static final Pattern ID = Pattern.compile("(?m)^id:(\\d+)$");
        final List<Long> ids = new CopyOnWriteArrayList<>();
        final List<Object> resync = new CopyOnWriteArrayList<>();
        final List<Throwable> failed = new CopyOnWriteArrayList<>();
        final CountDownLatch blocked = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);
        final CountDownLatch completed = new CountDownLatch(1);
        private final long blockOn;

        RecordingEmitter() {
            this(null, -1);
        }

        private RecordingEmitter(Long timeoutMillis, long blockOn) {
            super(timeoutMillis);
            this.blockOn = blockOn;
        }

        /** An emitter that stalls the stream thread on {@code blockOn}. */
        static RecordingEmitter blockingOn(long blockOn) {
            return new RecordingEmitter(null, blockOn);
        }

        static RecordingEmitter withTimeout(long timeoutMillis) {
            return new RecordingEmitter(timeoutMillis, -1);
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
            ids.add(id);
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
    }
}
