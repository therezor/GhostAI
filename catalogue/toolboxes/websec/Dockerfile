# The websec toolbox: find and confirm web vulnerabilities, plus test
# authentication — for authorized security testing. Offline once built.
#
# Built locally and referenced by image ID, never pulled at runtime — GhostAI
# has to come up on a machine with no internet, so the only network this image
# needs is the network that built it.
#
# **This box has network access and runs active tooling.** Everything in it
# sends real payloads at a target: sqlmap dumps databases, dalfox fires XSS,
# hydra brute-forces logins. Its ceiling is `open` because none of that works
# without egress, and that is a real widening recorded in the manifest — this
# box acts against a target, and narrowing it back to `none` makes it inert.
#
# **Alpine, static Go binaries, and self-contained scripts.** The scanners
# (nuclei, ffuf, gobuster, dalfox) are single static binaries built in the stage
# below; sqlmap, commix, nikto and jwt_tool are self-contained repos wrapped by
# a one-line launcher; hydra and john come straight from Alpine. Nuclei's
# templates and a curated wordlist subset are baked in so the box works with no
# further downloads.
#
# What is deliberately absent is anything that drags in a headless browser or a
# fragile native build — content discovery is ffuf plus gobuster rather than a
# release-binary tool whose musl/arm64 build is a coin toss.

# --- build stage: compile the Go scanners against the target, fully static ----
# `golang:alpine` unpinned on purpose, like every base here: the built image's
# id is the pin, and the scanners track a fast-moving Go minimum (nuclei already
# wants Go >= 1.26), so floating to the latest Go is what keeps them building.
FROM golang:alpine AS build

# GOTOOLCHAIN=auto so a tool requiring a newer Go than the image ships pulls
# that toolchain itself rather than failing — this stage has network.
# GOSUMDB=off so a flaky sum.golang.org lookup does not fail the build; modules
# still come through the proxy and the image is pinned by its id regardless.
ENV CGO_ENABLED=0 GOFLAGS=-buildvcs=false GOTOOLCHAIN=auto GOSUMDB=off

RUN go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest \
 && go install github.com/ffuf/ffuf/v2@latest \
 && go install github.com/OJ/gobuster/v3@latest \
 && go install github.com/hahwul/dalfox/v2@latest

# --- runtime stage ------------------------------------------------------------
FROM alpine:3.21

# One layer, no cache, versions unpinned on purpose: the image ID is the pin.
# `bash` because a toolbox lifts the exec guard's shell ban and a model reaching
# for a pipeline writes `bash -lc '…'`. `perl` is what nikto runs on; `hydra`
# and `john` are the credential tools straight from Alpine.
RUN apk add --no-cache \
      bash \
      ca-certificates \
      perl \
      python3 \
      py3-requests \
      curl \
      openssl \
      git \
      jq \
      ripgrep \
      hydra \
      john \
      tini \
 && rm -rf /var/cache/apk/*

# The Python tools that are clean pip installs — console scripts land on PATH.
# `pycryptodomex`/`termcolor`/`cprint` are jwt_tool's runtime deps and ship
# musllinux wheels, so no compiler is needed; a `.build` virtual group carries
# pip itself and is deleted after, the same shape web-research uses.
RUN apk add --no-cache --virtual .build py3-pip \
 && pip install --break-system-packages --no-cache-dir \
      wafw00f \
      arjun \
      pycryptodomex \
      termcolor \
      cprint \
 && apk del .build \
 && rm -rf /root/.cache

# The self-contained repos, each behind a one-line launcher on PATH. `--depth 1`
# because history is not wanted; the image id pins the result regardless of ref.
RUN git clone --depth 1 https://github.com/sqlmapproject/sqlmap.git /opt/ghost/sqlmap \
 && git clone --depth 1 https://github.com/commixproject/commix.git /opt/ghost/commix \
 && git clone --depth 1 https://github.com/sullo/nikto.git /opt/ghost/nikto \
 && git clone --depth 1 https://github.com/ticarpi/jwt_tool.git /opt/ghost/jwt_tool \
 && rm -rf /opt/ghost/*/.git \
 && printf '#!/bin/sh\nexec python3 /opt/ghost/sqlmap/sqlmap.py "$@"\n'   > /usr/local/bin/sqlmap \
 && printf '#!/bin/sh\nexec python3 /opt/ghost/commix/commix.py "$@"\n'   > /usr/local/bin/commix \
 && printf '#!/bin/sh\nexec perl /opt/ghost/nikto/program/nikto.pl "$@"\n' > /usr/local/bin/nikto \
 && printf '#!/bin/sh\nexec python3 /opt/ghost/jwt_tool/jwt_tool.py "$@"\n' > /usr/local/bin/jwt_tool \
 && chmod +x /usr/local/bin/sqlmap /usr/local/bin/commix /usr/local/bin/nikto /usr/local/bin/jwt_tool

# Nuclei's templates and a curated SecLists subset, baked so the box needs no
# downloads at run time. The full SecLists (and rockyou) are deliberately left
# out — a few hundred kilobytes of the lists actually reached for, not a
# gigabyte of everything.
RUN git clone --depth 1 https://github.com/projectdiscovery/nuclei-templates.git /opt/ghost/nuclei-templates \
 && rm -rf /opt/ghost/nuclei-templates/.git \
 && mkdir -p /opt/ghost/wordlists \
 && base="https://raw.githubusercontent.com/danielmiessler/SecLists/master" \
 && curl -fsSL "${base}/Discovery/Web-Content/common.txt"                  -o /opt/ghost/wordlists/common.txt \
 && curl -fsSL "${base}/Discovery/Web-Content/raft-medium-directories.txt" -o /opt/ghost/wordlists/raft-medium-directories.txt \
 && curl -fsSL "${base}/Usernames/top-usernames-shortlist.txt"            -o /opt/ghost/wordlists/top-usernames-shortlist.txt \
 && curl -fsSL "${base}/Passwords/Common-Credentials/10k-most-common.txt"  -o /opt/ghost/wordlists/top-10000-passwords.txt

# The compiled scanners.
COPY --from=build /go/bin/ /usr/local/bin/

# Everything the manifest promises, asserted at build time — a box whose first
# `sqlmap` or `nuclei` call is "not found" is worse than no box. This list is
# the manifest's `tools` array; the two directories are what its `notes` point
# tools at. Keep them in step.
RUN for bin in nuclei ffuf gobuster dalfox sqlmap commix nikto wafw00f arjun \
               hydra john jwt_tool curl openssl python3 jq rg; do \
      command -v "${bin}" >/dev/null || { echo "missing: ${bin}" >&2; exit 1; }; \
    done \
 && [ -f /opt/ghost/nuclei-templates/TEMPLATES-STATS.json ] \
      || [ -d /opt/ghost/nuclei-templates/http ] \
      || { echo "nuclei-templates missing" >&2; exit 1; } \
 && [ -s /opt/ghost/wordlists/common.txt ] \
      || { echo "wordlists missing" >&2; exit 1; }

# A non-root user whose uid matches the profile's `user`, so anything written
# into the mounted workspace stays editable by the host's own tools.
RUN adduser -D -u 1000 -h /home/ghost ghost

ENV HOME=/home/ghost

USER ghost
WORKDIR /workspace
