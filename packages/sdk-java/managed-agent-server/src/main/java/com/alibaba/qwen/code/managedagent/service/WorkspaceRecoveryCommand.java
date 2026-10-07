package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.maintenance.WorkspaceRecoveryApplication;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceOperatorRecoveryStore;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.LocalProcessRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import javax.sql.DataSource;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.JdbcTransactionManager;

/** Offline maintenance entry point; it never opens a listener or starts a worker. */
public final class WorkspaceRecoveryCommand {
    private WorkspaceRecoveryCommand() {
    }

    public static void main(String[] args) throws Exception {
        try (ConfigurableApplicationContext context = new SpringApplicationBuilder(
                WorkspaceRecoveryApplication.class).web(WebApplicationType.NONE).run(args)) {
            if (args.length == 0) {
                throw new IllegalArgumentException("Expected inspect, prepare or complete.");
            }
            ManagedAgentProperties.RuntimeBroker options = context.getBean(
                    ManagedAgentProperties.class).getRuntimeBroker();
            if (!options.isOperatorRecoveryEnabled()
                    || !options.isDurableLocalProcess()
                    || !"local-process".equals(options.getProvisioner())
                    || options.getStateDirectory() == null || options.getStateDirectory().isBlank()) {
                throw new IllegalStateException("Operator recovery requires enabled durable local workers.");
            }
            DataSource dataSource = context.getBean(DataSource.class);
            var bindings = new JdbcRuntimeBindingRepository(dataSource,
                    AesGcmSecretProtector.fromBase64(options.getCredentialKeyId(),
                            options.getCredentialKey()));
            var sessions = new JdbcRuntimeSessionRepository(dataSource);
            var executions = new JdbcToolExecutionRepository(dataSource);
            var manager = new JdbcTransactionManager(dataSource);
            var jdbc = new JdbcTemplate(dataSource);
            var ownership = new WorkspaceExecutionStore(jdbc, manager);
            var operator = new WorkspaceOperatorRecoveryStore(jdbc, manager,
                    bindings, context.getBean(ObjectMapper.class));
            Path stateDirectory = Path.of(options.getStateDirectory()).toAbsolutePath().normalize();
            if (!Files.isDirectory(stateDirectory, LinkOption.NOFOLLOW_LINKS)) {
                throw new IllegalStateException("Original Runtime state directory is unavailable.");
            }
            HttpRuntimeTransport http = new HttpRuntimeTransport();
            try (LocalProcessRuntimeProvisioner local = LocalProcessRuntimeProvisioner.durable(
                    List.of("maintenance-never-starts-worker"), stateDirectory, http,
                    options.isTrustedLocalRebootRecovery())) {
                if ("inspect".equals(args[0]) && args.length == 3) {
                    long generation = Long.parseLong(args[2]);
                    var inspection = operator.inspect(args[1], generation);
                    local.verifyOperatorRegistration(bindings.findById(args[1]));
                    System.out.println(context.getBean(ObjectMapper.class).writeValueAsString(inspection));
                    return;
                }
                if ("prepare".equals(args[0]) && args.length == 5) {
                    long generation = Long.parseLong(args[2]);
                    operator.inspect(args[1], generation);
                    local.verifyOperatorRegistration(bindings.findById(args[1]));
                    System.out.println(operator.prepare(args[1], generation,
                            args[3], System.getProperty("user.name"), args[4]));
                    return;
                }
                if (!"complete".equals(args[0]) || args.length != 3) {
                    throw new IllegalArgumentException("Expected inspect <binding> <generation>,"
                            + " prepare <binding> <generation> <holder> <reason>,"
                            + " or complete <recoveryId> <evidenceFile>.");
                }
                WorkspaceOperatorRecoveryStore.Operation operation = operator.operation(args[1]);
                byte[] evidence = readEvidence(stateDirectory, Path.of(args[2]),
                        operation.recoveryId(), operation.preparedAt(), context.getBean(ObjectMapper.class));
                RuntimeBindingRecord saved = bindings.findById(operation.bindingId());
                if (saved == null || saved.getGeneration() != operation.generation()) {
                    throw new IllegalStateException("Original Runtime generation changed.");
                }
                operator.requireSnapshot(operation, saved);
                if ((saved.getState() == RuntimeBindingRecord.State.LOST
                        || saved.getState() == RuntimeBindingRecord.State.RELEASED)
                        && saved.getStopEvidence() != null
                        && !("operator-attested:" + operation.recoveryId()).equals(
                                saved.getStopEvidence().source())) {
                    throw new IllegalStateException("Operator stop evidence does not match recovery.");
                }
                if (saved.getState() == RuntimeBindingRecord.State.RELEASED
                        && saved.getStopEvidence() == null) {
                    throw new IllegalStateException("Retired Runtime lacks operator stop evidence.");
                }
                if (operation.completed()) {
                    if (saved.getState() != RuntimeBindingRecord.State.RELEASED) {
                        throw new IllegalStateException("Completed recovery has no retired Runtime.");
                    }
                    operator.attest(operation, evidence);
                    System.out.println("completed");
                    return;
                }
                if (saved.getState() == RuntimeBindingRecord.State.RELEASED) {
                    operator.attest(operation, evidence);
                    operator.complete(operation);
                    System.out.println("completed");
                    return;
                }
                RuntimeObservation proof;
                String owner = UUID.randomUUID().toString();
                if (saved.getState() == RuntimeBindingRecord.State.OPERATOR_RECOVERY
                        || saved.getState() == RuntimeBindingRecord.State.LOST
                                && saved.getStopEvidence() == null) {
                    proof = local.attestOperatorStop(saved, operation.recoveryId());
                    operator.attest(operation, evidence);
                    RuntimeBindingRecord current = bindings.claimOperation(operation.bindingId(),
                            owner, Duration.ofSeconds(30));
                    if (current == null || current.getGeneration() != operation.generation()
                            || current.getState() != saved.getState()
                            || current.getStopEvidence() != null) {
                        throw new IllegalStateException("Operator recovery fence changed.");
                    }
                    operator.requireSnapshot(operation, current);
                    operator.requireHeld(operation);
                    RuntimeBindingRecord lost = bindings.compareAndSet(current,
                            current.withRecoveryEvidence(proof.getLossEvidence(),
                                    proof.getStopEvidence(), Instant.now()));
                    if (lost == null) {
                        throw new IllegalStateException("Operator recovery update raced; retry complete.");
                    }
                } else if (saved.getState() != RuntimeBindingRecord.State.LOST
                        || !saved.hasStoppedWriters()
                        || operator.operation(operation.recoveryId()).attestationHash() == null) {
                    throw new IllegalStateException("Operator recovery is not ready to continue.");
                } else {
                    operator.attest(operation, evidence);
                }
                try (RuntimeBrokerService broker = new RuntimeBrokerService(
                        sessionId -> CompletableFuture.failedFuture(
                                new IllegalStateException("Maintenance never resolves Sessions")),
                        new WorkspaceRuntimeProvisioner(local, null, ownership), http,
                        bindings, sessions, executions, owner,
                        Duration.ofSeconds(30), Duration.ofSeconds(30))) {
                    for (int step = 0; step < 16; step++) {
                        RuntimeBindingRecord result = broker.recoverBinding(
                                operation.bindingId(), operation.generation())
                                .toCompletableFuture().join();
                        if (result.getState() == RuntimeBindingRecord.State.RELEASED) {
                            operator.complete(operation);
                            System.out.println("completed");
                            return;
                        }
                    }
                    throw new IllegalStateException("Recovery remains pending; retry complete.");
                }
            }
        }
    }

