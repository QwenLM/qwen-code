package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.catalog.ManagedDefinitionInputProviders;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.Context;
import com.alibaba.qwen.code.managedagent.contracts.extensions.AgentBootstrapBundleSource.BundleRef;
import com.alibaba.qwen.code.managedagent.contracts.extensions.AgentBootstrapBundleSource.Download;
import com.alibaba.qwen.code.managedagent.contracts.extensions.AgentBootstrapBundleSource.Resolved;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionArchiveStorage;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedAgentBootstrapPreparation;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import jakarta.annotation.PreDestroy;
import org.apache.commons.codec.binary.Hex;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.convert.DurationStyle;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

@Service
public final class ManagedAgentBootstrapPreparationService implements ManagedAgentBootstrapPreparation {
    private static final Set<String> CONTENT_TYPES = Set.of("application/zip", "application/octet-stream");
    private final ManagedDefinitionInputProviders providers;
    private final ExtensionArchiveStorage storage;
    private final BootstrapDownloadSettings settings;
    private final HttpClient http;
    private final Semaphore downloads;
    private final ScheduledExecutorService aborts;

    @Autowired
    public ManagedAgentBootstrapPreparationService(ManagedDefinitionInputProviders providers,
            ExtensionArchiveStorage storage,
            @Value("${qwen.managed-agent.definition-input.download.allowed-hosts:}") String allowedHosts,
            @Value("${qwen.managed-agent.definition-input.download.max-bytes:104857600}") long maxBytes,
            @Value("${qwen.managed-agent.definition-input.download.max-concurrency:4}") int maxConcurrency,
            @Value("${qwen.managed-agent.definition-input.download.connect-timeout:10s}") String connectTimeout,
            @Value("${qwen.managed-agent.definition-input.download.request-timeout:120s}") String requestTimeout) {
        this(providers, storage, new BootstrapDownloadSettings(
                new LinkedHashSet<>(Arrays.asList(allowedHosts.split(",", -1))),
                maxBytes, maxConcurrency, DurationStyle.detectAndParse(connectTimeout),
                DurationStyle.detectAndParse(requestTimeout)),
                HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
                        .connectTimeout(DurationStyle.detectAndParse(connectTimeout))
                        .version(HttpClient.Version.HTTP_1_1).build());
    }

