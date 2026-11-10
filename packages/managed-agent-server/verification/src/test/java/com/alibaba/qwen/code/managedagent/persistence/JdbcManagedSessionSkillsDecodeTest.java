package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

class JdbcManagedSessionSkillsDecodeTest {
    private final ObjectMapper json = new ObjectMapper();
    private final RequestDigests digests = new RequestDigests();

    @Test
    void keepsACorruptStoredSnapshotInTheConflictVocabulary() {
        // An unknown field makes sessionSkills raise the admission code
        // agent_definition_unsupported; decode must normalise a corrupt stored
        // snapshot back to session_skills_conflict (chaining the cause) rather
        // than blame the caller's definition for the server's own bad row.
        String value = "{\"version\":1,\"skills\":[{\"name\":\"x\",\"description\":\"d\","
                + "\"body\":\"b\",\"unknownField\":\"y\"}],\"digest\":\"sha256:0\"}";
        Throwable error = catchThrowable(
                () -> JdbcManagedSessionSkills.decode(value, json, digests));
        assertThat(error).isInstanceOf(ManagedAgentException.class);
        assertThat(((ManagedAgentException) error).getCode())
                .isEqualTo("session_skills_conflict");
        assertThat(error.getCause()).isInstanceOf(ManagedAgentException.class);
        assertThat(((ManagedAgentException) error.getCause()).getCode())
                .isEqualTo("agent_definition_unsupported");
    }

    @Test
    void preservesTheConflictThrownInsideDecode() {
        // A version-1 snapshot with a wrong key set throws conflict() inside the
        // try; that exact exception (code and no cause) must propagate unchanged.
        String value = "{\"version\":1,\"skills\":[],\"digest\":\"sha256:0\",\"extra\":1}";
        Throwable error = catchThrowable(
                () -> JdbcManagedSessionSkills.decode(value, json, digests));
        assertThat(error).isInstanceOf(ManagedAgentException.class);
        assertThat(((ManagedAgentException) error).getCode())
                .isEqualTo("session_skills_conflict");
        assertThat(error.getCause()).isNull();
    }
}
