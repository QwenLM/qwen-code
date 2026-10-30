package com.alibaba.qwen.code.managedagent;

import org.junit.jupiter.api.Test;
import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder;
import org.junit.platform.launcher.core.LauncherFactory;
import org.junit.platform.launcher.listeners.SummaryGeneratingListener;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.platform.engine.discovery.DiscoverySelectors.selectClass;

class HostedMySqlIsolationActivationTest {
    // The probe fails only if service discovery, autodetection and the
    // configuration parameter all reach the extension. Without mysql.url the
    // extension throws before touching a database.
    @Test
    void theHostedProfileArmsTheExtensionThroughServiceDiscovery() {
        String originalUrl = System.getProperty("mysql.url");
        System.clearProperty("mysql.url");
        try {
            var request = LauncherDiscoveryRequestBuilder.request()
                    .selectors(selectClass(Probe.class))
                    .configurationParameter("junit.jupiter.extensions.autodetection.enabled", "true")
                    .configurationParameter(HostedMySqlIsolationExtension.ENABLED, "true")
                    .build();
            var summary = new SummaryGeneratingListener();
            LauncherFactory.create().execute(request, summary);

            assertThat(summary.getSummary().getFailures())
                    .anySatisfy(failure -> assertThat(failure.getException())
                            .isInstanceOf(IllegalArgumentException.class)
                            .hasMessage("Hosted isolation requires a disposable mysql.url"
                                    + " and mysql.user"));
        } finally {
            if (originalUrl != null) {
                System.setProperty("mysql.url", originalUrl);
            }
        }
    }

    static class Probe {
        @Test
        void bodyNeverRuns() {
        }
    }
}
