package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The frozen envelope's prepared commit body carries its own 128 KiB bound, not the short-text
 * helper's 4096-character cap. A body over 3072 bytes base64-encodes past that cap, and reading it
 * with the short-text helper strands every such retirement after FROZEN: freeze itself does not
 * pass through this reader, while cut, status, finalize and the worker authority all do.
 */
class JdbcCsiRetirementEvidenceTest {

    @Test
    void readsAPreparedCommitBodyLargerThanTheShortTextCap() {
        byte[] body = body(4000);
        assertThat(body.length).isGreaterThan(3072);
        assertThat(Base64.getEncoder().encodeToString(body).length()).isGreaterThan(4096);

        var metadata = JdbcCsiRetirementEvidence.frozenCommit(frozen(body, CsiNativeActivationProof.sha256(body)));

        assertThat(metadata.path("pad").textValue()).hasSize(4000);
    }

    @Test
    void refusesAPreparedCommitBodyWhoseDigestDoesNotMatch() {
        byte[] body = body(4000);

        assertThatThrownBy(() -> JdbcCsiRetirementEvidence.frozenCommit(frozen(body, CsiNativeActivationProof.sha256(body(4001)))))
                .isInstanceOf(RuntimeBrokerException.class);
    }

    private static byte[] body(int padding) {
        return ("{\"pad\":\"" + "x".repeat(padding) + "\"}").getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] frozen(byte[] body, String digest) {
        return ("{\"commitBodyBase64\":\"" + Base64.getEncoder().encodeToString(body)
                + "\",\"preparedCommitSha256\":\"" + digest + "\"}").getBytes(StandardCharsets.UTF_8);
    }
}
