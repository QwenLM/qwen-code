package com.alibaba.qwen.code.managedagent.preflight;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.AccessDeniedException;
import java.nio.file.FileSystemLoopException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

@DisabledOnOs(OS.WINDOWS)
class ServiceAccountTest {
    // No such account exists, so only its group list decides.
    private static final String STRANGER = "qwen-preflight-stranger";
    // Any uid but root's: the modes are matched by name.
    static final long OTHER_UID = 1_000_001;

    /**
     * Skips a test whose accounts must search every directory above this one,
     * as they cannot under macOS's 0700 per-user temporary directory.
     */
    static void assumeOthersCanSearchAbove(Path directory) {
        for (Path parent = directory.toAbsolutePath().getParent(); parent != null;
                parent = parent.getParent()) {
            try {
                assumeTrue(Files.getPosixFilePermissions(parent)
                        .contains(PosixFilePermission.OTHERS_EXECUTE),
                        parent + " shuts other accounts out");
            } catch (IOException error) {
                assumeTrue(false, parent + ": " + error.getMessage());
            }
        }
    }

    @Test
    void appliesTheOwnerGroupAndOthersBitsInTurn(@TempDir Path directory) throws IOException {
        assumeOthersCanSearchAbove(directory);
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwxr-xr-x"));
        Path file = Files.writeString(directory.resolve("harness.env"), "");
        PosixFileAttributes attributes = Files.readAttributes(file, PosixFileAttributes.class);
        String owner = attributes.owner().getName();
        if (owner.equals("root")) {
            // Root reads any file, so the owner bits need another owner, if
            // there is one to give the file to.
            owner = nobodyExists() ? "nobody" : null;
            if (owner != null) {
                Files.setOwner(file, file.getFileSystem().getUserPrincipalLookupService()
                        .lookupPrincipalByName(owner));
            }
        }
        String group = attributes.group().getName();
        ServiceAccount self = owner == null ? null : new ServiceAccount(owner, OTHER_UID, Set.of());
        ServiceAccount member = new ServiceAccount(STRANGER, OTHER_UID, Set.of(group));
        ServiceAccount other = new ServiceAccount(STRANGER, OTHER_UID, Set.of());

        mode(file, "rw-------");
        if (self != null) {
            assertTrue(self.canRead(file));
        }
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
        if (self != null) {
            assertFalse(self.canRead(file));
        }
    }

    @Test
    void letsRootReadAndEnterWhateverTheModes(@TempDir Path directory) throws IOException {
        Path locked = Files.createDirectory(directory.resolve("locked"));
        Path file = Files.writeString(directory.resolve("application.yml"), "");
        Path inside = Files.writeString(locked.resolve("application.yml"), "");
        mode(file, "---------");
        mode(inside, "---------");
        mode(locked, "---------");
        try {
            // Root by its uid, whatever its name.
            ServiceAccount root = new ServiceAccount("admin", 0, Set.of("wheel"));
            assertFalse(new ServiceAccount("root", OTHER_UID, Set.of("root")).superuser());
            assertTrue(root.canEnter(locked));
            assertTrue(root.canRead(file));
            // Nor root a file that is not there.
            assertThrows(IOException.class, () -> root.canRead(directory.resolve("missing.env")));
            // Behind a directory this process may not enter, it cannot tell a
            // file root reads from one that is not there, and says so.
            if (Files.isExecutable(locked)) {
                // This process is root.
                assertTrue(root.canRead(inside));
            } else {
                assertThrows(AccessDeniedException.class, () -> root.canRead(inside));
                assertThrows(AccessDeniedException.class,
                        () -> root.canRead(locked.resolve("missing.env")));
            }
        } finally {
            mode(locked, "rwx------");
        }
    }

