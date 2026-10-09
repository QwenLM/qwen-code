package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import java.nio.charset.StandardCharsets;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * The claimed-commit dispatch gate: the parent's own lifecycle cleanup
 * families are lifecycle work, never new ordinary work. Hook domains keep
 * hook-chain analysis; unrelated domains stay admission-closed.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:lifecycle-gate;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class ManagedExtensionRecordLifecycleGateTest {
    private static final String TENANT = "tenant-gate";

    @Autowired
    private ManagedExtensionRecordStore records;

    private static final ObjectMapper JSON = new ObjectMapper();

    /** One committed-domain event line, exactly as the journal would carry. */
    private static String domainEvent(String domain) {
        var payload = JSON.createObjectNode().put("domain", domain);
        payload.putObject("recordRef").put("resourceId", "ref-" + domain);
        var event = JSON.createObjectNode();
        event.putObject("managedSession").put("kind", "domain.committed")
                .set("payload", payload);
        return event.toString();
    }

    /** input.accepted is ordinary-new work and stays fenced, claim or not. */
    @Test
    void keepsOrdinaryNewWorkAdmissionClosed() {
        byte[] ordinary = ("{\"managedSession\":{\"kind\":\"input.accepted\","
                + "\"payload\":{\"turnId\":\"turn-1\"}}}")
                .getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> records.hasNewLifecycleDispatch(TENANT,
                "session", ordinary, resourceId -> null))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertThat(error.getCode())
                                .isEqualTo("workspace_lifecycle_admission_closed"));
    }

    @Test
    void admitsTheParentsOwnChildCleanupFamilies() {
        byte[] cleanup = (domainEvent("child_run") + "\n"
                + domainEvent("child_acceptance"))
                .getBytes(StandardCharsets.UTF_8);
        assertThat(records.hasNewLifecycleDispatch(TENANT, "session",
                cleanup, resourceId -> null)).isFalse();
    }

    @Test
    void keepsUnrelatedDomainsAdmissionClosed() {
        byte[] foreign = domainEvent("monitor_run")
                .getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> records.hasNewLifecycleDispatch(TENANT,
                "session", foreign, resourceId -> null))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertThat(error.getCode())
                                .isEqualTo("workspace_lifecycle_admission_closed"));
    }

    /** Hook domains never lose their chain analysis at the same gate. */
    @Test
    void hookDomainsStillDriveTheChainAnalysis() {
        byte[] hook = domainEvent("hook_execution")
                .getBytes(StandardCharsets.UTF_8);
        // The analysis reaches for the hook body's resource before it can
        // decide — a missing one must surface, proving no child-style skip.
        assertThatThrownBy(() -> records.hasNewLifecycleDispatch(TENANT,
                "session", hook, resourceId -> null))
                .isInstanceOfSatisfying(Exception.class, error -> assertThat(
                        error.getMessage()).isNotNull());
    }
}
