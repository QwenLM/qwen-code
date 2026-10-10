package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.service.ManagedArtifactPolicy;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

@Configuration
public class ManagedArtifactConfiguration {
    @Bean
    @ConditionalOnMissingBean(name = "taskScheduler")
    public ThreadPoolTaskScheduler taskScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.build();
    }

    @Bean
    public ThreadPoolTaskScheduler managedArtifactScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("managed-artifact-").build();
    }

    /**
     * The materialization tick runs blocking JDBC, so it must never share
     * the one-thread default pool.
     */
    @Bean
    public ThreadPoolTaskScheduler managedMaterializationScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("managed-materialization-").build();
    }

    /**
     * The automation scanner relays each fire to the Hosted Harness over
     * blocking HTTP (up to the Harness request timeout per call), so it must
     * not share the one-thread default pool with the message materializer
     * and the dispatch and lifecycle recovery ticks.
     */
    @Bean
    public ThreadPoolTaskScheduler managedAutomationScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("managed-automation-").build();
    }

    /**
     * The replay-floor pass's own tick: a first pass after an operator opts
     * in drains every Session with a Snapshot, which on a large deployment
     * takes minutes, and on the shared one-thread default taskScheduler it
     * would hold off the message materializer and every recovery tick for
     * that long.
     */
    @Bean
    public ThreadPoolTaskScheduler replayFloorScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("replay-floor-").build();
    }

    /**
     * The child result relay's own tick: the shared default taskScheduler
     * also runs every sibling recovery, and this page's sequential
     * harness calls would stall all of theirs behind one slow Session.
     * Unconditional — the @Scheduled wiring binds by name at context
     * refresh whether or not the broker lane is on.
     */
    @Bean
    public ThreadPoolTaskScheduler childRelayScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("child-relay-").build();
    }

    /**
     * The recovery tick runs blocking JDBC, so it must never share the
     * one-thread default pool. Gated exactly like the Broker bean that carries
     * the tick: a deployment with the Broker off must not pay for an idle
     * scheduler thread.
     */
    @Bean
    @ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
            name = "enabled", havingValue = "true")
    public ThreadPoolTaskScheduler runtimeRecoveryScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("runtime-recovery-").build();
    }

    @Bean
    @ConditionalOnMissingBean(ManagedArtifactPolicy.class)
    public ManagedArtifactPolicy managedArtifactPolicy(ManagedAgentProperties properties) {
        var settings = properties.getArtifacts();
        return new ManagedArtifactPolicy() {
            public String version() {
                return "o3-v1:" + settings.isEnabled() + ":" + settings.isPublishOriginal() + ":"
                        + settings.isPublishPreview();
            }

            public boolean publishOriginal(String tenantId, String workspaceId,
                    String sessionId) {
                return settings.isEnabled() && settings.isPublishOriginal();
            }

            public boolean publishPreview(String tenantId, String workspaceId,
                    String sessionId) {
                return publishOriginal(tenantId, workspaceId, sessionId)
                        && settings.isPublishPreview();
            }

            public boolean readOriginal(String tenantId, String actorId,
                    String workspaceId, String sessionId) {
                return actorId != null && !actorId.isBlank()
                        && publishOriginal(tenantId, workspaceId, sessionId);
            }
        };
    }
}