    @Test
    void appliesTheGroupBitsToEnteringADirectory(@TempDir Path directory) throws IOException {
        assumeOthersCanSearchAbove(directory);
        Path nested = Files.createDirectory(directory.resolve("config"));
        String group = Files.readAttributes(nested, PosixFileAttributes.class).group().getName();
        ServiceAccount member = new ServiceAccount(STRANGER, OTHER_UID, Set.of(group));
        ServiceAccount other = new ServiceAccount(STRANGER, OTHER_UID, Set.of());
        mode(directory, "rwx--x--x");
        mode(nested, "rwx--x---");
        assertTrue(member.canEnter(nested));
        assertFalse(other.canEnter(nested));
        mode(nested, "rwx-----x");
        assertFalse(member.canEnter(nested), "a member gets the group bits, not the others bits");
        assertTrue(other.canEnter(nested));
        mode(nested, "rwxr-----");
        assertFalse(member.canEnter(nested), "reading a directory is not entering it");
        // Nor is an account of root's group root, which the modes keep out.
        mode(nested, "---------");
        assertFalse(new ServiceAccount(STRANGER, OTHER_UID, Set.copyOf(List.of("root", group)))
                .canEnter(nested));
        mode(nested, "rwx------");
    }

    @Test
    void needsEveryDirectoryAboveTheFile(@TempDir Path directory) throws IOException {
        assumeOthersCanSearchAbove(directory);
        Path nested = Files.createDirectory(directory.resolve("config"));
        Path file = Files.writeString(nested.resolve("application.yml"), "");
        mode(file, "rw-r--r--");
        ServiceAccount other = new ServiceAccount(STRANGER, OTHER_UID, Set.of());
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
    void needsTheDirectoriesOnBothSidesOfASymbolicLink(@TempDir Path directory) throws IOException {
        assumeOthersCanSearchAbove(directory);
        Path shared = Files.createDirectory(directory.resolve("shared"));
        Path file = Files.writeString(shared.resolve("application.yml"), "");
        mode(file, "rw-r--r--");
        Path hidden = Files.createDirectory(directory.resolve("private"));
        Path link = Files.createSymbolicLink(hidden.resolve("application.yml"),
                Path.of("..", "shared", "application.yml"));
        ServiceAccount other = new ServiceAccount(STRANGER, OTHER_UID, Set.of());
        mode(directory, "rwx--x--x");
        mode(shared, "rwx--x--x");
        mode(hidden, "rwx--x--x");
        assertTrue(other.canRead(link));
        // The directory holding the link keeps the account out, although
        // every directory above the target lets it in.
        mode(hidden, "rwx------");
        assertTrue(other.canRead(file));
        assertFalse(other.canRead(link));
    }

    @Test
    void needsTheDirectoriesAboveASymbolicLinksTarget(@TempDir Path directory) throws IOException {
        assumeOthersCanSearchAbove(directory);
        Path outer = Files.createDirectory(directory.resolve("outer"));
        Path inner = Files.createDirectory(outer.resolve("config"));
        mode(Files.writeString(inner.resolve("application.yml"), ""), "rw-r--r--");
        Path linked = Files.createSymbolicLink(directory.resolve("config"), inner);
        ServiceAccount other = new ServiceAccount(STRANGER, OTHER_UID, Set.of());
        mode(directory, "rwx--x--x");
        mode(outer, "rwx--x--x");
        mode(inner, "rwx--x--x");
        assertTrue(other.canRead(linked.resolve("application.yml")));
        // Only the target's path passes through outer, which the link's own
        // path never names.
        mode(outer, "rwx------");
        assertFalse(other.canRead(linked.resolve("application.yml")));
    }

    @Test
    void refusesASymbolicLinkLoop(@TempDir Path directory) throws IOException {
        assumeOthersCanSearchAbove(directory);
        mode(directory, "rwx--x--x");
        Files.createSymbolicLink(directory.resolve("a"), Path.of("b"));
        Files.createSymbolicLink(directory.resolve("b"), Path.of("a"));
        ServiceAccount other = new ServiceAccount(STRANGER, OTHER_UID, Set.of());
        assertThrows(IOException.class, () -> other.canRead(directory.resolve("a")));
    }

    @Test
    @EnabledOnOs(OS.LINUX)
    void followsNoMoreSymbolicLinksThanTheKernel(@TempDir Path directory) throws IOException {
        // Linux follows 40 links and no more, so through 41 the account
        // reads nothing. The chain starts at the real path, so no link above
        // it counts.
        assumeOthersCanSearchAbove(directory);
        Path root = directory.toRealPath();
        mode(root, "rwx--x--x");
        Path file = Files.writeString(root.resolve("application.yml"), "");
        mode(file, "rw-r--r--");
        Path chain = file;
        for (int link = 1; link <= 41; link++) {
            chain = Files.createSymbolicLink(root.resolve("link" + link), chain.getFileName());
        }
        Path within = root.resolve("link40");
        Path beyond = chain;
        assertTrue(Files.isReadable(within), "the kernel follows 40 links");
        assertFalse(Files.isReadable(beyond), "the kernel follows no more than 40 links");
        ServiceAccount other = new ServiceAccount(STRANGER, OTHER_UID, Set.of());
        assertTrue(other.canRead(within));
        assertThrows(FileSystemLoopException.class, () -> other.canRead(beyond));
    }

    @Test
    void readsNoFileThatIsMissing(@TempDir Path directory) throws IOException {
        assumeOthersCanSearchAbove(directory);
        mode(directory, "rwx--x--x");
        ServiceAccount other = new ServiceAccount(STRANGER, OTHER_UID, Set.of());
        assertThrows(IOException.class,
                () -> other.canRead(directory.resolve("missing.env")));
    }

    @Test
    void looksTheUidAndGroupsUpWithId() throws IOException {
        String self = System.getProperty("user.name");
        Optional<ServiceAccount> account = ServiceAccount.lookup(self);
        assertTrue(account.isPresent());
        assertEquals(self, account.get().name());
        assertFalse(account.get().groups().isEmpty());
        assertEquals("root".equals(self), account.get().superuser());
        assertEquals(Optional.empty(), ServiceAccount.lookup(STRANGER));
        // A name `id` would read as an option is a name: `id -u -n` prints
        // this process's name.
        assertEquals(Optional.empty(), ServiceAccount.lookup("-n"));
    }

    @Test
    void keepsTheGroupsOfAnAccountWithANamelessGroup() throws IOException {
        // `id` exits 1 here too, but still prints the groups, the nameless one as a number.
        Optional<ServiceAccount> account = ServiceAccount.lookup(List.of("sh", "-c",
                "echo 1001; echo svc 4242; echo 'cannot find name' >&2; exit 1"), "svc");
        assertEquals(Set.of("svc", "4242"), account.orElseThrow().groups());
        assertFalse(account.orElseThrow().superuser());
        assertEquals(Optional.empty(), ServiceAccount.lookup(
                List.of("sh", "-c", "echo 'no such user' >&2; exit 1"), "svc"));
    }

    @Test
    void takesAnAccountOfUidZeroForRootWhateverItsName() throws IOException {
        assertTrue(ServiceAccount.lookup(List.of("sh", "-c", "echo 0; echo wheel"), "admin")
                .orElseThrow().superuser());
        // Output that is not `id`'s is no account.
        assertThrows(IOException.class, () -> ServiceAccount.lookup(
                List.of("sh", "-c", "echo svc"), "svc"));
        assertThrows(IOException.class, () -> ServiceAccount.lookup(
                List.of("sh", "-c", "echo 1001"), "svc"));
        // Nor is a shell that finds no `id` a missing account.
        assertThrows(IOException.class, () -> ServiceAccount.lookup(
                List.of("sh", "-c", "echo 'id: not found' >&2; exit 127"), "svc"));
    }

    static boolean nobodyExists() {
        try {
            return ServiceAccount.lookup("nobody").isPresent();
        } catch (IOException error) {
            return false;
        }
    }

    static void mode(Path path, String permissions) throws IOException {
        Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(permissions));
    }
}
