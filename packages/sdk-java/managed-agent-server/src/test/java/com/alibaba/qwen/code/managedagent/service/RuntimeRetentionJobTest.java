package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.RuntimeRetentionConfiguration;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeRetention;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

class RuntimeRetentionJobTest {
    @Test
    void failureKeepsTheContinuationAndNextTickRetriesIt() {
        var retention = mock(JdbcRuntimeRetention.class);
        var cursor = mock(JdbcRuntimeRetention.Cursor.class);
        var page = mock(JdbcRuntimeRetention.BatchResult.class);
        when(page.cursor()).thenReturn(cursor);
        var end = mock(JdbcRuntimeRetention.BatchResult.class);
        when(retention.sweep(eq(Duration.ofDays(30)), eq(100), isNull())).thenReturn(page);
        when(retention.sweep(Duration.ofDays(30), 100, cursor))
                .thenThrow(new IllegalStateException("database unavailable")).thenReturn(end);
        var job = new RuntimeRetentionJob(retention, new ManagedAgentProperties());
        assertThat(job.runOnce()).isSameAs(page);
        assertThatCode(job::tick).doesNotThrowAnyException();
        assertThat(job.runOnce()).isSameAs(end);
        assertThat(job.runOnce()).isSameAs(page);
        verify(retention, times(2)).sweep(Duration.ofDays(30), 100, cursor);
        verify(retention, times(2)).sweep(Duration.ofDays(30), 100, null);
    }

    @Test
    void blockedRetentionDoesNotStallRecoveryOrDefaultScheduledWork() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var ordinary = new CountDownLatch(1);
        var recovery = new CountDownLatch(1);
        var retention = mock(JdbcRuntimeRetention.class);
        when(retention.sweep(any(), anyInt(), any())).thenAnswer(invocation -> {
            entered.countDown();
            assertThat(release.await(5, TimeUnit.SECONDS)).isTrue();
            return mock(JdbcRuntimeRetention.BatchResult.class);
        });
        try (var context = new AnnotationConfigApplicationContext()) {
            context.register(Scheduling.class);
            context.registerBean("runtimeRetentionScheduler", ThreadPoolTaskScheduler.class,
                    () -> new RuntimeRetentionConfiguration().runtimeRetentionScheduler(new ThreadPoolTaskSchedulerBuilder()));
            context.registerBean("taskScheduler", ThreadPoolTaskScheduler.class,
                    () -> new ThreadPoolTaskSchedulerBuilder().poolSize(1).build());
            context.registerBean("runtimeRecoveryScheduler", ThreadPoolTaskScheduler.class,
                    () -> new ThreadPoolTaskSchedulerBuilder().poolSize(1).build());
            context.registerBean(RuntimeRetentionJob.class, () -> new RuntimeRetentionJob(retention, new ManagedAgentProperties()));
            context.registerBean(Probe.class, () -> new Probe(entered, ordinary, recovery));
            try {
                context.refresh();
                assertThat(entered.await(3, TimeUnit.SECONDS)).isTrue();
                assertThat(ordinary.await(2, TimeUnit.SECONDS)).isTrue();
                assertThat(recovery.await(2, TimeUnit.SECONDS)).isTrue();
            } finally {
                release.countDown();
            }
        }
    }

    @Configuration(proxyBeanMethods = false)
    @EnableScheduling
    static class Scheduling { }

    static class Probe {
        private final CountDownLatch entered;
        private final CountDownLatch ordinary;
        private final CountDownLatch recovery;

        Probe(CountDownLatch entered, CountDownLatch ordinary, CountDownLatch recovery) {
            this.entered = entered;
            this.ordinary = ordinary;
            this.recovery = recovery;
        }

        @Scheduled(fixedDelay = 10)
        public void ordinary() {
            if (entered.getCount() == 0) { ordinary.countDown(); }
        }

        @Scheduled(fixedDelay = 10, scheduler = "runtimeRecoveryScheduler")
        public void recovery() {
            if (entered.getCount() == 0) { recovery.countDown(); }
        }
    }
}