    static byte[] readEvidence(Path stateDirectory, Path source,
            String recoveryId, Instant preparedAt, ObjectMapper mapper) throws Exception {
        Path file = source.toAbsolutePath().normalize();
        if (!stateDirectory.equals(file.getParent()) || Files.isSymbolicLink(file)
                || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)
                || !PosixFilePermissions.toString(Files.getPosixFilePermissions(file))
                        .equals("rw-------")) {
            throw new IllegalArgumentException("Evidence must be a private file in the Runtime state directory.");
        }
        byte[] evidence;
        try (var input = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
            evidence = input.readNBytes(8193);
        }
        if (evidence.length > 8192) {
            throw new IllegalArgumentException("Operator evidence exceeds 8 KiB.");
        }
        if (!Arrays.equals(evidence,
                new String(evidence, StandardCharsets.UTF_8).getBytes(StandardCharsets.UTF_8))) {
            throw new IllegalArgumentException("Operator evidence must be UTF-8.");
        }
        JsonNode value = mapper.readTree(evidence);
        if (value == null || !value.isObject() || value.size() != 6
                || !value.path("version").isIntegralNumber()
                || !value.path("version").canConvertToInt()
                || value.path("version").asInt() != 1
                || !recoveryId.equals(value.path("recoveryId").asText())
                || !value.path("restartPrevention").isBoolean()
                || !value.path("restartPrevention").asBoolean()
                || !value.path("verifiedAt").isTextual()
                || !value.path("method").isTextual()
                || value.path("method").asText().isBlank()
                || !value.path("actions").isTextual()
                || value.path("actions").asText().isBlank()) {
            throw new IllegalArgumentException("Operator evidence is incomplete.");
        }
        Instant verifiedAt = Instant.parse(value.path("verifiedAt").asText());
        if (verifiedAt.isBefore(preparedAt)
                || verifiedAt.isAfter(Instant.now().plus(Duration.ofMinutes(5)))) {
            throw new IllegalArgumentException("Operator evidence time is outside recovery window.");
        }
        return evidence;
    }
}
