ARG BASE_IMAGE=node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
FROM ${BASE_IMAGE}

ARG TARGETARCH
ARG RUNNER_VERSION=2.338.2
ARG RUNNER_RELEASE_URL=https://github.com/actions/runner/releases/download
ARG DEBIAN_MIRROR=deb.debian.org
ARG PIP_INDEX_URL=https://pypi.org/simple
# The default CDN 307-redirects to playwright.download.prss.microsoft.com,
# measured from the hz4/hz5 hosts at 61 KB/s for revision 1228 — a ~110 MB
# headless shell was still at 70% after six minutes when two visuals jobs were
# cancelled on 2026-11-11. The npmmirror binary mirror served the same object
# at 8.9 MB/s from the same host. Overridable for a host that can reach the
# upstream CDN faster, or that mirrors it internally.
#
# The mirror is incomplete: its `builds/cft/` starts at 148.0.7778.96, so it
# holds 1.61.1's 149.0.7827.55 and 1.62.1's 151.0.7922.34 but 404s 1.58.2's
# 145.0.7632.6 (and 1.58.2's non-CFT `builds/chromium/1208/`). The install loop
# therefore falls back to playwright's own CDN list per version, rather than
# pinning a version-to-host map that a dependency bump would silently outrun.
# A failed fallback exits the build explicitly: inside the `&&` chain below a
# loop body is exempt from `set -e`, so without the `exit` the loop could
# finish clean after a version failed.
ARG PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright

# fonts-dejavu-core supplies the DejaVu faces: verify-capture resolves bold
# through the host font stack, and the unit suite asserts a bold capture
# differs from plain; without a bold face the two rasterise identically.
RUN sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update -o Acquire::http::Timeout=30 \
    && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl ffmpeg file fonts-dejavu-core gh git git-lfs jq libicu72 \
      libkrb5-3 libssl3 libunwind8 procps python3 python3-pip python3-venv \
      sudo tmux unzip zip zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/ci-tools \
    && /opt/ci-tools/bin/pip install --no-cache-dir 'yamllint==1.35.1' \
    && echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner

ENV PATH="/opt/ci-tools/bin:${PATH}"

# Chromium and its system libraries, baked in so no job downloads them. A
# disposable container has no cache to reuse, so every visuals job paid a
# browser fetch at the CDN speed above. The install steps in ci.yml, e2e.yml
# and web-shell-visuals.yml skip themselves when PLAYWRIGHT_BROWSERS_PATH is
# set (below), so a job on this image needs no browser egress and no apt round
# trip: this image grants the runner user sudo but not root, so `--with-deps`
# in a job would fail on apt anyway. Baking the libraries here removes both.
#
# EVERY playwright in the tree resolves its own browser revision, and this tree
# carries three: 1.61.1 at the root and in web-shell, 1.62.1 under browser-use,
# and 1.58.2 pulled in transitively by mobilewright. Baking only the version the
# visuals job invokes would leave the others downloading at job time, which is
# the cost this layer exists to remove — the integration lane's own
# `install chromium webkit` reaches browser-use's.
#
# The versions are listed here rather than read from the lockfile because this
# image's build context is its own directory, not the repository root, so the
# lockfile is not available to it. The revisions are NOT listed: each is read
# from that version's own browsers.json at build time, so the mapping cannot go
# stale. scripts/tests/verify-capture.test.js compares this list against the
# lockfile, so a dependency bump fails a test instead of silently leaving a
# revision behind.
#
# `install chromium` pulls chromium-headless-shell too, and both are needed.
# ffmpeg comes from apt above rather than from playwright: it is the same
# binary revision for all three, and the archive is reachable where the
# browser CDN is not.
#
# The tree stays root-owned and world-readable: jobs run as `node` and must not
# be able to rewrite a browser the next job trusts. A job's own
# `playwright install` cannot run here regardless: it writes a lock and a
# `.links` entry into the registry before it checks what is present, and this
# tree is not writable. PLAYWRIGHT_BROWSERS_PATH is what a job's playwright
# resolves its browser from and what those install steps key their skip on, so
# it has to be an ENV, not a build-arg.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
ARG PLAYWRIGHT_VERSIONS="1.58.2 1.61.1 1.62.1"
RUN set -eu \
    && mkdir -p /opt/ci-playwright \
    && printf '%s\n' ${PLAYWRIGHT_VERSIONS} > /opt/ci-playwright/versions \
    && while read -r version; do \
         if ! PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST}" \
              npx --yes "playwright@${version}" install --with-deps chromium; then \
           echo "PLAYWRIGHT_DOWNLOAD_HOST does not serve ${version}; retrying on the upstream CDN"; \
           PLAYWRIGHT_DOWNLOAD_HOST= \
             npx --yes "playwright@${version}" install --with-deps chromium || exit 1; \
         fi; \
       done < /opt/ci-playwright/versions \
    && chmod -R a+rX /opt/ms-playwright \
    && rm -rf /root/.npm

WORKDIR /home/node/actions-runner
RUN case "${TARGETARCH}" in \
      amd64) runner_arch=x64; runner_sha=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40 ;; \
      arm64) runner_arch=arm64; runner_sha=670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945 ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL --retry 3 --connect-timeout 15 --max-time 180 -o /tmp/runner.tar.gz \
      "${RUNNER_RELEASE_URL}/v${RUNNER_VERSION}/actions-runner-linux-${runner_arch}-${RUNNER_VERSION}.tar.gz" \
    && echo "${runner_sha}  /tmp/runner.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/runner.tar.gz \
    && rm /tmp/runner.tar.gz \
    && chown -R node:node /home/node/actions-runner

COPY entrypoint.sh /usr/local/bin/ephemeral-runner
RUN chmod 755 /usr/local/bin/ephemeral-runner

# Assert the final image, not the install list: a purge or font removal in
# an earlier layer must fail the build here, not the fork-PR unit shard. One
# RUN, kept last, so every layer that can change any of it is behind it.
#
# The browser check counts revision directories against the playwrights the
# image declared: `install chromium` creates chromium-<rev> and
# chromium_headless_shell-<rev>, so at least two per version. A partial download
# leaves files inside a directory rather than a missing one, and the install
# above already fails the build on that; a revision quietly missing here is the
# download this image exists to prevent, paid at job time instead. The launch
# proves the executable and its shared libraries, which is what
# `--with-deps` is for.
RUN set -eu \
    && test -f /usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf \
    && command -v ffmpeg > /dev/null \
    && test -s /opt/ci-playwright/versions \
    && browsers="$(find /opt/ms-playwright -mindepth 1 -maxdepth 1 -type d -name 'chromium*' | wc -l)" \
    && expected="$(( $(wc -l < /opt/ci-playwright/versions) * 2 ))" \
    && echo "Chromium directories: ${browsers}, expected at least ${expected}" \
    && test "${browsers}" -ge "${expected}" \
    && chrome="$(find /opt/ms-playwright -type f -name chrome -path '*chrome-linux*' | head -1)" \
    && test -n "${chrome}" \
    && "${chrome}" --version
USER node
ENTRYPOINT ["/usr/local/bin/ephemeral-runner"]
