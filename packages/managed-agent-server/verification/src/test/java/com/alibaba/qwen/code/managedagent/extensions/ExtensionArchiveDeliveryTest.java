package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.api.ManagedExtensionPackageController;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionArchives;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionQueryStore;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.TenantContext;
import com.alibaba.qwen.code.managedagent.workspace.runtime.ManagedRuntimeCoordinator;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.WorkspacePhysicalTransport;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.RETURNS_DEEP_STUBS;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ExtensionArchiveDeliveryTest {
    private final ManagedExtensionPackages.Pin pin = new ManagedExtensionPackages.Pin("ext_source", 1, "a".repeat(64), null);
    private final ManagedExtensionPackages.Package descriptor = new ManagedExtensionPackages.Package(pin,
            new ManagedExtensionPackages.Manifest(1, 1, "source", "1", new ManagedExtensionPackages.Target("linux", "any"), List.of("skills")), 3);

    @ParameterizedTest
    @ValueSource(strings = {"success", "failure", "consumer-cancelled"})
    void asynchronousUploadRetainsTheFileUntilActualDeliverySettles(String outcome) throws Exception {
        var transport = mock(WorkspacePhysicalTransport.class);
        var preparation = new AtomicReference<WorkspacePhysicalTransport.ExtensionPreparation>();
        doAnswer(call -> {
            preparation.set(call.getArgument(0));
            return null;
        }).when(transport).configureExtensionPreparation(any());
        var bindings = mock(RuntimeBindingRepository.class);
        var binding = mock(RuntimeBindingRecord.class, RETURNS_DEEP_STUBS);
        when(binding.getBindingId()).thenReturn("binding");
        when(binding.getState()).thenReturn(RuntimeBindingRecord.State.READY);
        when(binding.getRequest().getScope().getTenantId()).thenReturn("tenant");
        when(binding.getRequest().getScope().getWorkspaceId()).thenReturn("workspace");
        when(binding.getRequest().getScope().getIsolationClass()).thenReturn("session");
        when(binding.getRequest().getIsolationKey()).thenReturn("session");
        when(binding.getLease()).thenReturn(new RuntimeLease("runtime", URI.create("http://localhost:1"), "token", "lease", 1));
        when(bindings.findById("binding")).thenReturn(binding);
        var sessions = mock(SessionQueryStore.class);
        var session = mock(SessionRecord.class);
        var context = mock(ContextBinding.class);
        when(context.getWorkspaceId()).thenReturn("workspace");
        when(session.workspace()).thenReturn(context);
        when(session.toolProfile()).thenReturn("hosted-workspace-shell/1");
        when(sessions.requireSession("tenant", "session")).thenReturn(session);
        var packages = mock(ExtensionPackages.class);
        Path file = Files.createTempFile("extension-delivery-test-", ".archive");
        Files.write(file, new byte[] {1, 2, 3});
        var lease = new ExtensionArchives.Archive(file, () -> {
            try {
                Files.deleteIfExists(file);
            } catch (IOException error) {
                throw new java.io.UncheckedIOException(error);
            }
        });
        when(packages.resolvePin("tenant", "workspace", pin)).thenReturn(new ExtensionPackages.ResolvedPackage(descriptor, lease, Map.of()));
        var upload = new CompletableFuture<Map<String, Object>>();
        when(transport.installExtensionPackage(eq(binding), eq(pin.packageDigest()), eq(file))).thenReturn(upload);
        var coordinator = new ManagedRuntimeCoordinator(null, sessions, null, null, null, false, null, null, bindings, transport);
        coordinator.configureExtensions(packages);
        try {
            var delivered = preparation.get().prepare(binding, "session", Map.of("extensions",
                    List.of(Map.of("extensionId", pin.extensionId(), "packageRevision", pin.packageRevision(), "packageDigest", pin.packageDigest())))).toCompletableFuture();
            assertThat(Files.exists(file)).isTrue();
            assertThat(delivered.isDone()).isFalse();
            if ("consumer-cancelled".equals(outcome)) {
                delivered.cancel(false);
                assertThat(Files.exists(file)).isTrue();
                assertThat(upload.isDone()).isFalse();
            }
            if ("failure".equals(outcome)) {
                upload.completeExceptionally(new IOException("upload failed"));
                assertThat(delivered.isCompletedExceptionally()).isTrue();
            } else {
                upload.complete(Map.of());
            }
            assertThat(Files.exists(file)).isFalse();
        } finally {
            upload.completeExceptionally(new IOException("test cleanup"));
            lease.close();
        }
    }

    @Test
    void disconnectedHttpStreamClosesItsLazilyAcquiredArchive() throws Exception {
        var service = mock(ManagedExtensionPackageService.class);
        when(service.get("tenant", "actor", "workspace", pin.extensionId(), 1, pin.packageDigest())).thenReturn(descriptor);
        var controller = new ManagedExtensionPackageController(service);
        var response = controller.archive(new TenantContext("tenant", "actor"), "workspace", pin.extensionId(), 1, pin.packageDigest());
        verify(service, never()).archive(any(), any(), any(), any(), org.mockito.ArgumentMatchers.anyLong(), any());
        Path file = Files.createTempFile("extension-http-test-", ".archive");
        Files.write(file, new byte[] {1, 2, 3});
        var lease = new ExtensionArchives.Archive(file, () -> {
            try {
                Files.deleteIfExists(file);
            } catch (IOException error) {
                throw new java.io.UncheckedIOException(error);
            }
        });
        when(service.archive("tenant", "actor", "workspace", pin.extensionId(), 1, pin.packageDigest())).thenReturn(lease);
        try {
            assertThatThrownBy(() -> response.getBody().writeTo(new java.io.OutputStream() {
                @Override public void write(int value) throws IOException { throw new IOException("client disconnected"); }
            })).isInstanceOf(IOException.class);
            assertThat(Files.exists(file)).isFalse();
        } finally {
            lease.close();
        }
    }
}