    ManagedAgentBootstrapPreparationService(ManagedDefinitionInputProviders providers,
            ExtensionArchiveStorage storage, BootstrapDownloadSettings settings, HttpClient http) {
        this.providers = providers;
        this.storage = storage;
        this.settings = settings;
        this.http = http;
        downloads = new Semaphore(settings.maxConcurrency());
        aborts = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "managed-bootstrap-download-deadline");
            thread.setDaemon(true);
            return thread;
        });
    }

    @PreDestroy
    void shutdown() {
        aborts.shutdownNow();
    }

    @Override
    public List<PreparedBundle> prepare(Context context, List<BundleRef> bundles) {
        if (context == null || bundles == null || bundles.size() > 32
                || bundles.stream().distinct().count() != bundles.size()) {
            throw new ManagedAgentException(400, "invalid_bootstrap_plan",
                    "A bootstrap plan requires at most 32 distinct bundles.");
        }
        if (bundles.isEmpty()) {
            return List.of();
        }
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Bootstrap preparation must run outside a Managed SQL transaction");
        }
        providers.requireExecutionAccess(context);
        return bundles.stream().map(bundle -> prepare(context, bundle)).toList();
    }

    private PreparedBundle prepare(Context context, BundleRef bundle) {
        if (bundle == null || bundle.expectedDigest() == null) {
            throw new ManagedAgentException(409, "invalid_bootstrap_pin",
                    "An exact source digest is required for a bootstrap bundle.");
        }
        if (bundle.expectedLength() != null && bundle.expectedLength() > settings.maxBytes()) {
            throw new ManagedAgentException(413, "bootstrap_bundle_too_large",
                    "The declared bootstrap bundle exceeds the configured limit.");
        }
        var key = new ExtensionArchiveStorage.Key(context.tenantId(), context.workspaceId(),
                bundle.expectedDigest());
        var resolved = resolve(context, bundle);
        try {
            var existing = storage.stat(key);
            if (existing.isPresent()) {
                long length = existing.get().byteLength();
                if (length < 1 || length > settings.maxBytes()
                        || bundle.expectedLength() != null && length != bundle.expectedLength()) {
                    throw unavailable("The saved bootstrap bundle has unexpected metadata.", null);
                }
                return new PreparedBundle(bundle, bundle.expectedDigest(), length, true);
            }
            if (!downloads.tryAcquire()) {
                throw new ManagedAgentException(503, "bootstrap_staging_busy",
                        "Bootstrap download staging is busy.");
            }
            Path staging = null;
            try {
                staging = download(context, resolved);
                long length = Files.size(staging);
                try (var input = Files.newInputStream(staging)) {
                    storage.putIfAbsent(key, length, input);
                }
                return new PreparedBundle(bundle, bundle.expectedDigest(), length, false);
            } finally {
                try {
                    if (staging != null) {
                        Files.deleteIfExists(staging);
                    }
                } finally {
                    downloads.release();
                }
            }
        } catch (ManagedAgentException error) {
            throw error;
        } catch (IOException error) {
            throw unavailable("The bootstrap archive could not be saved.", error);
        }
    }

    private Resolved resolve(Context context, BundleRef bundle) {
        if (context == null) {
            throw new IllegalArgumentException("A source context is required");
        }
        try {
            var sourceContext = new com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionSource.Context(
                    context.tenantId(), context.actorId(), context.workspaceId(),
                    context.requestId(), context.deadline());
            sourceContext.checkDeadline();
            var resolved = providers.bundle(bundle.providerId()).resolve(sourceContext, bundle);
            sourceContext.checkDeadline();
            if (resolved == null || !bundle.equals(resolved.ref())
                    || !CONTENT_TYPES.contains(resolved.download().contentType()
                            .split(";", 2)[0].trim().toLowerCase(Locale.ROOT))) {
                throw new ManagedAgentException(409, "bootstrap_source_changed",
                        "The bundle Source returned a different reference or unsupported content type.");
            }
            return resolved;
        } catch (ManagedAgentException error) {
            throw error;
        } catch (Exception error) {
            throw unavailable("The bundle Source could not resolve the exact bundle.", null);
        }
    }

    private Path download(Context context, Resolved resolved) throws IOException {
        requireTarget(resolved.download().signedUri());
        if (!resolved.download().expiresAt().isAfter(Instant.now())) {
            throw deadline();
        }
        URI uri = resolved.download().signedUri();
        Instant deadline = earliest(context.deadline(), resolved.download().expiresAt(),
                Instant.now().plus(settings.requestTimeout()));
        var request = HttpRequest.newBuilder(uri).GET()
                .timeout(positiveDuration(deadline))
                .header("Accept", "application/zip, application/octet-stream").build();
        HttpResponse<InputStream> response;
        var pending = http.sendAsync(request, HttpResponse.BodyHandlers.ofInputStream());
        try {
            response = pending.get(positiveDuration(deadline).toNanos(), TimeUnit.NANOSECONDS);
        } catch (TimeoutException error) {
            pending.cancel(true);
            throw deadline();
        } catch (InterruptedException error) {
            pending.cancel(true);
            Thread.currentThread().interrupt();
            throw unavailable("The bootstrap download was interrupted.", null);
        } catch (Exception error) {
            if (error.getCause() instanceof java.net.http.HttpTimeoutException) {
                throw deadline();
            }
            throw unavailable("The bootstrap download could not establish a response.", null);
        }
        try {
            requireResponse(response, resolved.download());
        } catch (RuntimeException error) {
            response.body().close();
            throw error;
        }
        Path staging = Files.createTempFile("managed-bootstrap-", ".archive");
        boolean complete = false;
        var timedOut = new AtomicBoolean();
        try {
            try (var body = response.body(); var output = Files.newOutputStream(staging)) {
                var abort = aborts.schedule(() -> {
                    timedOut.set(true);
                    try {
                        body.close();
                    } catch (IOException ignored) {
                        // The reader reports the timeout; no response target reaches a receipt or log.
                    }
                }, positiveDuration(deadline).toMillis(), TimeUnit.MILLISECONDS);
                try {
                    copy(body, output, deadline, resolved.ref());
                    if (timedOut.get() || !Instant.now().isBefore(deadline)) {
                        throw deadline();
                    }
                } finally {
                    abort.cancel(false);
                }
            }
            complete = true;
            return staging;
        } catch (IOException error) {
            if (timedOut.get() || !Instant.now().isBefore(deadline)) {
                throw deadline();
            }
            throw unavailable("The bootstrap download ended before an archive was verified.", null);
        } finally {
            if (!complete) {
                Files.deleteIfExists(staging);
            }
        }
    }

    private void copy(InputStream input, java.io.OutputStream output, Instant deadline,
            BundleRef expectedBundle) throws IOException {
        var hash = DigestUtils.getSha256Digest();
        long length = 0;
        int count;
        byte[] buffer = new byte[64 * 1024];
        while ((count = input.read(buffer)) != -1) {
            if (!Instant.now().isBefore(deadline)) {
                throw deadline();
            }
            length += count;
            if (length > settings.maxBytes()) {
                throw new ManagedAgentException(413, "bootstrap_bundle_too_large",
                        "The downloaded bootstrap bundle exceeds the configured limit.");
            }
            hash.update(buffer, 0, count);
            output.write(buffer, 0, count);
        }
        String digest = Hex.encodeHexString(hash.digest());
        String expected = expectedBundle.expectedDigest();
        if (length < 1 || expectedBundle.expectedLength() != null
                && length != expectedBundle.expectedLength() || !expected.equals(digest)) {
            throw new ManagedAgentException(409, "bootstrap_bundle_changed",
                    "Downloaded bytes do not match the exact bundle source digest.");
        }
    }

    private void requireResponse(HttpResponse<InputStream> response, Download download) {
        if (response.statusCode() != 200) {
            throw unavailable("The bootstrap download endpoint refused the request.", null);
        }
        String contentType = response.headers().firstValue("Content-Type").orElse("")
                .split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        if (!download.contentType().split(";", 2)[0].trim().toLowerCase(Locale.ROOT)
                .equals(contentType)) {
            throw new ManagedAgentException(409, "bootstrap_bundle_changed",
                    "The downloaded content type does not match the Source declaration.");
        }
        long advertised = response.headers().firstValueAsLong("Content-Length").orElse(-1);
        if (advertised > settings.maxBytes()) {
            throw new ManagedAgentException(413, "bootstrap_bundle_too_large",
                    "The bootstrap response exceeds the configured limit.");
        }
    }

    private void requireTarget(URI uri) {
        if (uri == null || !"https".equals(uri.getScheme()) || uri.getUserInfo() != null
                || uri.getHost() == null || !settings.allowedHosts().contains(
                        uri.getHost().toLowerCase(Locale.ROOT))) {
            throw new ManagedAgentException(403, "bootstrap_download_forbidden",
                    "The signed bundle endpoint is not an approved HTTPS target.");
        }
    }

    private static Duration positiveDuration(Instant deadline) {
        Duration remaining = Duration.between(Instant.now(), deadline);
        if (remaining.isNegative() || remaining.isZero()) {
            throw deadline();
        }
        return remaining;
    }

    private static Instant earliest(Instant... deadlines) {
        Instant earliest = deadlines[0];
        for (Instant candidate : deadlines) {
            if (candidate.isBefore(earliest)) {
                earliest = candidate;
            }
        }
        return earliest;
    }

    private static ManagedAgentException deadline() {
        return new ManagedAgentException(409, "bootstrap_download_deadline_exceeded",
                "The bootstrap download deadline has passed.");
    }

    private static ManagedAgentException unavailable(String message, Throwable cause) {
        return new ManagedAgentException(503, "bootstrap_archive_unavailable", message, cause);
    }
}
