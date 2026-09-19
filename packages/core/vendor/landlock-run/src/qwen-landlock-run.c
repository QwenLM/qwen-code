/*
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

struct landlock_ruleset_attr {
  uint64_t handled_access_fs;
};

struct landlock_path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define LANDLOCK_RULE_PATH_BENEATH 1

#define LL_FS_EXECUTE (UINT64_C(1) << 0)
#define LL_FS_WRITE_FILE (UINT64_C(1) << 1)
#define LL_FS_READ_FILE (UINT64_C(1) << 2)
#define LL_FS_READ_DIR (UINT64_C(1) << 3)
#define LL_FS_REMOVE_DIR (UINT64_C(1) << 4)
#define LL_FS_REMOVE_FILE (UINT64_C(1) << 5)
#define LL_FS_MAKE_CHAR (UINT64_C(1) << 6)
#define LL_FS_MAKE_DIR (UINT64_C(1) << 7)
#define LL_FS_MAKE_REG (UINT64_C(1) << 8)
#define LL_FS_MAKE_SOCK (UINT64_C(1) << 9)
#define LL_FS_MAKE_FIFO (UINT64_C(1) << 10)
#define LL_FS_MAKE_BLOCK (UINT64_C(1) << 11)
#define LL_FS_MAKE_SYM (UINT64_C(1) << 12)
#define LL_FS_REFER (UINT64_C(1) << 13)
#define LL_FS_TRUNCATE (UINT64_C(1) << 14)
#define LL_FS_IOCTL_DEV (UINT64_C(1) << 15)

#define LL_ABI1_MASK (LL_FS_REFER - 1)
#define MIN_ABI 3L
#define MAX_KNOWN_ABI 5L
#define EXIT_LAUNCHER_FAILURE 125

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif

struct command_line {
  int probe;
  int status_fd;
  const char **read_only;
  size_t read_only_count;
  const char **read_write;
  size_t read_write_count;
  char **command;
};

static int fatal(const char *message) {
  fprintf(stderr, "qwen-landlock-run: %s: %s\n", message, strerror(errno));
  return EXIT_LAUNCHER_FAILURE;
}

static int fatal_text(const char *message) {
  fprintf(stderr, "qwen-landlock-run: %s\n", message);
  return EXIT_LAUNCHER_FAILURE;
}

static int parse_fd(const char *value, int *result) {
  char *end = NULL;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed < 3 ||
      parsed > INT_MAX) {
    return fatal_text("--status-fd requires an open descriptor >= 3");
  }
  *result = (int)parsed;
  return 0;
}

static int parse_arguments(int argc, char **argv, struct command_line *parsed) {
  parsed->status_fd = -1;
  parsed->read_only = calloc((size_t)argc, sizeof(*parsed->read_only));
  parsed->read_write = calloc((size_t)argc, sizeof(*parsed->read_write));
  if (parsed->read_only == NULL || parsed->read_write == NULL) {
    return fatal_text("out of memory");
  }

  for (int index = 1; index < argc;) {
    const char *argument = argv[index];
    if (strcmp(argument, "--probe") == 0) {
      if (argc != 2) return fatal_text("--probe takes no other arguments");
      parsed->probe = 1;
      return 0;
    }
    if (strcmp(argument, "--status-fd") == 0) {
      if (index + 1 >= argc || parsed->status_fd >= 0) {
        return fatal_text("invalid --status-fd");
      }
      int code = parse_fd(argv[index + 1], &parsed->status_fd);
      if (code != 0) return code;
      index += 2;
      continue;
    }
    if (strcmp(argument, "--ro") == 0 || strcmp(argument, "--rw") == 0) {
      if (index + 1 >= argc) return fatal_text("grant requires a path");
      if (strcmp(argument, "--ro") == 0) {
        parsed->read_only[parsed->read_only_count++] = argv[index + 1];
      } else {
        parsed->read_write[parsed->read_write_count++] = argv[index + 1];
      }
      index += 2;
      continue;
    }
    if (strcmp(argument, "--") == 0) {
      parsed->command = &argv[index + 1];
      break;
    }
    return fatal_text("unknown argument");
  }

  if (parsed->command == NULL || parsed->command[0] == NULL) {
    return fatal_text("missing -- <argv> command");
  }
  if (parsed->status_fd >= 0 && fcntl(parsed->status_fd, F_GETFD) < 0) {
    return fatal("invalid status descriptor");
  }
  return 0;
}

static uint64_t access_mask(long abi) {
  uint64_t mask = LL_ABI1_MASK | LL_FS_REFER | LL_FS_TRUNCATE;
  if (abi >= 5) mask |= LL_FS_IOCTL_DEV;
  return mask;
}

static int add_path_rule(int ruleset_fd, const char *path, uint64_t access) {
  int path_fd = open(path, O_PATH | O_CLOEXEC);
  if (path_fd < 0) return fatal("cannot open grant path");

  struct stat metadata;
  if (fstat(path_fd, &metadata) != 0) {
    int saved = errno;
    close(path_fd);
    errno = saved;
    return fatal("cannot inspect grant path");
  }
  if (!S_ISDIR(metadata.st_mode)) {
    access &= LL_FS_EXECUTE | LL_FS_WRITE_FILE | LL_FS_READ_FILE |
              LL_FS_TRUNCATE | LL_FS_IOCTL_DEV;
  }

  struct landlock_path_beneath_attr rule = {
      .allowed_access = access,
      .parent_fd = path_fd,
  };
  int result = (int)syscall(__NR_landlock_add_rule, ruleset_fd,
                            LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
  int saved = errno;
  close(path_fd);
  if (result != 0) {
    errno = saved;
    return fatal("cannot add grant rule");
  }
  return 0;
}

static int install_ruleset(const struct command_line *parsed, long *abi_out) {
  long abi = syscall(__NR_landlock_create_ruleset, NULL, 0,
                     LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < MIN_ABI) {
    if (abi < 0) return fatal("Landlock is unavailable");
    return fatal_text("Landlock ABI 3 or newer is required");
  }

  long negotiated = abi < MAX_KNOWN_ABI ? abi : MAX_KNOWN_ABI;
  uint64_t handled = access_mask(negotiated);
  struct landlock_ruleset_attr ruleset = {.handled_access_fs = handled};
  int ruleset_fd = (int)syscall(__NR_landlock_create_ruleset, &ruleset,
                                sizeof(ruleset), 0);
  if (ruleset_fd < 0) return fatal("cannot create Landlock ruleset");

  const uint64_t read_access =
      LL_FS_EXECUTE | LL_FS_READ_FILE | LL_FS_READ_DIR;
  for (size_t index = 0; index < parsed->read_only_count; index++) {
    int code = add_path_rule(ruleset_fd, parsed->read_only[index],
                             read_access & handled);
    if (code != 0) {
      close(ruleset_fd);
      return code;
    }
  }
  for (size_t index = 0; index < parsed->read_write_count; index++) {
    int code = add_path_rule(ruleset_fd, parsed->read_write[index], handled);
    if (code != 0) {
      close(ruleset_fd);
      return code;
    }
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    int saved = errno;
    close(ruleset_fd);
    errno = saved;
    return fatal("cannot set no_new_privs");
  }
  if (syscall(__NR_landlock_restrict_self, ruleset_fd, 0) != 0) {
    int saved = errno;
    close(ruleset_fd);
    errno = saved;
    return fatal("cannot enforce Landlock ruleset");
  }
  close(ruleset_fd);
  *abi_out = abi;
  return 0;
}

static int write_all(int fd, const char *text) {
  size_t remaining = strlen(text);
  while (remaining > 0) {
    ssize_t written = write(fd, text, remaining);
    if (written < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    text += written;
    remaining -= (size_t)written;
  }
  return 0;
}

static int report_status(int fd, const char *state, long abi) {
  if (fd < 0) return 0;
  char record[128];
  int length = snprintf(record, sizeof(record),
                        "{\"state\":\"%s\",\"abi\":%ld}\n", state, abi);
  if (length < 0 || (size_t)length >= sizeof(record) ||
      write_all(fd, record) != 0) {
    return fatal("cannot write execution status");
  }
  return 0;
}

int main(int argc, char **argv) {
  struct command_line parsed = {0};
  int code = parse_arguments(argc, argv, &parsed);
  if (code != 0) return code;

  if (parsed.probe) {
    const char *root = "/";
    parsed.read_only = &root;
    parsed.read_only_count = 1;
    long abi = 0;
    code = install_ruleset(&parsed, &abi);
    if (code != 0) return code;
    printf("{\"abi\":%ld,\"enforcement\":\"partial\"}\n", abi);
    return 0;
  }

  pid_t parent = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) {
    return fatal("cannot set parent-death signal");
  }
  if (getppid() != parent) return fatal_text("parent exited during setup");

  long abi = 0;
  code = install_ruleset(&parsed, &abi);
  if (code != 0) return code;
  if (parsed.status_fd >= 0 &&
      fcntl(parsed.status_fd, F_SETFD, FD_CLOEXEC) != 0) {
    return fatal("cannot close status descriptor on exec");
  }
  code = report_status(parsed.status_fd, "prepared", abi);
  if (code != 0) return code;

  execvp(parsed.command[0], parsed.command);
  int saved = errno;
  (void)report_status(parsed.status_fd, "exec-failed", abi);
  errno = saved;
  return fatal("exec failed");
}
