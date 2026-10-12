package com.alibaba.qwen.code.managedagent.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import com.alibaba.qwen.code.managedagent.store.WriterCredentialPolicy;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.support.TransactionTemplate;

class ToolPublicationControllerTest {
    private static final String TENANT = "tenant";
    private static final String WORKSPACE = "workspace";
    private static final String SESSION = "session";
    private static final String PUBLICATION_URL = "/internal/managed-tool-publications/v1/sessions/"
            + SESSION + "/publications/missing-publication";
    private MockMvc mvc;
    private String writerToken;

    @ParameterizedTest
    @ValueSource(strings = {"/finished", "/admissions/prepare", "/range"})
    void returnsNotFoundForUnknownPublication(String route) throws Exception {
        setupPublicationReads();
        mvc.perform(publicationRequest(route, writerToken))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("managed_tool_publication_unknown"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"/finished", "/admissions/prepare", "/range"})
    void authenticatesWriterBeforeLookingUpPublication(String route) throws Exception {
        setupPublicationReads();
        mvc.perform(publicationRequest(route, "invalid-writer-token-invalid-writer-token"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("writer_credential_invalid"));
    }

    @Test
    void rejectsCoercedOrOverflowedRangeNumbersBeforeReading() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getToolPublication().setEntryConcurrency(1);
        ToolPublicationDataStore data = mock(ToolPublicationDataStore.class);
        ToolPublicationController controller = new ToolPublicationController(
                mock(ToolPublicationStore.class), data,
                mock(ToolPublicationAdmissionStore.class), properties);
        for (String pair : new String[] {
                "\"offset\":\"1\",\"length\":2",
                "\"offset\":1.5,\"length\":2",
                "\"offset\":0,\"length\":4294967297",
                "\"offset\":9223372036854775808,\"length\":1",
                "\"offset\":0,\"length\":\"2\""}) {
            MockHttpServletRequest request = new MockHttpServletRequest();
            request.setContent(("{\"manifestRef\":{},\"expectedIdentity\":{},\"streamId\":\"stdout\","
                    + pair + "}").getBytes(StandardCharsets.UTF_8));
            assertThatThrownBy(() -> controller.range(new TenantContext("tenant", null),
                    "session", "publication", "workspace", "writer-token", request))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("Invalid publication range");
        }
        verifyNoInteractions(data);
    }

    private void setupPublicationReads() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:publication-controller-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(source).load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(source);
        DataSourceTransactionManager manager = new DataSourceTransactionManager(source);
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getSessionStore().setBindingKey("0123456789abcdef0123456789abcdef");
        properties.getToolPublication().setEntryConcurrency(1);
        WriterCredentialPolicy credentials = new WriterCredentialPolicy(properties);
        ManagedSessionStore sessions = new ManagedSessionStore(jdbc);
        sessions.setCredentials(credentials);
        writerToken = credentials.issue(TENANT, WORKSPACE, SESSION);
        var grant = new TransactionTemplate(manager).execute(transaction -> sessions.acquireWriter(
                TENANT, SESSION, writerToken, new AcquireWriterRequest(WORKSPACE, "writer", 60_000L)));
        assertThat(grant.writerGeneration()).isEqualTo(1);
        assertThat(sessions.restore(TENANT, WORKSPACE, SESSION, writerToken).state()).isEqualTo("ACTIVE");
        ToolPublicationStore grants = new ToolPublicationStore(jdbc, manager, sessions,
                mock(ToolExecutionRepository.class), mock(RuntimeBindingRepository.class),
                new ToolPublicationStore.Capacity(1024L * 1024 * 1024,
                        1024L * 1024 * 1024, 1024L * 1024 * 1024, 4), false);
        ToolPublicationDataStore data = new ToolPublicationDataStore(jdbc, manager, grants,
                sessions, mock(ToolPublicationObjectStore.class), Duration.ofSeconds(10),
                Duration.ofSeconds(5), new ToolPublicationDataStore.VerificationBudget(
                        1024 * 1024, Duration.ofMinutes(25)));
        ToolPublicationController controller = new ToolPublicationController(grants, data,
                new ToolPublicationAdmissionStore(jdbc, manager, sessions, data), properties);
        mvc = MockMvcBuilders.standaloneSetup(controller)
                .setCustomArgumentResolvers(new TenantContextArgumentResolver())
                .setControllerAdvice(new ApiExceptionHandler())
                .addFilters(new TenantContextFilter(new ObjectMapper()))
                .build();
    }

    private MockHttpServletRequestBuilder publicationRequest(String route, String token) {
        MockHttpServletRequestBuilder request = "/finished".equals(route)
                ? get(PUBLICATION_URL + route) : post(PUBLICATION_URL + route);
        if ("/admissions/prepare".equals(route)) {
            request.header("X-Qwen-Managed-Writer-Id", "writer")
                    .header("X-Qwen-Managed-Writer-Generation", 1)
                    .content("{\"schemaVersion\":1}");
        } else if ("/range".equals(route)) {
            request.content("{\"manifestRef\":{},\"expectedIdentity\":{},"
                    + "\"streamId\":\"stdout\",\"offset\":0,\"length\":1}");
        }
        return request.header(TenantContextFilter.HEADER, TENANT)
                .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, token)
                .param("workspaceId", WORKSPACE)
                .contentType(MediaType.APPLICATION_JSON);
    }
}
