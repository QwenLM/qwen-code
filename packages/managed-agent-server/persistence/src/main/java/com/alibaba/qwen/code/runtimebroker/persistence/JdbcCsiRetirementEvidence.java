package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiApplicationJson;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedCsiFilesProtocol;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import java.util.function.Function;

/**
 * The saved retirement's terminal proof together with the execution and resource rows that belong
 * to its own Session. Every read is keyed by the Binding or the Session scope, so a retirement
 * never scans or locks another tenant's rows.
 */
public final class JdbcCsiRetirementEvidence {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int FROZEN_LIMIT = 32 * 1024 * 1024;
    private static final int BODY_LIMIT = CsiNativeActivationProof.TERMINAL_BODY_LIMIT;

    private JdbcCsiRetirementEvidence() {
    }

    public record Evidence(CsiNativeActivationProof.TerminalProof terminal, List<ToolExecutionRecord> executions,
            Function<JsonNode, byte[]> resources, long sealedBindingVersion) {
    }

    public static Evidence of(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.TerminalProof proof, long sealedBindingVersion) throws SQLException {
        return evidence(connection, original, proof, JdbcCsiActivationAdmission.JournalRead.LIVE, sealedBindingVersion);
    }

    /** A saved FROZEN application is re-read after its writer lease may have expired. */
    public static Evidence saved(Connection connection, JdbcCsiApplicationRetirement.Authority authority,
            JdbcRuntimeBindingRepository bindings) throws SQLException {
        authority.requireConnection(connection);
        require(authority.stage() != JdbcCsiApplicationRetirement.Stage.SETTLING);
        JsonNode metadata = frozenCommit(authority.frozenBytes());
        var proof = authority.stage() == JdbcCsiApplicationRetirement.Stage.FROZEN
                ? JdbcCsiActivationAdmission.terminalPreflight(connection, authority, metadata, bindings, false)
                : JdbcCsiActivationAdmission.terminalHistory(connection, authority);
        return evidence(connection, authority.original(), proof, JdbcCsiActivationAdmission.JournalRead.LIVE,
                authority.sealedBindingVersion());
    }

    public static Evidence historical(Connection connection, RuntimeBindingRecord binding, byte[] frozenBytes,
            long started) throws SQLException {
        var read = new JdbcCsiActivationAdmission.JournalRead(started);
        read.requireHistorical(connection);
        var original = JdbcCsiFilesRetirementGuard.readHistoricalBinding(connection, binding);
        long ceiling = JdbcCsiRetirementSeal.readHistorical(connection, original, frozenBytes, read);
        var proof = JdbcCsiActivationAdmission.terminalHistory(connection, original, frozenBytes, read);
        JdbcCsiExecutionAdmission.verifyHistoricalReceipts(connection, original, proof, ceiling, read);
        var result = evidence(connection, original, proof, read, ceiling);
        read.requireHistorical(connection);
        return result;
    }

    private static Evidence evidence(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.TerminalProof proof, JdbcCsiActivationAdmission.JournalRead read,
            long sealedBindingVersion) throws SQLException {
        var resources = CsiNativeToolReservation.inventory(connection, original, read);
        var executions = CsiNativeToolReservation.complete(connection, original, proof.predecessorPrefix(),
                resources, 0, 0, read);
        return new Evidence(proof, executions, ref -> CsiNativeToolReservation.candidateBytes(resources, ref),
                sealedBindingVersion);
    }

    /**
     * The prepared commit body is bounded by {@link #BODY_LIMIT}, not by the short-text helper's
     * 4096-character cap: its base64 reaches roughly 175 KB, so a short-text read would refuse every
     * retirement whose body exceeds 3072 bytes and strand it after FROZEN.
     */
    static JsonNode frozenCommit(byte[] frozenBytes) {
        JsonNode frozen = JSON.valueToTree(ManagedCsiFilesProtocol.parse(frozenBytes, FROZEN_LIMIT));
        byte[] body = WorkspaceCsiApplicationJson.base64(frozen.path("commitBodyBase64"), BODY_LIMIT);
        require(CsiNativeActivationProof.sha256(body).equals(frozen.path("preparedCommitSha256").textValue()));
        return CsiNativeActivationProof.readObject(body);
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw new RuntimeBrokerException(409, "csi_original_activation_unavailable",
                    "The original CSI native activation proof is unavailable.", false);
        }
    }
}
