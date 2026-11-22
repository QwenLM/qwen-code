package com.alibaba.qwen.code.managedagent.preflight;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystemLoopException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
 * The account the server runs as. Preflight often runs as root, which can
 * read every file, so it checks file access for this account from the
 * owners and modes instead, unless the account is root too. ACLs are not
 * consulted. Where this process cannot look along a path, the check throws
 * AccessDeniedException, as it cannot tell what the account may do there.
 */
final class ServiceAccount {
    private static final long LOOKUP_TIMEOUT_SECONDS = 5;
    // Linux's limit on symbolic links followed in one path lookup.
    static final int MAX_SYMBOLIC_LINKS = 40;
    // The uid the kernel lets read any file and enter any directory, whatever
    // their modes, by whatever name.
    private static final long SUPERUSER = 0;

    private final String name;
    private final long uid;
    private final Set<String> groups;

    ServiceAccount(String name, long uid, Set<String> groups) {
        this.name = name;
        this.uid = uid;
        this.groups = Set.copyOf(groups);
    }

    /**
     * Looks the account's uid and groups up with `id`, or returns empty when
     * no such user exists. Throws when `id` cannot run.
     */
    static Optional<ServiceAccount> lookup(String name) throws IOException {
        // One process, so a test can stand in for it: the uid, then the
        // groups, each on a line, and nothing where the user is missing.
        return lookup(List.of("sh", "-c", "id -u -- \"$1\" && id -Gn -- \"$1\"", "sh", name),
                name);
    }

    static Optional<ServiceAccount> lookup(List<String> command, String name) throws IOException {
        Process process = new ProcessBuilder(command)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start();
        // The output is two short lines, so the pipe holds it until the wait ends.
        try {
            if (!process.waitFor(LOOKUP_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw new IOException("id did not finish");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
            throw new IOException("interrupted while running id", interrupted);
        }
        String output;
        try (InputStream stdout = process.getInputStream()) {
            output = new String(stdout.readAllBytes(), StandardCharsets.UTF_8).strip();
        }
        // `id` exits 1 both for a missing user and for a group without a name.
        // Only a missing user prints nothing, as `id -u` fails first; a
        // nameless group prints its number, which is also how the file
        // attributes name it. The shell exits 127 where it finds no `id`.
        if (output.isEmpty()) {
            if (process.exitValue() != 1) {
                throw new IOException("id did not run: exit status " + process.exitValue());
            }
            return Optional.empty();
        }
        String[] lines = output.split("\\R", 2);
        long uid;
        try {
            uid = Long.parseLong(lines[0].strip());
        } catch (NumberFormatException notUid) {
            throw new IOException("id printed no uid for " + name, notUid);
        }
        if (lines.length < 2 || lines[1].isBlank()) {
            throw new IOException("id printed no groups for " + name);
        }
        return Optional.of(new ServiceAccount(name, uid,
                Arrays.stream(lines[1].strip().split("\\s+")).collect(Collectors.toSet())));
    }

    String name() {
        return name;
    }

    Set<String> groups() {
        return groups;
    }

    /** Whether the account is root, by its uid. */
    boolean superuser() {
        return uid == SUPERUSER;
    }

    /**
     * Whether the account can read the file. It must enter every directory
     * the kernel looks a name up in while it resolves the path: those on the
     * way to a symbolic link as well as those on the link's target.
     */
    boolean canRead(Path file) throws IOException {
        return can(file, true);
    }

    /**
     * Whether the account can enter the directory, to look a name up in it,
     * as it must to read a file there.
     */
    boolean canEnter(Path directory) throws IOException {
        return can(directory, false);
    }

    private boolean can(Path file, boolean read) throws IOException {
        if (superuser()) {
            // Root may wherever the file is; where it is not, nor may root.
            // Where this process cannot look, it cannot tell which, and the
            // AccessDeniedException says so: the kernel answers a missing
            // file behind a directory it may not enter with that too, and
            // so may a file system that denies root as well.
            Files.readAttributes(file, BasicFileAttributes.class);
            return true;
        }
        Path absolute = file.toAbsolutePath();
        Path current = Objects.requireNonNull(absolute.getRoot(), "an absolute path has a root");
        Deque<Path> names = new ArrayDeque<>();
        absolute.forEach(names::addLast);
        int links = 0;
        while (!names.isEmpty()) {
            Path name = names.removeFirst();
            if (!allows(Files.readAttributes(current, PosixFileAttributes.class), false)) {
                return false;
            }
            if (name.toString().equals(".")) {
                continue;
            }
            if (name.toString().equals("..")) {
                // The current directory is already resolved, so this is its real parent.
                current = current.getParent() == null ? current : current.getParent();
                continue;
            }
            Path next = current.resolve(name);
            if (!Files.isSymbolicLink(next)) {
                current = next;
                continue;
            }
            if (++links > MAX_SYMBOLIC_LINKS) {
                throw new FileSystemLoopException(file.toString());
            }
            Path target = Files.readSymbolicLink(next);
            if (target.isAbsolute()) {
                current = Objects.requireNonNull(target.getRoot(), "an absolute path has a root");
            }
            List<Path> targetNames = new ArrayList<>();
            target.forEach(targetNames::add);
            for (int index = targetNames.size() - 1; index >= 0; index--) {
                names.addFirst(targetNames.get(index));
            }
        }
        return allows(Files.readAttributes(current, PosixFileAttributes.class), read);
    }

    // As the kernel does for an account other than root, which can() lets
    // through first: the owner bits apply to the owner alone, then the group
    // bits to any member, then the others bits.
    private boolean allows(PosixFileAttributes attributes, boolean read) {
        Set<PosixFilePermission> permissions = attributes.permissions();
        if (attributes.owner().getName().equals(name)) {
            return permissions.contains(read ? PosixFilePermission.OWNER_READ : PosixFilePermission.OWNER_EXECUTE);
        }
        if (groups.contains(attributes.group().getName())) {
            return permissions.contains(read ? PosixFilePermission.GROUP_READ : PosixFilePermission.GROUP_EXECUTE);
        }
        return permissions.contains(read ? PosixFilePermission.OTHERS_READ : PosixFilePermission.OTHERS_EXECUTE);
    }
}
