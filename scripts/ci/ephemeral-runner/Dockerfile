ARG BASE_IMAGE=node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
FROM ${BASE_IMAGE}

ARG TARGETARCH
ARG RUNNER_VERSION=2.338.2
ARG RUNNER_RELEASE_URL=https://github.com/actions/runner/releases/download
ARG DEBIAN_MIRROR=deb.debian.org
ARG PIP_INDEX_URL=https://pypi.org/simple

RUN sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update -o Acquire::http::Timeout=30 \
    && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl gh git git-lfs jq libicu72 \
      libkrb5-3 libssl3 libunwind8 python3 python3-pip python3-venv \
      sudo tmux unzip zip zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/ci-tools \
    && /opt/ci-tools/bin/pip install --no-cache-dir 'yamllint==1.35.1' \
    && echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner

ENV PATH="/opt/ci-tools/bin:${PATH}"

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
USER node
ENTRYPOINT ["/usr/local/bin/ephemeral-runner"]
