package com.alibaba.qwen.code.managedagent.preflight;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

@DisabledOnOs(OS.WINDOWS)
class ServiceAccountTest {
    // No such account exists, so only its group list decides.
    private static final String STRANGER = "qwen-preflight-stranger";

    @Test
    void appliesTheOwnerGroupAndOthersBitsInTurn(@TempDir Path directory) throws IOException {
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwxr-xr-x"));
        Path file = Files.writeString(directory.resolve("harness.env"), "");
        PosixFileAttributes attributes = Files.readAttributes(file, PosixFileAttributes.class);
        String owner = attributes.owner().getName();
        String group = attributes.group().getName();
        ServiceAccount self = new ServiceAccount(owner, Set.of());
        ServiceAccount member = new ServiceAccount(STRANGER, Set.of(group));
        ServiceAccount other = new ServiceAccount(STRANGER, Set.of());

        mode(file, "rw-------");
        assertTrue(self.canRead(file));
        assertFalse(member.canRead(file));
        assertFalse(other.canRead(file));
        mode(file, "rw-r-----");
        assertTrue(member.canRead(file));
        assertFalse(other.canRead(file));
        mode(file, "rw----r--");
        assertFalse(member.canRead(file), "a member gets the group bits, not the others bits");
        assertTrue(other.canRead(file));
        // The owner bits alone apply to the owner.
        mode(file, "-w-r--r--");
        assertFalse(self.canRead(file));
    }

    @Test
    void needsEveryDirectoryAboveTheFile(@TempDir Path directory) throws IOException {
        Path nested = Files.createDirectory(directory.resolve("config"));
        Path file = Files.writeString(nested.resolve("application.yml"), "");
        mode(file, "rw-r--r--");
        ServiceAccount other = new ServiceAccount(STRANGER, Set.of());
        mode(directory, "rwx--x--x");
        mode(nested, "rwx--x--x");
        assertTrue(other.canRead(file));
        // A root-owned 0700 parent, as /root is, keeps the account out.
        mode(directory, "rwx------");
        assertFalse(other.canRead(file));
        mode(directory, "rwx--x--x");
        mode(nested, "rwxr--r--");
        assertFalse(other.canRead(file), "reading a directory is not entering it");
    }

    @Test
    void readsNoFileThatIsMissing(@TempDir Path directory) {
        ServiceAccount other = new ServiceAccount(STRANGER, Set.of());
        assertThrows(IOException.class,
                () -> other.canRead(directory.resolve("missing.env")));
    }

    @Test
    void looksTheGroupsUpWithId() throws IOException {
        String self = System.getProperty("user.name");
        Optional<ServiceAccount> account = ServiceAccount.lookup(self);
        assertTrue(account.isPresent());
        assertEquals(self, account.get().name());
        assertFalse(account.get().groups().isEmpty());
        assertEquals(Optional.empty(), ServiceAccount.lookup(STRANGER));
    }

    @Test
    void keepsTheGroupsOfAnAccountWithANamelessGroup() throws IOException {
        // `id` exits 1 here too, but still prints the groups, the nameless one as a number.
        Optional<ServiceAccount> account = ServiceAccount.lookup(
                List.of("sh", "-c", "echo svc 4242; echo 'cannot find name' >&2; exit 1"), "svc");
        assertEquals(Set.of("svc", "4242"), account.orElseThrow().groups());
        assertEquals(Optional.empty(), ServiceAccount.lookup(
                List.of("sh", "-c", "echo 'no such user' >&2; exit 1"), "svc"));
    }

    private static void mode(Path path, String permissions) throws IOException {
        Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(permissions));
    }
}
