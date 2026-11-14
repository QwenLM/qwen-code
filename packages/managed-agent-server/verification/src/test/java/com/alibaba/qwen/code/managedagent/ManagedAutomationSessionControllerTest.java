package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler;
import com.alibaba.qwen.code.managedagent.api.ManagedAutomationSessionController;
import com.alibaba.qwen.code.managedagent.api.TenantContextArgumentResolver;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.automation.ManagedAutomationService;
import com.alibaba.qwen.code.managedagent.automation.ManagedAutomationSessionService;
import com.alibaba.qwen.code.managedagent.contracts.automation.AutomationSessionModels;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicAutomation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicList;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The internal Session-scoped automation routes' wire contract, exercised
 * through the real controller and Jackson binding (the store-channel client
 * sends the writer binding in camelCase and the definition in the automation
 * snake_case). The service is mocked; the Session scoping and creator
 * derivation it performs are covered by the service-level suites.
 */
class ManagedAutomationSessionControllerTest {
    private final ManagedAutomationSessionService service =
            mock(ManagedAutomationSessionService.class);
    private final ObjectMapper mapper = new ObjectMapper();
    private final MockMvc mvc = MockMvcBuilders
            .standaloneSetup(new ManagedAutomationSessionController(service))
            .setCustomArgumentResolvers(new TenantContextArgumentResolver())
            .setControllerAdvice(new ApiExceptionHandler())
            .addFilters(new TenantContextFilter(mapper)).build();

    private static PublicAutomation automation(String state) {
        return new PublicAutomation("asch_abc", "automation", "session", 1,
                "sha256:" + "b".repeat(64), "watch the build", "*/5 * * * *",
                "UTC", "persistent", "skip", "none", null, true, state,
                1, 1, null, null);
    }

