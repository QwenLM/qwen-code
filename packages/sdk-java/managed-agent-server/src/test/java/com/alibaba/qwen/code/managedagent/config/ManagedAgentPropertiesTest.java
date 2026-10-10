package com.alibaba.qwen.code.managedagent.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import com.alibaba.qwen.code.managedagent.service.ActionResponseCoordinator;
import com.alibaba.qwen.code.managedagent.service.ChildResultRelay;
import com.alibaba.qwen.code.managedagent.service.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.service.MessageMaterializer;
import com.alibaba.qwen.code.managedagent.service.SessionLifecycleCoordinator;
import com.alibaba.qwen.code.managedagent.store.ManagedToolResultProjector;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.Scheduled;

class ManagedAgentPropertiesTest {
    private static final String DURABLE_KEY = "qwen.managed-agent.runtime-broker.durable-local-process";
    private static final String TRUSTED_KEY =
            "qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery";

    @Test
    void applicationYmlBindsTheDurableAndTrustedDefaults() throws java.io.IOException {
        var values = applicationYmlValues();
        // The named contract itself: reverting either fallback flips the
        // binding below red; renaming or typoing either variable shows up here.
        assertThat(values).containsEntry(DURABLE_KEY,
                "${QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS:true}");
        assertThat(values).containsEntry(TRUSTED_KEY,
                "${QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY:true}");
        new ApplicationContextRunner()
                .withPropertyValues(
                        DURABLE_KEY + "=" + values.get(DURABLE_KEY),
                        TRUSTED_KEY + "=" + values.get(TRUSTED_KEY))
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    var broker = started.getBean(ManagedAgentProperties.class)
                            .getRuntimeBroker();
                    assertThat(broker.isDurableLocalProcess()).isTrue();
                    assertThat(broker.isTrustedLocalRebootRecovery()).isTrue();
                });
    }

    @Test
    void theDocumentedEnvNamesOverrideTheYmlDefaults() throws java.io.IOException {
        var values = applicationYmlValues();
        var ambient = new java.util.LinkedHashMap<String, Object>();
        System.getenv().forEach((name, value) -> {
            if (!"QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS".equals(name)
                    && !"QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY".equals(name)) {
                ambient.put(name, value);
            }
        });
        ambient.put("QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS", "false");
        ambient.put("QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY", "false");
        new ApplicationContextRunner()
                .withPropertyValues(
                        DURABLE_KEY + "=" + values.get(DURABLE_KEY),
                        TRUSTED_KEY + "=" + values.get(TRUSTED_KEY))
                .withInitializer(ctx -> ctx.getEnvironment().getPropertySources().replace(
                        "systemEnvironment",
                        new org.springframework.core.env.MapPropertySource("systemEnvironment", ambient)))
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    var broker = started.getBean(ManagedAgentProperties.class)
                            .getRuntimeBroker();
                    assertThat(broker.isDurableLocalProcess()).isFalse();
                    assertThat(broker.isTrustedLocalRebootRecovery()).isFalse();
                });
    }

    private static java.util.Map<String, Object> applicationYmlValues() throws java.io.IOException {
        var loaded = new org.springframework.boot.env.YamlPropertySourceLoader().load(
                "application.yml",
                new org.springframework.core.io.ClassPathResource("application.yml"));
        var values = new java.util.LinkedHashMap<String, Object>();
        for (var source : loaded) {
            var enumerable = (org.springframework.core.env.EnumerablePropertySource<?>) source;
            for (String name : enumerable.getPropertyNames()) {
                values.put(name, enumerable.getProperty(name));
            }
        }
        return values;
    }

    // The only fields whose declared unit is MILLIS; every other Duration
    // field binds suffix-less numbers as seconds.
    private static final java.util.Set<String> MILLIS_BINDINGS =
            java.util.Set.of(
                    "Auth.allowedDrift",
                    "Events.batchInterval",
                    "Events.materializeInterval",
                    "RuntimeBroker.childWorkspaceGitTimeout",
                    "Automation.scanDelay",
                    "Automation.lease",
                    "Automation.lateTolerance",
                    "Automation.lookback");

    @Test
    void everyDurationFieldDeclaresABindingUnit() {
        // A unit-less numeric override binds as milliseconds unless the
        // field declares its unit; this pin keeps the sweep complete for
        // future fields too. getDeclaredClasses() sees direct members only,
        // so walk the graph transitively, starting at the outer class
        // itself (a top-level Duration, or one on a depth-2 type such as
        // RuntimeBroker.WorkspaceMount, must not slip the sweep).
        var pending = new java.util.ArrayDeque<Class<?>>();
        var seen = java.util.Collections.newSetFromMap(
                new java.util.IdentityHashMap<Class<?>, Boolean>());
        var visited = new java.util.LinkedHashSet<String>();
        pending.add(ManagedAgentProperties.class);
        while (!pending.isEmpty()) {
            Class<?> current = pending.removeFirst();
            if (!seen.add(current)) {
                continue;
            }
            for (java.lang.reflect.Field field : current
                    .getDeclaredFields()) {
                if (field.getType() == java.time.Duration.class) {
                    // Presence is not enough — the declared VALUE is the
                    // binding contract, so each field is pinned against the
                    // table: only the documented millisecond
                    // exceptions expect MILLIS, and flipping
                    // SessionStore.writerLeaseDuration to MILLIS goes red.
                    String name = current.getSimpleName() + "."
                            + field.getName();
                    visited.add(name);
                    var unit = field.getAnnotation(
                            org.springframework.boot.convert.DurationUnit.class);
                    assertThat(unit).as(name).isNotNull();
                    assertThat(unit.value()).as(name).isEqualTo(
                            MILLIS_BINDINGS.contains(name)
                                    ? java.time.temporal.ChronoUnit.MILLIS
                                    : java.time.temporal.ChronoUnit.SECONDS);
                }
            }
            pending.addAll(java.util.List.of(current.getDeclaredClasses()));
        }
        // The walk must not pass vacuously: extracting a group out of
        // the properties class empties it and the millisecond
        // exceptions would go unchecked. 32 is the current field
        // inventory — update it in the same change that adds or
        // removes a Duration field.
        assertThat(visited).containsAll(MILLIS_BINDINGS).hasSize(32);
    }

    @Test
    void unitLessNumericOverridesBindInTheDeclaredUnit() {
        // Without @DurationUnit this binds PT0.12S — a 120 ms lease renewed
        // every 20 s invites double execution. The v3 result window is the
        // documented case: a stale milliseconds-style 1800000 meant as 30
        // minutes binds as PT500H, so the suffix is mandatory.
        // Auth.allowedDrift declares MILLIS on purpose: a suffix-less
        // override must keep binding milliseconds — 120000 reads as PT2M,
        // where a SECONDS flip would widen the signature-replay window to
        // PT33H20M and still pass the 1s floor, so this arm goes red if
        // the field flips. Every value here differs from its field
        // default, so a property that silently stops binding goes red too.
        new ApplicationContextRunner()
                .withPropertyValues(
                        "qwen.managed-agent.dispatch.lease-duration=120",
                        "qwen.managed-agent.runtime-broker.v3-result-window=1800000",
                        "qwen.managed-agent.auth.allowed-drift=120000",
                        "qwen.managed-agent.events.materialize-interval=250",
                        "qwen.managed-agent.events.batch-interval=150")
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    assertThat(started.getBean(ManagedAgentProperties.class)
                            .getDispatch().getLeaseDuration())
                            .isEqualTo(java.time.Duration.ofSeconds(120));
                    assertThat(started.getBean(ManagedAgentProperties.class)
                            .getRuntimeBroker().getV3ResultWindow())
                            .isEqualTo(java.time.Duration.ofSeconds(1_800_000));
                    assertThat(started.getBean(ManagedAgentProperties.class)
                            .getAuth().getAllowedDrift())
                            .isEqualTo(java.time.Duration.ofMinutes(2));
                    assertThat(started.getBean(ManagedAgentProperties.class)
                            .getEvents().getMaterializeInterval())
                            .isEqualTo(java.time.Duration.ofMillis(250));
                    assertThat(started.getBean(ManagedAgentProperties.class)
                            .getEvents().getBatchInterval())
                            .isEqualTo(java.time.Duration.ofMillis(150));
                });
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aMillisecondScaleOverrideWarnsAtStartup(CapturedOutput output) {
        // A bare 1800000 meant as 30 minutes in milliseconds binds PT500H
        // under the seconds convention — the stale-override signature the
        // startup warning names.
        new ApplicationContextRunner()
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    assertThat(output).doesNotContain(
                            "qwen.managed-agent.harness.turn-deadline");
                });
        new ApplicationContextRunner()
                .withPropertyValues(
                        "qwen.managed-agent.harness.turn-deadline=1800000")
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    assertThat(output).contains(
                            "qwen.managed-agent.harness.turn-deadline");
                });
        // A stale 600000 (10 minutes in milliseconds) for the approval
        // timeout is past the 24h range ceiling, so the sweep runs first
        // and the boot still fails with the range message.
        new ApplicationContextRunner()
                .withPropertyValues(
                        "qwen.managed-agent.harness.approval-timeout=600000")
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(failed -> {
                    assertThat(failed).hasFailed()
                            .getFailure().hasRootCauseMessage(
                                    "Hosted approval timeout must be between"
                                            + " 1s and 24h; a suffix-less"
                                            + " number binds as seconds, so"
                                            + " write 300s rather than"
                                            + " 300000");
                    assertThat(output).contains(
                            "qwen.managed-agent.harness.approval-timeout");
                });
        // A stale 300000 (5 minutes in milliseconds) binds PT83H20M: past
        // the 24h ceiling, so the boot refuses and the message itself must
        // carry the unit convention.
        new ApplicationContextRunner()
                .withPropertyValues(
                        "qwen.managed-agent.harness.approval-timeout=300000")
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(failed -> {
                    assertThat(failed).hasFailed()
                            .getFailure().hasRootCauseMessage(
                                    "Hosted approval timeout must be between"
                                            + " 1s and 24h; a suffix-less"
                                            + " number binds as seconds, so"
                                            + " write 300s rather than"
                                            + " 300000");
                });
        // The required publication deadlines ship no default to compare
        // against; a bare value warns on its written shape like any other.
        new ApplicationContextRunner()
                .withPropertyValues(
                        "qwen.managed-agent.tool-publication.operation-timeout=1800000")
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    assertThat(output).contains(
                            "qwen.managed-agent.tool-publication.operation-timeout");
                });
        // The mirror band: a bare 30 meant as minutes binds PT30S, 60x
        // below the 30m default — the direction that settles slow v3 tool
        // results UNKNOWN.
        new ApplicationContextRunner()
                .withPropertyValues(
                        "qwen.managed-agent.runtime-broker.v3-result-window=30")
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    assertThat(output).contains(
                            "qwen.managed-agent.runtime-broker.v3-result-window");
                });
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void theUnitSweepKeysOnTheWrittenShapeNotTheMagnitude(
            CapturedOutput output) {
        // 600000 binds PT166H40M — only ~333x the 30m default, inside no
        // magnitude band, so the written shape is the only signal that
        // names it stale.
        new ApplicationContextRunner()
                .withPropertyValues(
                        "qwen.managed-agent.harness.turn-deadline=600000")
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    assertThat(output).contains(
                            "qwen.managed-agent.harness.turn-deadline=600000");
                });
        // Suffixed overrides never warn, however far below the default
        // they land — these are this repository's own E2E failover
        // settings, which the mirror band used to warn on.
        new ApplicationContextRunner()
                .withPropertyValues(
                        "qwen.managed-agent.dispatch.lease-duration=2s",
                        "qwen.managed-agent.dispatch.lease-renew-interval=500ms",
                        "qwen.managed-agent.session-store.writer-lease-duration=1s")
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    assertThat(output).doesNotContain(
                            "qwen.managed-agent.dispatch.lease-duration");
                    assertThat(output).doesNotContain(
                            "qwen.managed-agent.dispatch.lease-renew-interval");
                    assertThat(output).doesNotContain(
                            "qwen.managed-agent.session-store.writer-lease-duration");
                });
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aZeroOverrideStaysOutsideTheSweep(CapturedOutput output) {
        // PT0S is the documented per-chunk / per-event re-verification
        // setting; the sweep must never name it.
        new ApplicationContextRunner()
                .withPropertyValues(
                        "qwen.managed-agent.artifacts.read-revalidation-interval=0s",
                        "qwen.managed-agent.events.read-grant-recheck-interval=0s")
                .withUserConfiguration(PropertiesConfiguration.class)
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    assertThat(output).doesNotContain(
                            "read-revalidation-interval");
                    assertThat(output).doesNotContain(
                            "read-grant-recheck-interval");
                });
        // With no Environment the magnitude bands are the fallback, and
        // PT0S satisfies 0 <= default / 10 — only the zero guard keeps it
        // out of the mirror band.
        ManagedAgentProperties plain = new ManagedAgentProperties();
        plain.getArtifacts().setReadRevalidationInterval(
                java.time.Duration.ZERO);
        plain.getEvents().setReadGrantRecheckInterval(
                java.time.Duration.ZERO);
        plain.validateWorkspaceFiles();
        assertThat(output).doesNotContain("read-revalidation-interval");
        assertThat(output).doesNotContain("read-grant-recheck-interval");
    }

    @Test
    void materializeIntervalDrivesTheScheduledCadence() throws java.io.IOException {
        // The typed field is the cadence's only driving source:
        // ManagedArtifactConfiguration.messageMaterializerTask schedules
        // the pass with it on the dedicated single-thread scheduler, and a
        // property-less boot keeps the shipped 100 ms default.
        assertThat(new ManagedAgentProperties().getEvents()
                .getMaterializeInterval())
                .isEqualTo(java.time.Duration.ofMillis(100));
        // A property-less boot never sees the yml, so pin the shipped
        // entry too — it, not the field default, is the deployed
        // cadence.
        assertThat(applicationYmlValues()).containsEntry(
                "qwen.managed-agent.events.materialize-interval", "100ms");
        // An empty fragment matches every schedule attribute on every
        // declared method, so any reintroduced @Scheduled — package-private
        // or repeated — fails here.
        assertThat(schedulesOn(MessageMaterializer.class, "")).isEmpty();
    }

    @Test
    void theProjectionIntervalTicksOnTheArtifactScheduler() {
        // The README's projection-interval row publishes the :1000 fallback
        // as a 1s cadence; @Scheduled reads a bare number as timeUnit() —
        // milliseconds by default — so the placeholder, the scheduler
        // qualifier and the unit are pinned together: adding
        // timeUnit = SECONDS stretches the pass to ~17 minutes and must go
        // red here.
        var schedules = schedulesOn(ManagedToolResultProjector.class,
                "artifacts.projection-interval");
        assertThat(schedules).hasSize(1).allSatisfy(scheduled -> {
            assertThat(scheduled.fixedDelayString()).isEqualTo(
                    "${qwen.managed-agent.artifacts.projection-interval:1000}");
            assertThat(scheduled.scheduler()).isEqualTo(
                    "managedArtifactScheduler");
            assertThat(scheduled.timeUnit())
                    .isEqualTo(TimeUnit.MILLISECONDS);
        });
    }

    @Test
    void theChildRelayScanDelayReadsBareNumbersAsMilliseconds() {
        // The third @Scheduled placeholder cadence the README's unit
        // rule names: it has no typed field, so the annotation fallback
        // is the deployed default and the startup sweep can never see
        // an override — placeholder, dedicated scheduler and the
        // millisecond timeUnit are pinned together.
        var schedules = schedulesOn(ChildResultRelay.class,
                "child-relay.scan-delay");
        assertThat(schedules).hasSize(1).allSatisfy(scheduled -> {
            assertThat(scheduled.fixedDelayString()).isEqualTo(
                    "${qwen.managed-agent.child-relay.scan-delay:2s}");
            assertThat(scheduled.scheduler()).isEqualTo(
                    "childRelayScheduler");
            assertThat(scheduled.timeUnit())
                    .isEqualTo(TimeUnit.MILLISECONDS);
        });
    }

    @Test
    void theThreeScanDelaySchedulesShareOneFallback() throws java.io.IOException {
        // The Dispatch comment claims the three sites read the identical
        // "${...scan-delay:1s}" placeholder; only this pin keeps the claim
        // true when one fallback is retuned without the others. The unit
        // is half of the claim: @Scheduled reads a bare number as
        // timeUnit() — milliseconds by default — so these placeholders
        // deliberately did not move to seconds with the typed Duration
        // fields, and a one-sided timeUnit change turns this red too.
        // hasSize(1) is load-bearing: getDeclaredMethods() order is
        // unspecified, so a second scan-delay sweep on one coordinator
        // must fail here, not slip past a sampled first match.
        String expected = "${qwen.managed-agent.dispatch.scan-delay:1s}";
        // application.yml supplies the key in a packaged server, making
        // the annotation fallback inert there — pin the shipped value
        // the Dispatch comment names as the deployed default.
        assertThat(applicationYmlValues()).containsEntry(
                "qwen.managed-agent.dispatch.scan-delay", "1s");
        for (Class<?> coordinator : List.of(ActionResponseCoordinator.class,
                HarnessCoordinator.class, SessionLifecycleCoordinator.class)) {
            assertThat(schedulesOn(coordinator, "dispatch.scan-delay"))
                    .as(coordinator.getSimpleName())
                    .hasSize(1)
                    .allSatisfy(scheduled -> {
                        assertThat(scheduled.fixedDelayString())
                                .isEqualTo(expected);
                        assertThat(scheduled.timeUnit())
                                .isEqualTo(TimeUnit.MILLISECONDS);
                    });
        }
    }

    @Test
    void theReadmeNamesEveryPlaceholderOnlyCadence() throws Exception {
        // The README's unit rule names the cadences that live only in
        // @Scheduled placeholders. A hand-maintained list goes stale the
        // next time the base adds one — it already falsified the sentence
        // once — so pin the sentence against a sweep of every
        // ${qwen.managed-agent.*} schedule placeholder in the module: a
        // cadence with no typed Duration field belongs in it (the startup
        // warning cannot see it), and a typed one such as
        // channels.scan-delay does not (the warning reads the field's
        // written value, so the sentence would be false for it). The
        // exact swept set is pinned too: a new placeholder cadence fails
        // here until the README and this set are updated in the same
        // change.
        var swept = new java.util.TreeSet<String>();
        var placeholder = java.util.regex.Pattern.compile(
                "\\$\\{(qwen\\.managed-agent\\.[^}:]+)");
        for (Class<?> owner : moduleClasses()) {
            for (java.lang.reflect.Method method
                    : owner.getDeclaredMethods()) {
                for (Scheduled scheduled
                        : method.getAnnotationsByType(Scheduled.class)) {
                    for (String attribute : new String[] {
                            scheduled.fixedDelayString(),
                            scheduled.fixedRateString(),
                            scheduled.initialDelayString(),
                            scheduled.cron()}) {
                        var matcher = placeholder.matcher(attribute);
                        while (matcher.find()) {
                            swept.add(matcher.group(1).substring(
                                    "qwen.managed-agent.".length()));
                        }
                    }
                }
            }
        }
        assertThat(swept).containsExactlyInAnyOrder(
                "artifacts.projection-interval",
                "automation.scan-delay",
                "channels.scan-delay",
                "child-relay.scan-delay",
                "child-workspace.scan-delay",
                "dispatch.scan-delay",
                "events.replay-floor-interval",
                "message-relay.scan-delay");
        var placeholderOnly = new java.util.TreeSet<String>();
        for (String key : swept) {
            if (!hasTypedField(key)) {
                placeholderOnly.add(key);
            }
        }
        assertThat(readmeNamedCadences())
                .containsExactlyInAnyOrderElementsOf(placeholderOnly);
    }

    @Test
    void theReadmeNamesEveryMillisBoundSetting() throws Exception {
        // The unit rule's millisecond exceptions are only true while the
        // sentence names every MILLIS-bound field, so derive the expected
        // set from the properties graph instead of pinning names: dropping
        // `automation.lookback` from the sentence, annotating a ninth field
        // MILLIS without documenting it, or naming a seconds-bound key in
        // the span all turn this red.
        var millisKeys = new java.util.TreeSet<String>();
        collectMillisKeys(ManagedAgentProperties.class, "", millisKeys);
        assertThat(readmeNamedMillisSettings())
                .containsExactlyInAnyOrderElementsOf(millisKeys);
    }

    private static List<Class<?>> moduleClasses() throws Exception {
        // Every class the module compiles, loaded without initialization —
        // a hand-maintained owner list is how the earlier cadence pins
        // missed a base-side addition.
        var root = java.nio.file.Path.of(ManagedAgentProperties.class
                .getProtectionDomain().getCodeSource().getLocation()
                .toURI());
        try (var paths = java.nio.file.Files.walk(root)) {
            return paths
                    .filter(path -> path.toString().endsWith(".class"))
                    .map(root::relativize).map(java.nio.file.Path::toString)
                    .filter(name -> !name.equals("module-info.class"))
                    .map(name -> name
                            .substring(0, name.length() - ".class".length())
                            .replace(java.io.File.separatorChar, '.'))
                    .<Class<?>>map(name -> {
                        try {
                            return Class.forName(name, false,
                                    ManagedAgentProperties.class
                                            .getClassLoader());
                        } catch (ClassNotFoundException missing) {
                            throw new IllegalStateException(missing);
                        }
                    })
                    .toList();
        }
    }

    private static boolean hasTypedField(String key) {
        // Walk the properties graph segment by segment: a placeholder key
        // with a matching field at every hop is a typed setting, however
        // its cadence is driven.
        Class<?> current = ManagedAgentProperties.class;
        for (String segment : key.split("\\.")) {
            var camel = new StringBuilder(segment);
            int dash;
            while ((dash = camel.indexOf("-")) >= 0) {
                camel.replace(dash, dash + 2, Character.toString(
                        Character.toUpperCase(camel.charAt(dash + 1))));
            }
            java.lang.reflect.Field field = null;
            for (java.lang.reflect.Field candidate
                    : current.getDeclaredFields()) {
                if (candidate.getName().contentEquals(camel)) {
                    field = candidate;
                    break;
                }
            }
            if (field == null) {
                return false;
            }
            current = field.getType();
        }
        return true;
    }

    private static void collectMillisKeys(Class<?> type, String prefix,
            java.util.Set<String> millisKeys) {
        // Field-path walk, not getDeclaredClasses: the README names property
        // keys, so the path of fields is the key's source — a depth-2 group
        // such as RuntimeBroker.WorkspaceMount binds under its field's name.
        // everyDurationFieldDeclaresABindingUnit already pins the full
        // inventory and each field's declared unit; this collects the
        // MILLIS-declared keys only.
        for (java.lang.reflect.Field field : type.getDeclaredFields()) {
            if (java.lang.reflect.Modifier.isStatic(field.getModifiers())) {
                continue;
            }
            if (field.getType() == java.time.Duration.class) {
                var unit = field.getAnnotation(
                        org.springframework.boot.convert.DurationUnit.class);
                if (unit != null
                        && unit.value()
                                == java.time.temporal.ChronoUnit.MILLIS) {
                    millisKeys.add(prefix + kebab(field.getName()));
                }
                continue;
            }
            Class<?> group = null;
            if (isNestedInProperties(field.getType())) {
                group = field.getType();
            } else if (field.getGenericType()
                            instanceof java.lang.reflect.ParameterizedType list
                    && list.getActualTypeArguments()[0]
                            instanceof Class<?> element
                    && isNestedInProperties(element)) {
                group = element;
            }
            if (group != null) {
                collectMillisKeys(group,
                        prefix + kebab(field.getName()) + ".", millisKeys);
            }
        }
    }

    private static boolean isNestedInProperties(Class<?> candidate) {
        for (Class<?> enclosing = candidate.getEnclosingClass();
                enclosing != null;
                enclosing = enclosing.getEnclosingClass()) {
            if (enclosing == ManagedAgentProperties.class) {
                return true;
            }
        }
        return false;
    }

    private static String kebab(String camel) {
        var out = new StringBuilder();
        for (int i = 0; i < camel.length(); i++) {
            char c = camel.charAt(i);
            if (Character.isUpperCase(c)) {
                out.append('-').append(Character.toLowerCase(c));
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    private static String readmeText() throws java.io.IOException {
        // Surefire runs from the module directory; an IDE run from the
        // repository root needs the module path spelled out.
        var path = java.nio.file.Path.of("README.md");
        if (!java.nio.file.Files.exists(path)) {
            path = java.nio.file.Path.of("packages", "sdk-java",
                    "managed-agent-server", "README.md");
        }
        // Whitespace-normalized: the sentence wraps mid-list, so a raw
        // indexOf would miss a phrase split across lines.
        return java.nio.file.Files.readString(path)
                .replaceAll("\\s+", " ");
    }

    private static java.util.Set<String> readmeNamedCadences()
            throws java.io.IOException {
        var text = readmeText();
        int start = text.indexOf("Cadences bound through");
        int end = text.indexOf("also read", start);
        assertThat(start).isGreaterThanOrEqualTo(0);
        assertThat(end).isGreaterThan(start);
        return readmeBacktickedKeys(text, start, end);
    }

    private static java.util.Set<String> readmeNamedMillisSettings()
            throws java.io.IOException {
        var text = readmeText();
        int start = text.indexOf("Millisecond-bound settings");
        int end = text.indexOf(
                "bind a suffix-less number as milliseconds", start);
        assertThat(start).isGreaterThanOrEqualTo(0);
        assertThat(end).isGreaterThan(start);
        return readmeBacktickedKeys(text, start, end);
    }

    private static java.util.Set<String> readmeBacktickedKeys(String text,
            int start, int end) {
        var named = new java.util.TreeSet<String>();
        var backtick = java.util.regex.Pattern.compile("`([^`]+)`")
                .matcher(text.substring(start, end));
        while (backtick.find()) {
            // "@Scheduled" carries no dot; the setting keys all do.
            if (backtick.group(1).contains(".")) {
                named.add(backtick.group(1));
            }
        }
        return named;
    }

    private static List<Scheduled> schedulesOn(Class<?> owner,
            String placeholderFragment) {
        // getDeclaredMethods, not getMethods: Spring schedules
        // package-private methods too. getAnnotationsByType, not
        // getAnnotation: javac emits only the @Schedules container for a
        // repeated annotation, so getAnnotation would drop a doubled sweep
        // entirely. Matching every schedule attribute keeps a
        // fixedRateString or cron twin on the same placeholder visible to
        // hasSize(1) too.
        return java.util.Arrays.stream(owner.getDeclaredMethods())
                .map(method -> method.getAnnotationsByType(Scheduled.class))
                .flatMap(java.util.Arrays::stream)
                .filter(scheduled -> scheduled.fixedDelayString()
                        .contains(placeholderFragment)
                        || scheduled.fixedRateString()
                                .contains(placeholderFragment)
                        || scheduled.cron().contains(placeholderFragment))
                .toList();
    }

    @Test
    void droppedConfigSurfacesStayDropped() {
        // The kubernetes* and cliEntry blocks had no consumer; they come
        // back only together with their provisioner/invocation. Dispatch's
        // scanDelay is the third dropped surface: the cadence lives only
        // in application.yml and the three @Scheduled placeholders.
        assertThat(ManagedAgentProperties.Dispatch.class
                .getDeclaredFields()).noneMatch(field -> field.getName()
                        .equals("scanDelay"));
        assertThat(ManagedAgentProperties.RuntimeBroker.class
                .getDeclaredFields()).noneMatch(field -> field.getName()
                        .startsWith("kubernetes"))
                .noneMatch(field -> field.getName().equals("cliEntry"));
    }

    @Test
    void validatesWorkspaceFilesWhenSpringInitializesTheProperties() {
        ApplicationContextRunner context = new ApplicationContextRunner()
                .withUserConfiguration(PropertiesConfiguration.class);
        context.run(started -> assertThat(started).hasNotFailed());
        ApplicationContextRunner enabled = context.withPropertyValues(
                "qwen.managed-agent.harness.enabled=true",
                "qwen.managed-agent.harness.workspace-files-enabled=true",
                "qwen.managed-agent.session-store.enabled=true",
                "qwen.managed-agent.runtime-broker.enabled=true",
                "qwen.managed-agent.runtime-broker.workspace-mounts[0].tenant-id=tenant",
                "qwen.managed-agent.runtime-broker.workspace-mounts[0].storage-id=storage",
                "qwen.managed-agent.runtime-broker.workspace-mounts[0].root=/workspace");
        enabled.run(started -> assertThat(started).hasNotFailed());
        enabled.withPropertyValues("qwen.managed-agent.runtime-broker.isolation-class=workspace")
                .run(started -> assertThat(started).hasFailed()
                        .getFailure().hasRootCauseInstanceOf(IllegalStateException.class)
                        .hasRootCauseMessage("Hosted Workspace files require"
                                + " a supported Harness, Session Store and Session-isolated"
                                + " local-process Broker with Workspace mounts"));
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(ManagedAgentProperties.class)
    static class PropertiesConfiguration {
    }

    @Test
    void relaxationDefaultsMatchTheShippedConfiguration() throws Exception {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        assertThat(properties.getEvents().getReadGrantRecheckInterval())
                .isEqualTo(java.time.Duration.ofSeconds(5));
        assertThat(properties.getArtifacts().getReadRevalidationInterval())
                .isEqualTo(java.time.Duration.ofSeconds(5));
        assertThat(properties.getToolPublication()
                .isJournalHeadAuthorization()).isFalse();
        // ... and the shipped application.yml mirrors the same values.
        var yaml = new org.springframework.boot.env.YamlPropertySourceLoader()
                .load("application.yml",
                        new org.springframework.core.io.ClassPathResource(
                                "application.yml"));
        // The flattened keys must exist: a renamed or dropped key would
        // bind nothing, and the value assertions below would pass on the
        // Java defaults.
        assertThat(yaml).anySatisfy(source -> {
            assertThat(source.containsProperty("qwen.managed-agent.events"
                    + ".read-grant-recheck-interval")).isTrue();
            assertThat(source.containsProperty("qwen.managed-agent.artifacts"
                    + ".read-revalidation-interval")).isTrue();
            assertThat(source.containsProperty("qwen.managed-agent"
                    + ".tool-publication.journal-head-authorization"))
                    .isTrue();
        });
        new ApplicationContextRunner()
                .withUserConfiguration(PropertiesConfiguration.class)
                .withInitializer(ctx -> {
                    // The yaml's ${QWEN_*} placeholders must resolve to
                    // their shipped defaults regardless of the ambient shell.
                    java.util.Map<String, Object> ambient =
                            new java.util.LinkedHashMap<>(System.getenv());
                    ambient.keySet().removeIf(name -> name
                            .startsWith("QWEN_MANAGED_AGENT_"));
                    ctx.getEnvironment().getPropertySources().replace(
                            "systemEnvironment",
                            new org.springframework.core.env.MapPropertySource(
                                    "systemEnvironment", ambient));
                    yaml.forEach(ctx.getEnvironment().getPropertySources()
                            ::addLast);
                })
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    ManagedAgentProperties bound = started
                            .getBean(ManagedAgentProperties.class);
                    assertThat(bound.getEvents().getReadGrantRecheckInterval())
                            .isEqualTo(java.time.Duration.ofSeconds(5));
                    assertThat(bound.getArtifacts()
                            .getReadRevalidationInterval())
                            .isEqualTo(java.time.Duration.ofSeconds(5));
                    assertThat(bound.getToolPublication()
                            .isJournalHeadAuthorization()).isFalse();
                });
    }

    @Test
    void fileAdmissionRequiresTheCompleteTrustedLocalDeployment() {
        assertThatCode(() -> new ManagedAgentProperties().validateWorkspaceFiles()).doesNotThrowAnyException();
        List<Consumer<ManagedAgentProperties>> invalid = List.of(
                p -> p.getHarness().setEnabled(false),
                p -> p.getSessionStore().setEnabled(false),
                p -> p.getRuntimeBroker().setEnabled(false),
                p -> p.getRuntimeBroker().setProvisioner("kubernetes"),
                p -> p.getRuntimeBroker().setIsolationClass("workspace"),
                p -> p.getRuntimeBroker().setWorkspaceMounts(List.of()),
                p -> p.getHarness().setApprovalMode("plan"),
                p -> p.getHarness().setApprovalMode("auto"),
                p -> p.getHarness().setApprovalTimeout(java.time.Duration.ofMillis(999)));
        for (Consumer<ManagedAgentProperties> change : invalid) {
            ManagedAgentProperties properties = new ManagedAgentProperties();
            properties.getHarness().setEnabled(true);
            properties.getHarness().setWorkspaceFilesEnabled(true);
            properties.getSessionStore().setEnabled(true);
            properties.getRuntimeBroker().setEnabled(true);
            properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                    new ManagedAgentProperties.RuntimeBroker.WorkspaceMount("tenant", "storage", "/workspace")));
            assertThatCode(properties::validateWorkspaceFiles).doesNotThrowAnyException();
            properties.getHarness().setApprovalMode("default");
            assertThatCode(properties::validateWorkspaceFiles).doesNotThrowAnyException();
            properties.getHarness().setApprovalMode("auto-edit");
            assertThatCode(properties::validateWorkspaceFiles).doesNotThrowAnyException();
            change.accept(properties);
            assertThatThrownBy(properties::validateWorkspaceFiles).isInstanceOf(IllegalStateException.class);
        }
    }

    @Test
    void automationTunablesBindFromTheShippedConfiguration() throws Exception {
        var yaml = new org.springframework.boot.env.YamlPropertySourceLoader()
                .load("application.yml",
                        new org.springframework.core.io.ClassPathResource(
                                "application.yml"));
        // The flattened keys must exist: a renamed or dropped key binds
        // nothing, and the Java defaults below would silently win.
        assertThat(yaml).anySatisfy(source -> {
            assertThat(source.containsProperty("qwen.managed-agent.automation"
                    + ".enabled")).isTrue();
            assertThat(source.containsProperty("qwen.managed-agent.automation"
                    + ".scan-delay")).isTrue();
            assertThat(source.containsProperty("qwen.managed-agent.automation"
                    + ".lease")).isTrue();
            assertThat(source.containsProperty("qwen.managed-agent.automation"
                    + ".late-tolerance")).isTrue();
            assertThat(source.containsProperty("qwen.managed-agent.automation"
                    + ".lookback")).isTrue();
            assertThat(source.containsProperty("qwen.managed-agent.automation"
                    + ".max-slots-per-tick")).isTrue();
            assertThat(source.containsProperty("qwen.managed-agent.automation"
                    + ".concurrency")).isTrue();
        });
        new ApplicationContextRunner()
                .withUserConfiguration(PropertiesConfiguration.class)
                .withInitializer(ctx -> {
                    java.util.Map<String, Object> ambient =
                            new java.util.LinkedHashMap<>(System.getenv());
                    ambient.keySet().removeIf(name -> name
                            .startsWith("QWEN_MANAGED_AGENT_"));
                    ctx.getEnvironment().getPropertySources().replace(
                            "systemEnvironment",
                            new org.springframework.core.env.MapPropertySource(
                                    "systemEnvironment", ambient));
                    yaml.forEach(ctx.getEnvironment().getPropertySources()
                            ::addLast);
                })
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    var automation = started
                            .getBean(ManagedAgentProperties.class)
                            .getAutomation();
                    assertThat(automation.isEnabled()).isFalse();
                    assertThat(automation.getScanDelay())
                            .isEqualTo(java.time.Duration.ofSeconds(10));
                    assertThat(automation.getLease())
                            .isEqualTo(java.time.Duration.ofSeconds(60));
                    assertThat(automation.getLateTolerance())
                            .isEqualTo(java.time.Duration.ofMinutes(5));
                    assertThat(automation.getLookback())
                            .isEqualTo(java.time.Duration.ofHours(24));
                    assertThat(automation.getMaxSlotsPerTick()).isEqualTo(1000);
                    assertThat(automation.getConcurrency()).isEqualTo(4);
                });
    }

    @Test
    void automationTunablesRefuseNonPositiveValuesAtStartup() {
        List<Consumer<ManagedAgentProperties>> invalid = List.of(
                p -> p.getAutomation().setMaxSlotsPerTick(0),
                p -> p.getAutomation().setConcurrency(0),
                p -> p.getAutomation().setScanDelay(
                        java.time.Duration.ZERO),
                p -> p.getAutomation().setLease(java.time.Duration.ZERO),
                p -> p.getAutomation().setLateTolerance(
                        java.time.Duration.ZERO),
                p -> p.getAutomation().setLookback(java.time.Duration.ZERO));
        for (Consumer<ManagedAgentProperties> change : invalid) {
            ManagedAgentProperties properties = new ManagedAgentProperties();
            properties.getAutomation().setEnabled(true);
            // The complete values bind cleanly: the offender alone throws.
            assertThatCode(properties::validateWorkspaceFiles)
                    .doesNotThrowAnyException();
            change.accept(properties);
            assertThatThrownBy(properties::validateWorkspaceFiles)
                    .isInstanceOf(IllegalStateException.class);
        }
        // And automation OFF may carry any values untouched.
        ManagedAgentProperties off = new ManagedAgentProperties();
        off.getAutomation().setMaxSlotsPerTick(0);
        assertThatCode(off::validateWorkspaceFiles).doesNotThrowAnyException();
    }

    @Test
    void childWorkspacesAreOffByDefaultAndNeedTheMountingBroker() {
        assertThat(new ManagedAgentProperties().getRuntimeBroker().isChildWorkspacesEnabled()).isFalse();
        assertThat(new ManagedAgentProperties().getRuntimeBroker().getChildWorkspaceGitTimeout())
                .isEqualTo(java.time.Duration.ofMinutes(2));
        List<Consumer<ManagedAgentProperties>> invalid = List.of(
                p -> p.getRuntimeBroker().setEnabled(false),
                p -> p.getRuntimeBroker().setProvisioner("kubernetes"),
                p -> p.getRuntimeBroker().setIsolationClass("workspace"),
                // A merge waits for the child's close, which only a durable Broker runs.
                p -> p.getRuntimeBroker().setDurableLocalProcess(false),
                p -> p.getRuntimeBroker().setWorkspaceMounts(List.of()));
        for (Consumer<ManagedAgentProperties> change : invalid) {
            ManagedAgentProperties properties = new ManagedAgentProperties();
            properties.getRuntimeBroker().setEnabled(true);
            properties.getRuntimeBroker().setChildWorkspacesEnabled(true);
            properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                    new ManagedAgentProperties.RuntimeBroker.WorkspaceMount("tenant", "storage", "/workspace")));
            if (ManagedAgentProperties.childWorkspacesSupportedOn(System.getProperty("os.name"))
                    && ManagedAgentProperties.utf8FileNames(System.getProperty("sun.jnu.encoding"))) {
                assertThatCode(properties::validateWorkspaceFiles).doesNotThrowAnyException();
            } else {
                assertThatThrownBy(properties::validateWorkspaceFiles).isInstanceOf(IllegalStateException.class);
            }
            change.accept(properties);
            assertThatThrownBy(properties::validateWorkspaceFiles).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("Child Workspaces require");
        }
        for (java.time.Duration timeout : List.of(java.time.Duration.ofMillis(30),
                java.time.Duration.ofMillis(999), java.time.Duration.ofHours(2))) {
            ManagedAgentProperties properties = new ManagedAgentProperties();
            properties.getRuntimeBroker().setEnabled(true);
            properties.getRuntimeBroker().setChildWorkspacesEnabled(true);
            properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                    new ManagedAgentProperties.RuntimeBroker.WorkspaceMount("tenant", "storage", "/workspace")));
            properties.getRuntimeBroker().setChildWorkspaceGitTimeout(timeout);
            assertThatThrownBy(properties::validateWorkspaceFiles).as(timeout.toString())
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("child-workspace-git-timeout");
        }
        assertThat(ManagedAgentProperties.childWorkspacesSupportedOn("Linux")).isTrue();
        assertThat(ManagedAgentProperties.childWorkspacesSupportedOn("Mac OS X")).isTrue();
        assertThat(ManagedAgentProperties.childWorkspacesSupportedOn("Windows Server 2022")).isFalse();
        assertThat(ManagedAgentProperties.utf8FileNames("UTF-8")).isTrue();
        assertThat(ManagedAgentProperties.utf8FileNames("ANSI_X3.4-1968")).isFalse();
    }
}
