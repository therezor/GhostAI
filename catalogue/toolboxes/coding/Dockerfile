# The coding toolbox: read, run and modify code, offline.
#
# Built locally and referenced by image ID, never pulled at runtime — GhostAI
# has to come up on a machine with no internet, so the only network this image
# needs is the network that built it.
#
# Two runtimes (node, python3), git, and the navigation pair (ripgrep, jq).
# That is enough to run tests, write scripts and make focused changes to a
# project mounted in the workspace, and to install what that project pins.
#
# **This box has network access**, which most do not: its manifest's ceiling is
# `open`, because a coding box that cannot reach a registry cannot run a test
# suite whose dependencies are not already vendored. That is a real widening —
# node, python and git are arbitrary code execution, and egress turns that into
# a way out — so it is a per-toolbox decision recorded in the manifest, and
# changing it changes the hash and forces a re-approval.
#
# There is no scoped middle ground today: `allowlist` mode needs an egress
# gateway container to enforce it, and the runner refuses to start without one
# rather than quietly running wide open. Until that ships, the honest choice is
# between `none` and `open`.
FROM alpine:3.21

# One layer, no cache, versions unpinned on purpose: the image ID is the pin.
# `bash` because a toolbox lifts the exec guard's shell ban and a model
# reaching for a pipeline writes `bash -lc '…'`.
RUN apk add --no-cache \
      bash \
      git \
      nodejs \
      npm \
      python3 \
      ripgrep \
      jq \
      file \
      tini \
 && rm -rf /var/cache/apk/*

# Commits made inside the box need an identity; a placeholder one keeps `git
# commit` working and makes clear in the log that a container authored it.
RUN git config --system user.name "GhostAI coder" \
 && git config --system user.email "coder@ghostai.local" \
 && git config --system --add safe.directory '*'

# A non-root user whose uid matches the profile's `user`, so anything written
# into the mounted workspace stays editable by the host's own tools.
RUN adduser -D -u 1000 -h /home/ghost ghost

ENV HOME=/home/ghost

USER ghost
WORKDIR /workspace
