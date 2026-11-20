package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.managedagent.PublicationJournalFixture;
import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules;
import com.alibaba.qwen.code.managedagent.persistence.ExternalStorageRegistrationStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedToolResultStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.ExternalShellWorkerFixture;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

import javax.sql.DataSource;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The external foreground-Shell producer end to end (#15512 slice C): a real
 * worker process, the real attesting transport, and the real control-plane
 * publication stores.
 *
 * <p>This is the one leg where nothing on the producer's path is stubbed. The
 * protocol suite drives the transport directly and the dispatch suite stubs
 * the producer, so neither shows that the bytes a worker holds actually land
 * in the control plane as a finished, readable publication. Here the whole
 * reservation chain is committed through the production stores — the writer
 * lease, the activation and tool.intent evidence, the admitted execution —
 * the verification pool runs on its own threads exactly as it does in the
 * server, and the drained stop is only reached once every sequence, each
 * stream's empty EOF included, has been acknowledged.
 *
 * <p>The assertions are deliberately about what a reader gets back: the
 * finished envelope's manifest is the control plane's own rebuilt one, the
 * stream bytes read back through the store equal what the worker captured,
 * and the store's own {@code validateFinished} — not this test — is what
 * proves the rebuild faithful.
 */
class ExternalShellProducerPublicationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final long CAPTURE_BYTES = 256 * 1024;

    @Test
    @Timeout(180)
    void aWorkerCaptureBecomesAFinishedPublicationTheControlPlaneCanReadBack() throws Exception {
        try (var lane = Lane.open("hello\nworld\n", "")) {
            var channel = lane.begin();
            lane.drain(channel);

            // The worker's own manifest ref is local to its capture store; the
            // settled envelope must carry the control plane's rebuilt one,
            // which is what the Harness compares against `/finished` verbatim.
            JsonNode finished = lane.finished();
            JsonNode manifestRef = finished.path("result").path("capture").path("manifest");
            assertEquals("managed-tool-result-manifest", manifestRef.path("kind").asText());
            assertEquals("pending",
                    finished.path("result").path("capture").path("deliveryStatus").asText(),
                    "The producer finishes pending; only the Harness commits delivery");

            JsonNode manifest = lane.resource(manifestRef);
            assertEquals("manifest", manifest.path("type").asText());
            assertEquals("complete", manifest.path("captureStatus").asText());
            assertEquals("success", manifest.path("executionStatus").asText());
            assertEquals(0, manifest.path("exitCode").asInt());
            assertTrue(manifest.path("signal").isNull(), "An ordinary exit has no signal");
            assertEquals("capture-1", manifest.path("captureId").asText());
            assertEquals("sha256:" + PublicationJournalFixture.digest(Lane.ARGUMENTS),
                    manifest.path("invocationDigest").asText());

            // Both streams are sealed, and the bytes come back through the
            // store's own paged reader — the same path the Harness uses.
            assertEquals(List.of("stdout", "stderr"), lane.streams(manifest));
            assertEquals("hello\nworld\n", lane.read(manifest, manifestRef, "stdout"));
            assertEquals("", lane.read(manifest, manifestRef, "stderr"));
            assertEquals("hello\nworld\n".getBytes(StandardCharsets.UTF_8).length,
                    lane.content(manifest, "stdout").path("byteLength").asInt());

            // Every sequence was acknowledged, the empty EOFs included, so the
            // worker's guarded stop can finally answer with a drained proof.
            assertEquals("drained", lane.stopDrained());
        }
    }

    @Test
    @Timeout(180)
    void aCaptureLargerThanOneReadBlockIsPublishedSegmentBySegmentWithoutLosingBytes()
            throws Exception {
        // One 32 KiB block plus a short tail, so the last data segment is short
        // and the EOF still follows it. The producer publishes one segment per
        // block and seals over exactly those, which is where an off-by-one
        // would silently shorten a real capture.
        var payload = "x".repeat(32 * 1024) + "y".repeat(11) + "\n";
        try (var lane = Lane.open(payload, "warn\n")) {
            lane.drain(lane.begin());

            JsonNode finished = lane.finished();
            JsonNode manifestRef = finished.path("result").path("capture").path("manifest");
            JsonNode manifest = lane.resource(manifestRef);
            assertEquals(payload, lane.read(manifest, manifestRef, "stdout"));
            assertEquals("warn\n", lane.read(manifest, manifestRef, "stderr"));

            // The page's segment digests are the published blocks' own, and
            // their count is the number of blocks, not the byte length.
            JsonNode page = lane.resource(lane.content(manifest, "stdout")
                    .path("body").path("pages").get(0).path("ref"));
            assertEquals(2, page.path("segments").size());
            assertEquals(0, page.path("firstOrdinal").asInt());
            assertEquals(0, page.path("offset").asLong());
            assertEquals(ToolPublicationContract.sha256(
                            payload.substring(0, 32 * 1024).getBytes(StandardCharsets.UTF_8)),
                    page.path("segments").get(0).path("digest").asText());
            assertEquals(payload.getBytes(StandardCharsets.UTF_8).length,
                    lane.content(manifest, "stdout").path("byteLength").asInt());
            assertEquals("drained", lane.stopDrained());
        }
    }

    @Test
    @Timeout(180)
    void aRenewedGrantExtendsTheWorkerChannelWithoutReopeningIt() throws Exception {
        try (var lane = Lane.open("witness\n", "")) {
            var channel = lane.begin();
            // A foreground Shell may outlive one writer lease. The dispatch
            // renewal pushes the grant's new horizon onto the same channel.
            long extended = System.currentTimeMillis() + 900_000;
            lane.producer.renew(lane.lease, lane.binding, lane.grant(extended), channel)
                    .toCompletableFuture().join();

            assertEquals(channel, lane.begin(), "A renewed lane keeps its channel");
            assertEquals(extended, lane.worker.routes("renew").get(0).get("expiresAt").asLong());
            lane.drain(channel);
            JsonNode manifestRef = lane.finished().path("result").path("capture").path("manifest");
            assertEquals("witness\n", lane.read(lane.resource(manifestRef), manifestRef, "stdout"));
            assertEquals("drained", lane.stopDrained());
        }
    }

    @Test
    @Timeout(180)
    void aFailedExitCodeIsPublishedAsTheResultsOwnOutcome() throws Exception {
        try (var lane = Lane.open("", "boom\n", "--exit-code=3")) {
            lane.drain(lane.begin(), lane.envelope("error"));

            JsonNode finished = lane.finished();
            JsonNode manifestRef = finished.path("result").path("capture").path("manifest");
            JsonNode manifest = lane.resource(manifestRef);
            // A non-zero exit is a successful capture of a failed command; the
            // manifest must report the code rather than a complete success.
            assertEquals("error", manifest.path("executionStatus").asText());
            assertEquals(3, manifest.path("exitCode").asInt());
            assertEquals("error", finished.path("result").path("executionStatus").asText());
            assertEquals("complete", manifest.path("captureStatus").asText());
            assertEquals("boom\n", lane.read(manifest, manifestRef, "stderr"));
            // The command wrote nothing to stdout: its stream is sealed
            // empty, and the stand-in's 'witness' fallback must not appear
            // in its place — an empty captured stream reads back empty.
            assertEquals("", lane.read(manifest, manifestRef, "stdout"));
            assertEquals("drained", lane.stopDrained());
        }
    }

    @Test
    @Timeout(180)
    void anIncompleteCaptureIsRefusedBeforeAnythingIsFinished() throws Exception {
        try (var lane = Lane.open("witness\n", "")) {
            var channel = lane.begin();
            var partial = Map.<String, Object>of(
                    "executionStatus", "success", "responseParts", List.of(),
                    "capture", Map.of("captureStatus", "partial", "captureReason", "size_limit",
                            "previewTruncated", true, "deliveryStatus", "pending",
                            "manifest", Map.of("resourceId", "worker-local",
                                    "kind", "managed-tool-result-manifest", "schemaVersion", 1,
                                    "byteLength", 1, "digest", "a".repeat(64))));

            // `finish` admits only a complete capture, so no retry could
            // publish these bytes. Refusing before the move is what keeps the
            // channel unacknowledged and the close refusing.
            var refused = assertThrows(CompletionException.class,
                    () -> lane.producer.drain(lane.lease, lane.binding, lane.execution,
                            lane.grant(), channel, partial).toCompletableFuture().join());
            assertEquals("external_shell_publication_conflict", code(refused));
            assertNull(lane.finishedOrNull(), "A refused drain must not finish the publication");
            // The envelope alone decides the refusal, so it lands before any
            // block is moved: no read reaches the worker and no segment row is
            // written for a capture that can never finish.
            assertTrue(lane.worker.routes("read").isEmpty(),
                    "A refused drain must not move any block off the worker");
            assertEquals("undrained", lane.stopDrained());
        }
    }

    @Test
    @Timeout(180)
    void aCaptureBeyondItsReservedBytesRefusesInsteadOfPublishingAShortStream() throws Exception {
        // The reservation is what bounds the capture: the store refuses the
        // first segment beyond it. A drain that swallowed that refusal would
        // finish a truncated stream as if it were complete.
        try (var lane = Lane.open("z".repeat(4096), "", 1024)) {
            var channel = lane.begin();
            var refused = assertThrows(CompletionException.class, () -> lane.drain(channel));
            assertEquals("managed_tool_publication_quota_exhausted", code(refused));
            assertNull(lane.finishedOrNull());
            assertEquals("undrained", lane.stopDrained(),
                    "The bytes never arrived, so the close must keep refusing");
        }
    }

    @Test
    @Timeout(180)
    void aDrainWhoseWorkerVanishedLeavesThePublicationUnfinished() throws Exception {
        var lane = Lane.open("witness\n", "");
        var channel = lane.begin();
        lane.worker.close();
        try {
            // The worker died holding the capture. Nothing may be finished
            // from an exchange that never answered, or the close would release
            // storage whose bytes never arrived.
            assertThrows(CompletionException.class, () -> lane.drain(channel));
            assertNull(lane.finishedOrNull());
        } finally {
            lane.close();
        }
    }

    @Test
    @Timeout(180)
    void aForeignLeaseNeverOpensAChannelOnTheSavedWorkersCapture() throws Exception {
        try (var lane = Lane.open("secret output\n", "")) {
            var foreign = new RuntimeLease(lane.lease.getRuntimeInstanceId(),
                    lane.lease.getEndpoint(), "another-token-1234567890",
                    lane.lease.getLeaseId(), lane.lease.getEpoch());
            // The seed binds the lease, so a foreign credential is refused
            // locally, before any request reaches the worker's capture. The
            // producer answers that on the stage, as its contract requires:
            // a refused begin leaves the call unknown, never half-opened.
            var refused = lane.producer.begin(foreign, lane.binding, lane.execution, lane.grant())
                    .toCompletableFuture();
            assertTrue(assertThrows(CompletionException.class, refused::join).getCause()
                    instanceof IllegalArgumentException);
            assertTrue(lane.worker.routes("begin").isEmpty());
            // No channel was ever opened, so the worker owes no bytes and its
            // stop answers drained — the same answer the shipped worker gives
            // for an empty channel set. What must never happen is a channel
            // opened under a credential the saved seed does not bind.
            assertEquals("drained", lane.stopDrained());
            assertNull(lane.finishedOrNull());
        }
    }

    @Test
    @Timeout(180)
    void anExpiredGrantRefusesTheChannelRatherThanOpeningOneThatAlreadyClosed() throws Exception {
        try (var lane = Lane.open("witness\n", "")) {
            var expired = new RuntimePublicationGrant("pub-1",
                    PublicationJournalFixture.PUBLICATION_TOKEN, "http://127.0.0.1:1",
                    lane.grant().binding(), System.currentTimeMillis() - 1_000);
            // The worker refuses a channel whose lifetime has passed, so the
            // grant's own horizon is the only honest expiry to offer it.
            var refused = lane.producer.begin(lane.lease, lane.binding, lane.execution, expired)
                    .toCompletableFuture();
            assertEquals("external_shell_publication_unavailable",
                    code(assertThrows(CompletionException.class, refused::join)));
            assertTrue(lane.worker.routes("begin").isEmpty());
        }
    }

    private static String code(Throwable failure) {
        var cause = failure instanceof CompletionException wrapped && wrapped.getCause() != null
                ? wrapped.getCause() : failure;
        if (cause instanceof RuntimeBrokerException broker) {
            return broker.getCode();
        }
        if (cause instanceof com.alibaba.qwen.code.managedagent.exception.ManagedAgentException managed) {
            return managed.getCode();
        }
        throw new AssertionError("Unexpected failure: " + cause, cause);
    }

    /**
     * One admitted external Shell lane over the production stores and a real
     * worker process. The reservation is committed before the worker starts,
     * because the reservation reads the original execution back and refuses a
     * dispatched one; the worker's origin is then written into the attested
     * binding, so the lease the producer reads is the one that process answers
     * for.
     */
    private static final class Lane implements AutoCloseable {
        private static final String ARGUMENTS = "{\"command\":\"printf hi\"}";

        private final DataSource source;
        private final ManagedSchemaJdbcTemplate jdbc;
        private final PublicationJournalFixture journal;
        private final ToolPublicationDataStore publications;
        private final ToolPublicationVerifier verifier;
        private final ExternalStorageRegistrationStore registrations;
        private final ExternalShellWorkerFixture worker;
        private final ExternalShellPublicationProducer producer;
        private final RuntimeBindingRecord binding;
        private final ToolExecutionRecord execution;
        private final RuntimeLease lease;
        private final JsonNode key;

        private Lane(DataSource source, ManagedSchemaJdbcTemplate jdbc,
                PublicationJournalFixture journal, ToolPublicationDataStore publications,
                ToolPublicationVerifier verifier, ExternalStorageRegistrationStore registrations,
                ExternalShellWorkerFixture worker, ExternalShellPublicationProducer producer,
                RuntimeBindingRecord binding, ToolExecutionRecord execution) {
            this.source = source;
            this.jdbc = jdbc;
            this.journal = journal;
            this.publications = publications;
            this.verifier = verifier;
            this.registrations = registrations;
            this.worker = worker;
            this.producer = producer;
            this.binding = binding;
            this.execution = execution;
            this.lease = binding.getLease();
            this.key = journal.binding.get("sessionKey");
        }

        private static Lane open(String stdout, String stderr, String... extra) throws IOException {
            return open(stdout, stderr, CAPTURE_BYTES, extra);
        }

        private static Lane open(String stdout, String stderr, long captureBytes, String... extra)
                throws IOException {
            var source = new org.h2.jdbcx.JdbcDataSource();
            source.setURL("jdbc:h2:mem:external-shell-producer-" + UUID.randomUUID()
                    + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE;LOCK_TIMEOUT=10000");
            ManagedSchema.initialize(source);
            var jdbc = new ManagedSchemaJdbcTemplate(source);
            var manager = new DataSourceTransactionManager(source);
            // The worker's origin has to exist before the binding is attested,
            // and the reservation has to be committed before the worker's
            // channel opens, so the process starts on a placeholder origin
            // first and the attested lease is rewritten to its real one below.
            var journal = PublicationJournalFixture.createExternalShell(source,
                    objects(), results(jdbc, manager), java.net.URI.create("http://127.0.0.1:1"));
            var worker = ExternalShellWorkerFixture.start(journal.externalBinding,
                    PublicationJournalFixture.REGISTRATION_REVISION, stdout, stderr, extra);
            RuntimeBindingRecord binding = null;
            ToolPublicationVerifier verifier = null;
            ExternalShellPublicationProducer producer = null;
            try {
                binding = rebind(journal, worker);
                var properties = new ManagedAgentProperties();
                properties.getArtifacts().setEnabled(true);
                var sessions = VerificationFixtures.managedAgentStore(jdbc, JSON, Clock.systemUTC(),
                        events -> {}, org.mockito.Mockito.mock(JdbcManagedWorkspaceRegistry.class),
                        properties, new SdkHarnessRules());
                // The capacity's first bound is the execution's own capture
                // reservation; the tenant and session budgets cover the
                // allocation that reservation implies.
                long allocation = captureBytes + ToolPublicationContract.PRODUCER_BYTES
                        + ToolPublicationContract.ADMISSION_BYTES;
                var store = new com.alibaba.qwen.code.managedagent.persistence.ToolPublicationStore(
                        jdbc, manager, journal.sessions, journal.executions, journal.bindings,
                        new com.alibaba.qwen.code.managedagent.persistence.ToolPublicationStore.Capacity(
                                captureBytes, 10 * allocation, 10 * allocation, 10));
                var publications = new ToolPublicationDataStore(jdbc, manager, store,
                        journal.sessions, objects(), Duration.ofMinutes(2), Duration.ofSeconds(30),
                        new ToolPublicationDataStore.VerificationBudget(
                                16 * 1024 * 1024, Duration.ofMinutes(25)));
                // The real pool, on its own threads: the producer polls the
                // same operation rows the server's scheduler would drain.
                verifier = new ToolPublicationVerifier(publications, 2);
                var registrations = new ExternalStorageRegistrationStore(jdbc, manager);
                producer = new ExternalShellPublicationProducer(
                        new HttpRuntimeTransport(), publications, registrations);
                store.apply(reserveRequest(journal, captureBytes),
                        PublicationJournalFixture.WRITER_TOKEN,
                        PublicationJournalFixture.PUBLICATION_TOKEN);
                var execution = dispatch(journal, binding);
                verifier.wake();
                return new Lane(source, jdbc, journal, publications, verifier, registrations,
                        worker, producer, binding, execution);
            } catch (RuntimeException | Error failed) {
                // Assertion failures are Errors, and the verifier's platform
                // threads are non-daemon: everything already created must be
                // closed here or the fork cannot exit. Both closes are
                // idempotent, so the success path's Lane.close stays safe.
                if (producer != null) {
                    producer.close();
                }
                if (verifier != null) {
                    verifier.close();
                }
                worker.close();
                throw failed;
            }
        }

        /**
         * The attested lease carries the worker's real origin. The seed, the
         * generation and the handle are untouched, so every identity fence
         * still reads the same binding the reservation was made against.
         */
        private static RuntimeBindingRecord rebind(PublicationJournalFixture journal,
                ExternalShellWorkerFixture worker) {
            var saved = journal.externalBinding;
            // The journal fixture attested under its own claim; hand it back
            // before re-attesting, exactly as a provisioner would.
            journal.bindings.releaseOperation(saved.getBindingId(), saved.getOperationOwner(),
                    saved.getOperationGeneration());
            var claimed = journal.bindings.claimOperation(saved.getBindingId(), "fixture",
                    Duration.ofMinutes(5));
            assertNotNull(claimed, "The fixture must hold the operation claim to re-attest");
            var moved = journal.bindings.compareAndSet(claimed, claimed.withState(
                    RuntimeBindingRecord.State.READY, worker.lease, java.time.Instant.now()));
            assertNotNull(moved, "The worker's origin must land on the saved generation");
            journal.bindings.releaseOperation(moved.getBindingId(), moved.getOperationOwner(),
                    moved.getOperationGeneration());
            var current = journal.bindings.findById(moved.getBindingId());
            journal.externalBinding = current;
            return current;
        }

        private static JsonNode reserveRequest(PublicationJournalFixture journal, long captureBytes) {
            var request = journal.request("reserve");
            ((com.fasterxml.jackson.databind.node.ObjectNode) request).put("captureBytes", captureBytes);
            return request;
        }

        /** The dispatched, authorized Shell the producer's lane requires. */
        private static ToolExecutionRecord dispatch(PublicationJournalFixture journal,
                RuntimeBindingRecord binding) {
            var sessions = new JdbcRuntimeSessionRepository(journal.jdbc.getDataSource());
            var prepared = journal.executions.findByExecutionCallId("execution-1");
            var claimed = journal.executions.claimDispatch("execution-1", "broker",
                    Duration.ofMinutes(5));
            return journal.bindings.authorizeDispatch(sessions, journal.executions, claimed,
                    "broker", claimed.getDispatchGeneration());
        }

        private RuntimePublicationGrant grant() {
            return grant(System.currentTimeMillis() + 600_000);
        }

        private RuntimePublicationGrant grant(long expiresAt) {
            // The grant the Broker's own verifier mints: the saved binding plus
            // the grant's horizon, which is the only expiry the worker is told.
            var saved = journal.store.verifyDispatchGrant(execution, "pub-1",
                    PublicationJournalFixture.PUBLICATION_TOKEN);
            Map<String, Object> fields = JSON.convertValue(saved.binding(),
                    new TypeReference<Map<String, Object>>() { });
            return new RuntimePublicationGrant("pub-1", PublicationJournalFixture.PUBLICATION_TOKEN,
                    "http://127.0.0.1:1", fields, expiresAt);
        }

        private String begin() {
            return producer.begin(lease, binding, execution, grant())
                    .toCompletableFuture().join();
        }

        private void drain(String channel) {
            drain(channel, envelope("success"));
        }

        private void drain(String channel, Map<String, Object> result) {
            producer.drain(lease, binding, execution, grant(), channel, result)
                    .toCompletableFuture().join();
        }

        /**
         * The worker's own settled envelope. Its manifest names a worker-local
         * resource the control plane cannot read, which is exactly why the
         * producer has to rebuild it.
         */
        private Map<String, Object> envelope(String executionStatus) {
            // A complete capture carries an explicit null reason, which the
            // result contract requires and Map.of cannot hold.
            var capture = new java.util.LinkedHashMap<String, Object>();
            capture.put("captureStatus", "complete");
            capture.put("captureReason", null);
            capture.put("previewTruncated", false);
            capture.put("deliveryStatus", "pending");
            capture.put("manifest", Map.of("resourceId", "worker-local-manifest",
                    "kind", "managed-tool-result-manifest", "schemaVersion", 1,
                    "byteLength", 1, "digest", "b".repeat(64)));
            return Map.of("executionStatus", executionStatus, "responseParts", List.of(),
                    "capture", capture);
        }

        private JsonNode finished() {
            JsonNode finished = finishedOrNull();
            assertNotNull(finished, "The drain must have finished the publication");
            return finished;
        }

        private JsonNode finishedOrNull() {
            return publications.finishedForBroker(execution);
        }

        private JsonNode resource(JsonNode ref) {
            return ToolPublicationContract.readJson(
                    publications.readResource(key, "pub-1", ref.path("resourceId").asText()));
        }

        private JsonNode content(JsonNode manifest, String stream) {
            for (JsonNode content : manifest.path("contents")) {
                if (stream.equals(content.path("streamId").asText())) {
                    return content;
                }
            }
            throw new AssertionError("The manifest has no stream " + stream);
        }

        private List<String> streams(JsonNode manifest) {
            var found = new java.util.ArrayList<String>();
            for (JsonNode content : manifest.path("contents")) {
                found.add(content.path("streamId").asText());
            }
            return found;
        }

        /** Reads the stream back through the store's own paged reader. */
        private String read(JsonNode manifest, JsonNode manifestRef, String stream) {
            JsonNode content = content(manifest, stream);
            byte[] bytes = publications.readRange(key, "pub-1",
                    PublicationJournalFixture.WRITER_TOKEN, manifestRef, manifest, stream,
                    0, (int) content.path("byteLength").asLong());
            assertEquals(ToolPublicationContract.sha256(bytes), content.path("digest").asText(),
                    "The published stream digest must cover exactly the bytes read back");
            return new String(bytes, StandardCharsets.UTF_8);
        }

        private String stopDrained() {
            return worker.stopDrained(worker.transport());
        }

        @Override
        public void close() {
            producer.close();
            verifier.close();
            worker.close();
        }

        private static JdbcManagedToolResultStore results(ManagedSchemaJdbcTemplate jdbc,
                DataSourceTransactionManager manager) {
            var properties = new ManagedAgentProperties();
            properties.getArtifacts().setEnabled(true);
            ManagedAgentStore sessions = VerificationFixtures.managedAgentStore(jdbc, JSON,
                    Clock.systemUTC(), events -> {},
                    org.mockito.Mockito.mock(JdbcManagedWorkspaceRegistry.class), properties,
                    new SdkHarnessRules());
            return new JdbcManagedToolResultStore(jdbc, manager, sessions);
        }

        /**
         * The private object store, in memory. Every write is exclusive and
         * every read returns the stored bytes, which is the guarantee the
         * publication lane's digests depend on; the backend itself is not what
         * these cases are about.
         */
        private static ToolPublicationObjectStore objects() {
            Map<String, byte[]> stored = new ConcurrentHashMap<>();
            return new ToolPublicationObjectStore() {
                @Override
                public void putIfAbsent(String key, byte[] bytes) {
                    stored.putIfAbsent(key, bytes.clone());
                }

                @Override
                public InputStream open(String key) {
                    byte[] bytes = stored.get(key);
                    if (bytes == null) {
                        throw new IllegalStateException("Missing publication object " + key);
                    }
                    return new ByteArrayInputStream(bytes);
                }

                @Override
                public InputStream openRange(String key, long offset, long length, Runnable guard) {
                    guard.run();
                    try (InputStream full = open(key)) {
                        return new ByteArrayInputStream(full.readAllBytes(), (int) offset, (int) length);
                    } catch (IOException error) {
                        throw new IllegalStateException(error);
                    }
                }

                @Override
                public void validateConfiguration() {}
            };
        }
    }
}
