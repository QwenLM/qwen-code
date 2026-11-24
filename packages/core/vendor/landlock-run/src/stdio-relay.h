/*
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

#include <poll.h>
#include <sys/socket.h>
#include <sys/wait.h>

static volatile sig_atomic_t relay_child;

static void relay_signal(int signal_number) {
  if (relay_child > 0) kill((pid_t)relay_child, signal_number);
}

static int relay_setup_failed(void) {
  dprintf(3, "{\"state\":\"stdio-setup-failed\"}\n");
  return 125;
}

/* The payload must not reopen stdin for writing into its own receive queue.
 * Retain the read-only socket so unread bytes can be deducted from consumption. */
static int relay_stdin(char **command) {
  struct stat input;
  if (fstat(STDIN_FILENO, &input) != 0) return relay_setup_failed();
  int regular = S_ISREG(input.st_mode);
  off_t initial = regular ? lseek(STDIN_FILENO, 0, SEEK_CUR) : 0;
  if (regular && initial < 0) return relay_setup_failed();
  int source = STDIN_FILENO;
  if (S_ISFIFO(input.st_mode)) {
    source = open("/proc/self/fd/0", O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (source < 0) return relay_setup_failed();
  }
  int channel[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, channel) != 0 ||
      shutdown(channel[0], SHUT_WR) != 0)
    return relay_setup_failed();
  int flags = fcntl(channel[1], F_GETFL);
  if (flags < 0 || fcntl(channel[1], F_SETFL, flags | O_NONBLOCK) != 0)
    return relay_setup_failed();
  pid_t parent = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != parent)
    return relay_setup_failed();
  pid_t bridge = getpid();
  pid_t child = fork();
  if (child < 0) return relay_setup_failed();
  if (child == 0) {
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != bridge)
      _exit(relay_setup_failed());
    if (dup2(channel[0], STDIN_FILENO) < 0) _exit(relay_setup_failed());
    close(channel[0]);
    close(channel[1]);
    if (source != STDIN_FILENO) close(source);
    execvp(command[0], command);
    fprintf(stderr, "qwen-landlock-run: exec failed: %s\n", strerror(errno));
    _exit(relay_setup_failed());
  }
  relay_child = child;
  signal(SIGINT, relay_signal);
  signal(SIGTERM, relay_signal);
  signal(SIGHUP, relay_signal);
  signal(SIGPIPE, SIG_IGN);
  unsigned char buffer[4096];
  size_t pending = 0;
  off_t sent = 0;
  int eof = !regular && !S_ISFIFO(input.st_mode);
  int status = 0;
  int failed = 0;
  for (;;) {
    pid_t observed = waitpid(child, &status, WNOHANG);
    if (observed == child) break;
    if (observed < 0 && errno != EINTR) { failed = 1; break; }
    if (getppid() != parent) { failed = 1; break; }
    if (pending == 0 && !eof) {
      ssize_t length = regular
        ? pread(source, buffer, sizeof(buffer), initial + sent)
        : read(source, buffer, sizeof(buffer));
      if (length > 0) pending = (size_t)length;
      else if (length == 0) eof = 1;
      else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
        failed = 1; break;
      }
    }
    if (pending > 0) {
      ssize_t written = write(channel[1], buffer, pending);
      if (written > 0) {
        sent += written;
        pending -= (size_t)written;
        memmove(buffer, buffer + written, pending);
      } else if (written < 0 && errno != EAGAIN && errno != EINTR) {
        failed = 1; break;
      }
    }
    if (eof && pending == 0 && channel[1] >= 0) {
      close(channel[1]);
      channel[1] = -1;
    }
    if (regular && !eof && pending == 0) continue;
    struct pollfd ready[2] = {
      {!regular && !eof && pending == 0 ? source : -1, POLLIN, 0},
      {channel[1], pending > 0 ? POLLOUT : 0, 0},
    };
    /* Poll child completion even when a FIFO writer stays open and idle. */
    if (poll(ready, 2, 20) < 0 && errno != EINTR) {
      failed = 1; break;
    }
  }
  if (failed) {
    kill(child, SIGKILL);
    while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
  }
  if (regular) {
    off_t unread = 0;
    ssize_t remaining;
    do {
      remaining = recv(channel[0], buffer, sizeof(buffer), MSG_DONTWAIT);
      if (remaining > 0) unread += remaining;
    } while (remaining > 0 || (remaining < 0 && errno == EINTR));
    if ((remaining < 0 && errno != EAGAIN && errno != EWOULDBLOCK) ||
        unread > sent ||
        lseek(STDIN_FILENO, initial + sent - unread, SEEK_SET) < 0)
      failed = 1;
  }
  close(channel[0]);
  if (channel[1] >= 0) close(channel[1]);
  if (source != STDIN_FILENO) close(source);
  if (failed) {
    dprintf(3, "{\"state\":\"stdio-failed\"}\n");
    fprintf(stderr, "qwen-landlock-run: stdin relay failed\n");
    return 125;
  }
  if (WIFSIGNALED(status)) {
    int signal_number = WTERMSIG(status);
    signal(signal_number, SIG_DFL);
    raise(signal_number);
    return 128 + signal_number;
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 125;
}
