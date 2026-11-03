package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ManagedArtifactPolicy;
import com.alibaba.qwen.code.managedagent.event.MessageMaterializer;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

import java.util.concurrent.ScheduledFuture;

@Configuration
public class ManagedArtifactConfiguration {
    @Bean(defaultCandidate = false)
    public ThreadPoolTaskScheduler managedAgentScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.threadNamePrefix("managed-agent-").build();
    }

    @Bean(defaultCandidate = false)
    public ThreadPoolTaskScheduler managedArtifactScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("managed-artifact-").build();
    }

    /**
     * The automation scanner relays each fire to the Hosted Harness over
     * blocking HTTP (up to the Harness request timeout per call), so it must
     * not share the one-thread default pool with the message materializer
     * and the dispatch and lifecycle recovery ticks.
     */
    @Bean(defaultCandidate = false)
    public ThreadPoolTaskScheduler managedAutomationScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("managed-automation-").build();
    }

    /**
     * The automation scanner's row pool (#15418): a scan tick submits one
     * task per candidate row and joins them before returning, so the tick
     * holds the scheduler's thread for the whole pass. That is why this is
     * a second bean — scanning on its own `managedAutomationScheduler`
     * would deadlock the tick on the pool's only thread, and a bigger
     * scheduler pool would park a thread per pending join. Pool shutdown
     * never interrupts row tasks, but does not wait for their completion or
     * guarantee it before JVM exit. Claims are durable and later ticks
     * re-drive a lost answer. A tick caught mid-join is still bounded by the
     * application's shutdown phase.
     */
    @Bean(defaultCandidate = false)
    public ThreadPoolTaskExecutor automationScannerExecutor(
            ManagedAgentProperties properties) {
        // With automation off the positive-count validation stays out, so a
        // dormant value must still boot: the JDK refuses a 0-size pool, and
        // the pool goes unused while the scanner is off.
        int threads = Math.max(1, properties.getAutomation()
                .getScannerThreads());
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(threads);
        executor.setMaxPoolSize(threads);
        executor.setThreadNamePrefix("automation-scan-");
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(0);
        return executor;
    }

    /**
     * The replay-floor pass's own tick: a first pass after an operator opts
     * in drains every Session with a Snapshot, which on a large deployment
     * takes minutes, and on the shared one-thread default taskScheduler it
     * would hold off the message materializer and every recovery tick for
     * that long.
     */
    @Bean(defaultCandidate = false)
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
    @Bean(defaultCandidate = false)
    public ThreadPoolTaskScheduler childRelayScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("child-relay-").build();
    }

    /**
     * The session message relay's own tick (H4d-b): like the child result
     * relay, its page runs sequential harness calls on two Sessions per
     * message, which must stall neither that relay nor the recoveries.
     */
    @Bean(defaultCandidate = false)
    public ThreadPoolTaskScheduler messageRelayScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("message-relay-").build();
    }

    @Bean(defaultCandidate = false)
    public ThreadPoolTaskScheduler wakeRecoveryScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("wake-recovery-").build();
    }

    /**
     * The child Workspace scan's own tick (#13753 I1): its steps run Git
     * for up to the Git timeout each, which must stall neither the relay
     * nor the shared recoveries.
     */
    @Bean(defaultCandidate = false)
    public ThreadPoolTaskScheduler childWorkspaceScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("child-workspace-").build();
    }

    @Bean
    public ThreadPoolTaskScheduler sessionWorktreeScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("session-worktree-").build();
    }

    /**
     * The 100 ms materialize pass runs sequential JDBC transactions; sharing
     * the one-thread default scheduler would delay turn recovery by a whole
     * pass whenever a materialization stalls.
     */
    @Bean(defaultCandidate = false)
    public ThreadPoolTaskScheduler messageMaterializerScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("message-materialize-").build();
    }

    // The cadence is the typed Events.materializeInterval field, bound from
    // qwen.managed-agent.events.materialize-interval (application.yml ships
    // '100ms') with a 100 ms field default for property-less boots — one
    // driving source, no annotation placeholder to drift from.
    @Bean(destroyMethod = "cancel")
    public ScheduledFuture<?> messageMaterializerTask(
            @Qualifier("messageMaterializerScheduler")
                    ThreadPoolTaskScheduler messageMaterializerScheduler,
            MessageMaterializer materializer,
            ManagedAgentProperties properties) {
        return messageMaterializerScheduler.scheduleWithFixedDelay(
                materializer::materialize,
                properties.getEvents().getMaterializeInterval());
    }

    /**
     * The recovery tick runs blocking JDBC, so it must never share the
     * one-thread default pool. Gated exactly like the Broker bean that carries
     * the tick: a deployment with the Broker off must not pay for an idle
     * scheduler thread.
     */
    @Bean(defaultCandidate = false)
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
                return StringUtils.isNotBlank(actorId)
                        && publishOriginal(tenantId, workspaceId, sessionId);
            }
        };
    }
}
