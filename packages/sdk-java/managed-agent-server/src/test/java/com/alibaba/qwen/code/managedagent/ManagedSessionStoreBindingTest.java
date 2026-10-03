package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.WriterCredentialPolicy;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * With a configured binding key the writer credential is broker-provisioned
 * and bound to (tenant, workspace, session): self-minted tokens stop working,
 * including during a free lease window.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:managed-session-binding;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false",
        "qwen.managed-agent.session-store.enabled=true",
        "qwen.managed-agent.session-store.binding-key=0123456789abcdef0123456789abcdef"
})
@AutoConfigureMockMvc
class ManagedSessionStoreBindingTest {
    private static final String TENANT = "tenant-binding";
    private static final String WORKSPACE = "workspace-binding";
    private static final String SELF_MINTED =
            "cccccccccccccccccccccccccccccccc";

    @Autowired
    private MockMvc mvc;

    @Autowired
    private WriterCredentialPolicy credentials;

    @Test
    void selfMintedTokensCannotAcquireOrRead() throws Exception {
        String session = "session-" + UUID.randomUUID();
        String base = base(session);
        mvc.perform(post(base + "/writers:acquire")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                SELF_MINTED)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(acquire("writer-a", 60_000)))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code")
                        .value("writer_credential_invalid"));

        String token = credentials.issue(TENANT, WORKSPACE, session);
        mvc.perform(post(base + "/writers:acquire")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(acquire("writer-a", 60_000)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.writerGeneration").value(1));

        // The lease is now held: even the right token from another writer
        // generation flow keeps working, while self-minted stays out.
        mvc.perform(get(base + "/restore")
                        .param("workspaceId", WORKSPACE)
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                SELF_MINTED))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code")
                        .value("writer_credential_invalid"));
        mvc.perform(get(base + "/restore")
                        .param("workspaceId", WORKSPACE)
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                token))
                .andExpect(status().isOk());
    }

    @Test
    void credentialsAreScopeBoundAndSurviveAWriterReboot() throws Exception {
        String session = "session-" + UUID.randomUUID();
        String other = "session-" + UUID.randomUUID();
        String token = credentials.issue(TENANT, WORKSPACE, session);

        // A credential names one Session scope only.
        mvc.perform(post(base(other) + "/writers:acquire")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(acquire("writer-a", 60_000)))
                .andExpect(status().isForbidden());

        mvc.perform(post(base(session) + "/writers:acquire")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(acquire("writer-a", 1_000)))
                .andExpect(status().isOk());

        // A competing writer cannot take over a live lease.
        mvc.perform(post(base(session) + "/writers:acquire")
                        .header(TenantContextFilter.HEADER, TENANT)
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER,
                                token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(acquire("writer-b", 1_000)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value(
                        "managed_session_writer_conflict"));

        // After the lease lapses the rebooted harness re-acquires with the
        // same broker-provisioned credential. Poll rather than trust a
        // single sleep: under CPU starvation the 1s lease may not have
        // lapsed yet when the first attempt runs.
        int reacquire = 0;
        long deadline = System.currentTimeMillis() + 15_000;
        while (System.currentTimeMillis() < deadline) {
            reacquire = mvc.perform(post(base(session) + "/writers:acquire")
                            .header(TenantContextFilter.HEADER, TENANT)
                            .header(ManagedSessionStoreModels
                                    .WRITER_TOKEN_HEADER, token)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(acquire("writer-b", 60_000)))
                    .andReturn().getResponse().getStatus();
            if (reacquire == 200) {
                break;
            }
            Thread.sleep(200);
        }
        assertThat(reacquire).isEqualTo(200);
    }

    @Test
    void selfMintedTokensAreRefusedAtEveryEntryPoint() throws Exception {
        String session = "session-" + UUID.randomUUID();
        String base = base(session);
        String digest = "0".repeat(64);
        String[][] calls = {
            {"POST", "/writers:acquire", acquire("writer-a", 60_000)},
            {"POST", "/writers:renew",
                    "{\"workspaceId\":\"" + WORKSPACE
                            + "\",\"writerId\":\"writer-a\","
                            + "\"writerGeneration\":1,\"leaseMillis\":60000}"},
            {"POST", "/writers:seal",
                    "{\"workspaceId\":\"" + WORKSPACE
                            + "\",\"writerId\":\"writer-a\","
                            + "\"writerGeneration\":1}"},
            {"POST", "/recovery:block",
                    "{\"workspaceId\":\"" + WORKSPACE
                            + "\",\"writerId\":\"writer-a\","
                            + "\"writerGeneration\":1,"
                            + "\"recoveryStatus\":\"BLOCKED_RESOURCE\","
                            + "\"recoveryDetailCode\":\"x\"}"},
            {"POST", "/transactions:commit",
                    "{\"workspaceId\":\"" + WORKSPACE
                            + "\",\"writerId\":\"writer-a\","
                            + "\"writerGeneration\":1,"
                            + "\"expectedJournalRevision\":0,"
                            + "\"expectedCommittedSequence\":0,"
                            + "\"transactionId\":\"txn-1\","
                            + "\"operation\":\"op\",\"commandId\":\"cmd-1\","
                            + "\"contentDigest\":\"" + digest + "\","
                            + "\"firstSequence\":0,\"lastSequence\":0,"
                            + "\"eventCount\":0,\"activationEpoch\":0,"
                            + "\"recordCount\":1,"
                            + "\"recordBytesBase64\":\"e30=\","
                            + "\"recordDigest\":\"" + digest + "\","
                            + "\"resources\":[]}"},
            {"POST", "/tool-results:publish",
                    "{\"workspaceId\":\"" + WORKSPACE
                            + "\",\"writerId\":\"writer-a\","
                            + "\"writerGeneration\":1,"
                            + "\"resourceId\":\"res-1\","
                            + "\"kind\":\"tool_output\","
                            + "\"schemaVersion\":1,\"byteLength\":2,"
                            + "\"digest\":\"" + digest + "\","
                            + "\"bytesBase64\":\"e30=\"}"},
        };
        for (String[] call : calls) {
            mvc.perform(post(base + call[1])
                            .header(TenantContextFilter.HEADER, TENANT)
                            .header(ManagedSessionStoreModels
                                    .WRITER_TOKEN_HEADER, SELF_MINTED)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(call[2]))
                    .andExpect(status().isForbidden())
                    .andExpect(jsonPath("$.error.code")
                            .value("writer_credential_invalid"));
        }
        for (String read : new String[] {
                "/restore?workspaceId=" + WORKSPACE,
                "/transactions?workspaceId=" + WORKSPACE,
                "/resources/res-1?workspaceId=" + WORKSPACE}) {
            mvc.perform(get(base + read)
                            .header(TenantContextFilter.HEADER, TENANT)
                            .header(ManagedSessionStoreModels
                                    .WRITER_TOKEN_HEADER, SELF_MINTED))
                    .andExpect(status().isForbidden())
                    .andExpect(jsonPath("$.error.code")
                            .value("writer_credential_invalid"));
        }
    }

    private static String base(String session) {
        return "/internal/managed-session-store/v1/sessions/" + session;
    }

    private static String acquire(String writerId, long leaseMillis) {
        return "{\"workspaceId\":\"" + WORKSPACE + "\",\"writerId\":\""
                + writerId + "\",\"leaseMillis\":" + leaseMillis + "}";
    }
}
