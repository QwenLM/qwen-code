package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;

import javax.sql.DataSource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class HostedCleanupRetentionMySqlIT extends HostedCleanupRetentionTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Test
    @Timeout(60)
    void cleanupAdmissionConflictIsReturnedOverHttpOnMySql() throws Exception {
        assertCollected();
        var before = journalState();
        var json = new ObjectMapper();
        var request = cleanupRequest("late-http", "prompt", "owed");
        try (var spring = (ServletWebServerApplicationContext) new SpringApplicationBuilder(
                ManagedAgentServerApplication.class).run(
                "--server.address=127.0.0.1", "--server.port=0",
                "--spring.datasource.url=" + database.url(),
                "--spring.datasource.username=" + System.getProperty("mysql.user"),
                "--spring.datasource.password=" + System.getProperty("mysql.password", ""),
                "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                "--qwen.managed-agent.session-store.enabled=true",
                "--qwen.managed-agent.harness.enabled=false",
                "--qwen.managed-agent.runtime-broker.enabled=false");
                var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build()) {
            for (String route : List.of("transactions:commit", "transactions:commit-v2")) {
                var response = client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:"
                                + spring.getWebServer().getPort()
                                + "/internal/managed-session-store/v1/sessions/harness/" + route))
                        .timeout(Duration.ofSeconds(10))
                        .header("Content-Type", "application/json")
                        .header(TenantContextFilter.HEADER, "tenant")
                        .header(ManagedSessionStoreModels.WRITER_TOKEN_HEADER, ExtensionRecordJournal.TOKEN)
                        .header("X-Qwen-Managed-Max-Readable-Storage-Version", "2")
                        .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(request))).build(),
                        HttpResponse.BodyHandlers.ofString());
                assertThat(response.statusCode()).as(route).isEqualTo(409);
                assertThat(json.readTree(response.body()).path("error").path("code").asText())
                        .as(route).isEqualTo("managed_session_cleanup_conflict");
                assertThat(journalState()).as(route).isEqualTo(before);
                System.out.println("HOSTED_CLEANUP_HTTP_PROBE route=" + route
                        + " status=409 code=managed_session_cleanup_conflict journal_unchanged=true");
            }
        }
    }

    @Override
    @Test
    @Timeout(60)
    void committedCleanupProtectsBindingFromSweepWaitingForPlacement() throws Exception {
        super.committedCleanupProtectsBindingFromSweepWaitingForPlacement();
    }

    @Override
    @Test
    @Timeout(60)
    void owedCleanupPreservesExactReleasedOwnerAcrossSweepAndReopen() {
        super.owedCleanupPreservesExactReleasedOwnerAcrossSweepAndReopen();
    }

    @Override
    @Test
    @Timeout(60)
    void oneConfirmationCannotReleaseAnotherCleanupDebt() {
        super.oneConfirmationCannotReleaseAnotherCleanupDebt();
    }

    @Override
    @Test
    @Timeout(60)
    void rollbackKeepsTheJournalAndItsCleanupProjectionAtomic() {
        super.rollbackKeepsTheJournalAndItsCleanupProjectionAtomic();
    }

    @Override
    @Test
    @Timeout(60)
    void unverifiedHistoricalJournalRetainsItsBindingWithoutRestamping() {
        super.unverifiedHistoricalJournalRetainsItsBindingWithoutRestamping();
    }

    @Override
    @Test
    @Timeout(60)
    void sharedBindingRetainsItsOriginalSessionUntilCleanupConfirmation() {
        super.sharedBindingRetainsItsOriginalSessionUntilCleanupConfirmation();
    }

    @Override
    @Test
    @Timeout(60)
    void cleanupIdentityCannotChangeItsDescriptor() {
        super.cleanupIdentityCannotChangeItsDescriptor();
    }

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @AfterEach
    void cleanupDatabase() {
        if (database != null) {
            database.close();
        }
    }
}