    @Test
    void createBindsTheCamelCaseWriterBindingAndDerivedKey() throws Exception {
        when(service.create(eq("tenant"), eq("session"), eq("synthetic-writer"),
                eq("loop:call-1:create"), org.mockito.ArgumentMatchers.any()))
                .thenReturn(new ManagedAutomationService.Result<>(automation("active"), false));
        String body = "{\"workspaceId\":\"workspace-a\",\"writerId\":\"harness-a\","
                + "\"writerGeneration\":1,\"definition\":{\"cron\":\"*/5 * * * *\","
                + "\"prompt\":\"/loop check\",\"session_mode\":\"persistent\",\"timezone\":\"UTC\"}}";
        mvc.perform(post("/internal/managed-session-store/v1/sessions/session/automations:create")
                        .header("X-Qwen-Tenant-Id", "tenant")
                        .header("X-Qwen-Managed-Writer-Token", "synthetic-writer")
                        .header("Idempotency-Key", "loop:call-1:create")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.body.id").value("asch_abc"))
                .andExpect(jsonPath("$.body.session_id").value("session"))
                .andExpect(jsonPath("$.replayed").value(false));
        ArgumentCaptor<AutomationSessionModels.Create> captor =
                ArgumentCaptor.forClass(AutomationSessionModels.Create.class);
        verify(service).create(eq("tenant"), eq("session"), eq("synthetic-writer"),
                eq("loop:call-1:create"), captor.capture());
        assertThat(captor.getValue().workspaceId()).isEqualTo("workspace-a");
        assertThat(captor.getValue().writerId()).isEqualTo("harness-a");
        assertThat(captor.getValue().writerGeneration()).isEqualTo(1);
        assertThat(captor.getValue().definition().cron()).isEqualTo("*/5 * * * *");
        assertThat(captor.getValue().definition().sessionMode()).isEqualTo("persistent");
    }

    @Test
    void listAnswersTheSessionPageWithTheCursorContract() throws Exception {
        when(service.list(eq("tenant"), eq("session"), eq("synthetic-writer"),
                org.mockito.ArgumentMatchers.any()))
                .thenReturn(new PublicList<>("list", List.of(automation("active")), true, "cursor-2"));
        String body = "{\"workspaceId\":\"workspace-a\",\"writerId\":\"harness-a\","
                + "\"writerGeneration\":1,\"cursor\":\"cursor-1\",\"limit\":100}";
        mvc.perform(post("/internal/managed-session-store/v1/sessions/session/automations:list")
                        .header("X-Qwen-Tenant-Id", "tenant")
                        .header("X-Qwen-Managed-Writer-Token", "synthetic-writer")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].id").value("asch_abc"))
                .andExpect(jsonPath("$.has_more").value(true))
                .andExpect(jsonPath("$.next_cursor").value("cursor-2"));
        ArgumentCaptor<AutomationSessionModels.ListRequest> captor =
                ArgumentCaptor.forClass(AutomationSessionModels.ListRequest.class);
        verify(service).list(eq("tenant"), eq("session"), eq("synthetic-writer"), captor.capture());
        assertThat(captor.getValue().cursor()).isEqualTo("cursor-1");
        assertThat(captor.getValue().limit()).isEqualTo(100);
    }

    @Test
    void retireBindsTheAutomationIdAndReplayMark() throws Exception {
        when(service.retire(eq("tenant"), eq("session"), eq("synthetic-writer"),
                eq("loop:call-2:retire"), org.mockito.ArgumentMatchers.any()))
                .thenReturn(new ManagedAutomationService.Result<>(automation("retired"), true));
        String body = "{\"workspaceId\":\"workspace-a\",\"writerId\":\"harness-a\","
                + "\"writerGeneration\":1,\"automationId\":\"asch_abc\"}";
        mvc.perform(post("/internal/managed-session-store/v1/sessions/session/automations:retire")
                        .header("X-Qwen-Tenant-Id", "tenant")
                        .header("X-Qwen-Managed-Writer-Token", "synthetic-writer")
                        .header("Idempotency-Key", "loop:call-2:retire")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.body.state").value("retired"))
                .andExpect(jsonPath("$.replayed").value(true));
        ArgumentCaptor<AutomationSessionModels.Retire> captor =
                ArgumentCaptor.forClass(AutomationSessionModels.Retire.class);
        verify(service).retire(eq("tenant"), eq("session"), eq("synthetic-writer"),
                eq("loop:call-2:retire"), captor.capture());
        assertThat(captor.getValue().automationId()).isEqualTo("asch_abc");
    }

    @Test
    void malformedWriterBindingIsA400BeforeTheServiceRuns() throws Exception {
        // Missing writerId: the declared @NotBlank must answer 400, not reach
        // the writer-fencing path (which would NPE into a 500 internal_error).
        String create = "{\"workspaceId\":\"workspace-a\",\"writerGeneration\":1,"
                + "\"definition\":{\"cron\":\"*/5 * * * *\",\"prompt\":\"/loop check\","
                + "\"session_mode\":\"persistent\"}}";
        mvc.perform(post("/internal/managed-session-store/v1/sessions/session/automations:create")
                        .header("X-Qwen-Tenant-Id", "tenant")
                        .header("X-Qwen-Managed-Writer-Token", "synthetic-writer")
                        .header("Idempotency-Key", "loop:call-3:create")
                        .contentType(MediaType.APPLICATION_JSON).content(create))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("invalid_request"));
        // Blank writerId on retire: same validation, same refusal shape.
        String retire = "{\"workspaceId\":\"workspace-a\",\"writerId\":\"  \","
                + "\"writerGeneration\":1,\"automationId\":\"asch_abc\"}";
        mvc.perform(post("/internal/managed-session-store/v1/sessions/session/automations:retire")
                        .header("X-Qwen-Tenant-Id", "tenant")
                        .header("X-Qwen-Managed-Writer-Token", "synthetic-writer")
                        .header("Idempotency-Key", "loop:call-3:retire")
                        .contentType(MediaType.APPLICATION_JSON).content(retire))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("invalid_request"));
        verifyNoInteractions(service);
    }
}
