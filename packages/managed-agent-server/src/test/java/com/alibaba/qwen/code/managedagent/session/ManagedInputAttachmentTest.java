package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedInputAttachmentTest {
    private ManagedAgentService service;
    private ManagedAgentStore store;
    private static final String PNG = Base64.getEncoder().encodeToString(new byte[] {(byte) 137, 80, 78, 71, 13, 10, 26, 10});

    @BeforeEach
    void setup() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:input-attachments-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        var registry = mock(ManagedWorkspaceRegistry.class);
        store = new ManagedAgentStore(new ManagedSchemaJdbcTemplate(source), new ObjectMapper(),
                Clock.systemUTC(), events -> {}, registry, new ManagedAgentProperties());
        var harness = mock(HarnessConnector.class);
        when(harness.isAvailable()).thenReturn(true);
        service = new ManagedAgentService(store, new RequestDigests(), mock(HarnessCoordinator.class), harness, registry);
    }

    @Test
    void persistsTheCompleteInputAndProjectsTheSameAttachmentsAfterARead() {
        var blocks = List.of(new InputBlock("input_text", "Review"),
                new InputBlock("input_file", "你好\ncontents", "text/markdown", null, "notes 1.md"),
                new InputBlock("input_image", null, "image/png", PNG, null));
        var admission = service.createSession("tenant", "create", "qwen-code", null, null, null, blocks);
        var input = store.findTurn("tenant", admission.sessionId(), admission.turnId()).orElseThrow().input();
        assertThat(input).containsExactly(Map.of("type", "text", "text", "Review"),
                Map.of("type", "resource", "resource", Map.of("uri", "managed-input:///notes%201.md",
                        "mimeType", "text/markdown", "text", "你好\ncontents")),
                Map.of("type", "image", "data", PNG, "mimeType", "image/png"));
        var replay = service.createSession("tenant", "create", "qwen-code", null, null, null, blocks);
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.turnId()).isEqualTo(admission.turnId());
        store.materializeNextBatch("tenant", admission.sessionId(), 100);
        var items = service.listPublicItems("tenant", null, admission.sessionId(), 0, 100).data();
        assertThat(items).singleElement().satisfies(item -> {
            assertThat(item.attributes().get("inputAttachments")).isEqualTo(input);
            assertThat(item.content()).singleElement().satisfies(part -> assertThat(part.text()).isEqualTo("Review"));
        });
        assertThatThrownBy(() -> service.createSession("tenant", "create", "qwen-code", null, null, null,
                List.of(new InputBlock("input_file", "different contents", "text/markdown", null, "notes 1.md"))))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
    }

    @Test
    void admitsAScreenshotSizedImageAndPreservesItsBytesOnReplayAndProjection() {
        byte[] bytes = new byte[5 * 1024 * 1024];
        System.arraycopy(Base64.getDecoder().decode(PNG), 0, bytes, 0, 8);
        String data = Base64.getEncoder().encodeToString(bytes);
        var blocks = List.of(new InputBlock("input_text", "Review screenshot"),
                new InputBlock("input_image", null, "image/png", data, null));
        var admission = service.createSession("tenant", "large-image", "qwen-code", null, null, null, blocks);
        var replay = service.createSession("tenant", "large-image", "qwen-code", null, null, null, blocks);
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.turnId()).isEqualTo(admission.turnId());
        assertThat(store.findTurn("tenant", admission.sessionId(), admission.turnId()).orElseThrow().input().get(1))
                .isEqualTo(Map.of("type", "image", "data", data, "mimeType", "image/png"));
        store.materializeNextBatch("tenant", admission.sessionId(), 100);
        assertThat(service.listPublicItems("tenant", null, admission.sessionId(), 0, 100).data())
                .singleElement().satisfies(item -> assertThat(item.attributes().get("inputAttachments"))
                        .isEqualTo(store.findTurn("tenant", admission.sessionId(), admission.turnId()).orElseThrow().input()));
    }

    @ParameterizedTest
    @MethodSource("additionalImageFormats")
    void preservesAdditionalImageFormatsThroughAdmissionReplayAndProjection(String mime, String data) {
        String canonicalMime = mime.equals("image/jpg") ? "image/jpeg" : mime;
        var blocks = List.of(new InputBlock("input_image", null, mime, data, null));
        var admission = service.createSession("tenant", "image-format", "qwen-code", null, null, null, blocks);
        var expected = List.of(Map.of("type", "image", "data", data, "mimeType", canonicalMime));
        assertThat(store.findTurn("tenant", admission.sessionId(), admission.turnId()).orElseThrow().input())
                .isEqualTo(expected);
        var replay = service.createSession("tenant", "image-format", "qwen-code", null, null, null,
                List.of(new InputBlock("input_image", null, canonicalMime, data, null)));
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.turnId()).isEqualTo(admission.turnId());
        store.materializeNextBatch("tenant", admission.sessionId(), 100);
        assertThat(service.listPublicItems("tenant", null, admission.sessionId(), 0, 100).data())
                .singleElement().satisfies(item -> assertThat(item.attributes().get("inputAttachments"))
                        .isEqualTo(expected));
    }

    static Stream<Arguments> additionalImageFormats() {
        return Stream.of(
                Arguments.of("image/jpg", Base64.getEncoder().encodeToString(new byte[] {(byte) 255, (byte) 216, (byte) 255})),
                Arguments.of("image/gif", "R0lGODdhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs="),
                Arguments.of("image/gif", "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"));
    }

    @Test
    void acceptsFileOnlyInputAndEnforcesTheWholeEncodedBudget() {
        var admitted = service.createSession("tenant", "file-only", "qwen-code", null, null, null,
                List.of(new InputBlock("input_file", "const x = 1;", "application/octet-stream", null, "script.ts")));
        assertThat(admitted.turnId()).isNotNull();
        assertThatThrownBy(() -> service.createSession("tenant", "too-large", "qwen-code", null, null, null,
                List.of(new InputBlock("input_file", "界".repeat(ManagedInputAttachments.MAX_INPUT_BYTES / 3),
                        "text/plain", null, "a.txt"))))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("input_too_large"));
    }

    @ParameterizedTest
    @MethodSource("invalidBlocks")
    void refusesUnsupportedShapesBeforeAnyAdmission(InputBlock block) {
        assertThatThrownBy(() -> service.createSession("tenant", UUID.randomUUID().toString(), "qwen-code",
                null, null, null, List.of(block))).isInstanceOf(ManagedAgentException.class);
    }

    static Stream<InputBlock> invalidBlocks() {
        return Stream.of(new InputBlock("input_text", "hello", "text/plain", null, null),
                new InputBlock("input_file", "%PDF", "application/pdf", null, "a.pdf"),
                new InputBlock("input_file", "x", "text/plain", null, "../secret.txt"),
                new InputBlock("input_file", "x", "text/plain", null, "a\nb.txt"),
                new InputBlock("input_file", "x", "text/plain", null, "a\nb\nc.txt"),
                new InputBlock("input_file", "x", "text/plain", null, "a\r\nb.txt"),
                new InputBlock("input_file", "x", "text/plain", null, "\n../secret.txt\n"),
                new InputBlock("input_file", "x\0y", "text/plain", null, "a.txt"),
                new InputBlock("input_file", "", "text/plain", null, "a.txt"),
                new InputBlock("input_file", "x", "text/plain", "extra", "a.txt"),
                new InputBlock("input_image", null, "image/png", PNG + "\n", null),
                new InputBlock("input_image", null, "image/jpeg", PNG, null),
                new InputBlock("input_image", null, "image/jpg", PNG, null),
                new InputBlock("input_image", null, "image/gif", PNG, null),
                new InputBlock("input_image", null, "image/gif",
                        Base64.getEncoder().encodeToString("GIF88a".getBytes(StandardCharsets.US_ASCII)), null),
                new InputBlock("input_image", null, "image/gif",
                        Base64.getEncoder().encodeToString("GIF89".getBytes(StandardCharsets.US_ASCII)), null),
                new InputBlock("input_image", null, "image/gif", "R0lGODlh\n", null),
                new InputBlock("input_image", null, "image/bmp", PNG, null),
                new InputBlock("input_image", null, "image/heic", PNG, null),
                new InputBlock("input_image", "extra", "image/png", PNG, null),
                new InputBlock("input_image", null, "image/svg+xml", PNG, null));
    }

    @Test
    void rejectsUnknownJsonFieldsRatherThanDroppingThem() {
        assertThatThrownBy(() -> new ObjectMapper().readValue(
                "{\"type\":\"input_text\",\"text\":\"hello\",\"url\":\"file:///secret\"}", InputBlock.class))
                .hasMessageContaining("Unknown input field");
        assertThatThrownBy(() -> new ObjectMapper().readValue(
                "{\"type\":\"input_file\",\"text\":123,\"name\":\"a.txt\",\"mime_type\":\"text/plain\"}", InputBlock.class))
                .hasMessageContaining("must be strings");
        assertThatThrownBy(() -> new ObjectMapper().readValue(
                "{\"type\":\"input_text\",\"text\":\"hello\",\"name\":null}", InputBlock.class))
                .hasMessageContaining("invalid input shape");
    }
}
