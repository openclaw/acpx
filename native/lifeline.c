#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

#define GROUP_POLL_TIMEOUT_MS 100

static int parse_pgid(const char *value, pid_t *pgid) {
  errno = 0;
  char *end = NULL;
  long parsed = strtol(value, &end, 10);
  if (errno == ERANGE || end == value || *end != '\0' || parsed <= 1) {
    return -1;
  }

  pid_t narrowed = (pid_t)parsed;
  if ((long)narrowed != parsed) {
    return -1;
  }

  *pgid = narrowed;
  return 0;
}

static int process_group_alive(pid_t pgid) {
  if (kill(-pgid, 0) == 0) {
    return 1;
  }
  if (errno == EPERM) {
    return 1;
  }
  if (errno == ESRCH) {
    return 0;
  }
  return 1;
}

static void reap_group(pid_t pgid) {
  kill(-pgid, SIGTERM);
  usleep(200000);
  /*
   * The process group can outlive its leader. Probe the group itself so
   * TERM-resistant descendants still get the SIGKILL fallback.
   */
  if (kill(-pgid, 0) == 0 || errno == EPERM) {
    kill(-pgid, SIGKILL);
  }
}

static int should_reap_after_owner_eof(pid_t bridge_pgid) {
  return process_group_alive(bridge_pgid) ? 1 : 0;
}

static int wait_for_owner_pipe(pid_t bridge_pgid) {
  struct pollfd pfd = {
    .fd = STDIN_FILENO,
    .events = POLLIN,
  };
  char buffer[32];

  for (;;) {
    int ready = poll(&pfd, 1, GROUP_POLL_TIMEOUT_MS);
    if (ready == -1) {
      if (errno == EINTR) {
        continue;
      }
      perror("poll");
      return -1;
    }

    if (ready == 0) {
      if (!process_group_alive(bridge_pgid)) {
        return 0;
      }
      continue;
    }

    if ((pfd.revents & POLLIN) != 0) {
      ssize_t nread = read(STDIN_FILENO, buffer, sizeof(buffer));
      if (nread == -1) {
        if (errno == EINTR) {
          continue;
        }
        perror("read");
        return -1;
      }
      if (nread == 0) {
        return should_reap_after_owner_eof(bridge_pgid);
      }
      if (memchr(buffer, 'R', (size_t)nread) != NULL) {
        return 0;
      }
    }

    if ((pfd.revents & POLLHUP) != 0) {
      return should_reap_after_owner_eof(bridge_pgid);
    }

    if ((pfd.revents & (POLLERR | POLLNVAL)) != 0) {
      /*
       * The lifeline fd itself is broken: we can no longer observe the owner.
       * Degrade to pre-lifeline behavior (exit without reaping) rather than
       * risk killing a live session, and avoid a POLLERR busy-loop.
       */
      return -1;
    }

    if (!process_group_alive(bridge_pgid)) {
      return 0;
    }
  }
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: lifeline <bridgePgid>\n");
    return 2;
  }

  pid_t bridge_pgid = 0;
  if (parse_pgid(argv[1], &bridge_pgid) != 0) {
    fprintf(stderr, "invalid bridge pgid\n");
    return 2;
  }

  int result = wait_for_owner_pipe(bridge_pgid);
  if (result == 1) {
    reap_group(bridge_pgid);
    return 0;
  }
  return result == 0 ? 0 : 1;
}
