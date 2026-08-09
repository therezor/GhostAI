# The web-research toolbox: search the web, fetch and turn HTML/PDFs/documents
# into text, and map a target — enumeration, OSINT and network recon.
#
# Two jobs in one box on purpose: both are network-open and both start from the
# same handful of tools (curl, openssl, python3, jq, rg), so a researcher who
# needs to fingerprint a host and a recon agent who needs to read a page were
# paying for two container images that overlapped in the middle. Merged, one
# image serves `researcher` and `recon` alike.
#
# Built locally and referenced by image ID, never pulled at runtime — GhostAI has
# to come up on a machine with no internet, so the only network this image needs
# is the network that built it.
#
# Alpine rather than Debian because the whole point is that this is cheap to
# start: a session pays one container start. Absorbing the recon tooling makes
# this a larger image than the research box alone was — the OCR packs and the
# static Go scanners are the two heavy things in it — but it is still one start,
# and the scanners are static single binaries with no runtime dependencies.
#
# What is deliberately *absent* is a headless browser. Chromium would multiply
# the image and hand the sandbox a JavaScript engine with a network stack, which
# is a large attack surface to carry for the small number of pages that need it.
# Text extraction and `katana` (which crawls without JavaScript) handle the rest.
#
# ## On the size of the OCR data
#
# The language packs below are the largest thing in this file — thirteen of them,
# well over a hundred megabytes, most of which any given install never loads.
# That is a deliberate reversal of an earlier decision, and the reason is what a
# toolbox is *for*.
#
# A file someone attaches reaches the model as a workspace path and nothing
# else; if it is a scan, the path is the whole of what the model gets. "There is
# no OCR here" meant every scanned contract, every phone photo of a page and
# every faxed invoice was a dead end that cost a turn to discover. Unlike
# Chromium, tesseract adds no network stack and no scripting engine — it is a
# static binary over read-only data files, so the cost is disk and nothing else.
#
# The packs are one `apk add`, so trimming the list is a one-line edit for an
# install that only ever sees English.

# --- build stage: compile the Go recon tools, fully static -------------------
# `golang:alpine` unpinned on purpose, like every base here: the built image's
# id is the pin, and the ProjectDiscovery tools track a fast-moving Go minimum,
# so floating to the latest Go keeps them building rather than pinning to a
# version that goes stale under them.
FROM golang:alpine AS build

# CGO off so every binary is static and depends on nothing in the final image.
# GOTOOLCHAIN=auto so a tool that requires a newer Go than the image ships pulls
# that toolchain itself rather than failing — this stage has network.
# GOSUMDB=off so a flaky sum.golang.org lookup does not fail the build; modules
# still come through the proxy and the image is pinned by its id regardless.
ENV CGO_ENABLED=0 GOFLAGS=-buildvcs=false GOTOOLCHAIN=auto GOSUMDB=off

# Each is a single command the manifest names. `@latest` rather than a pin for
# the same reason the base image is unpinned: the built image's id is the pin,
# not the source ref it was built from.
RUN go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest \
 && go install github.com/projectdiscovery/dnsx/cmd/dnsx@latest \
 && go install github.com/projectdiscovery/httpx/cmd/httpx@latest \
 && go install github.com/projectdiscovery/katana/cmd/katana@latest \
 && go install github.com/projectdiscovery/tlsx/cmd/tlsx@latest \
 && go install github.com/lc/gau/v2/cmd/gau@latest \
 && go install github.com/tomnomnom/waybackurls@latest \
 && go install github.com/tomnomnom/gf@latest \
 && go install github.com/tomnomnom/anew@latest \
 && go install github.com/owasp-amass/amass/v4/...@master

# --- runtime stage -----------------------------------------------------------
FROM alpine:3.21

# One layer, no cache, and versions unpinned on purpose: the image ID is the
# pin. A toolbox references the built result by content hash, so what matters is
# that a given image is immutable — not that rebuilding it reproduces byte for
# byte, which alpine's rolling repos cannot promise anyway.
# `bash` is here for one reason: a toolbox lifts the exec guard's shell ban, so
# a model reaching for a pipeline writes `bash -lc '…'` — which is what it has
# seen everywhere — and busybox `ash` alone answers "bash: not found". One
# megabyte to avoid a failure mode that reads as the toolbox being broken.
RUN apk add --no-cache \
      bash \
      ca-certificates \
      curl \
      jq \
      openssl \
      ripgrep \
      w3m \
      poppler-utils \
      python3 \
      py3-lxml \
      py3-requests \
      py3-beautifulsoup4 \
      py3-pillow \
      tini \
 && rm -rf /var/cache/apk/*

# The recon and network layer. `nmap-scripts` is the NSE library `--script vuln`
# needs; `libpcap` is what the raw-socket scanners link against; `bind-tools`
# supplies dig/host/nslookup. These reach the target directly, which is why this
# box's manifest caps network at `open` and adds back `NET_RAW` for `nmap -sS`.
RUN apk add --no-cache \
      nmap \
      nmap-scripts \
      masscan \
      libpcap \
      bind-tools \
      whois \
      sslscan \
      wget \
      git \
 && rm -rf /var/cache/apk/*

# OCR, for the documents that have no text layer to extract.
#
# `poppler-utils` above already supplies `pdftoppm`, which renders a scanned page
# to an image before tesseract reads it — rendering rather than `pdfimages`,
# because a scanned page is often several stacked images plus a mask and pulling
# them out individually hands tesseract fragments in the wrong order.
#
# English is the default and the rest are opt-in per call (`doc --lang deu`).
# Loading every pack at once would be slower and *less* accurate: tesseract
# scores against each language it is given, so naming twelve it does not need
# costs time and invites wrong-alphabet matches.
RUN apk add --no-cache \
      tesseract-ocr \
      tesseract-ocr-data-eng \
      tesseract-ocr-data-deu \
      tesseract-ocr-data-fra \
      tesseract-ocr-data-spa \
      tesseract-ocr-data-ita \
      tesseract-ocr-data-por \
      tesseract-ocr-data-nld \
      tesseract-ocr-data-rus \
      tesseract-ocr-data-ukr \
      tesseract-ocr-data-swe \
      tesseract-ocr-data-nor \
      tesseract-ocr-data-dan \
      tesseract-ocr-data-fin \
 && rm -rf /var/cache/apk/*

# From pip because neither is in alpine's repos, and both are load-bearing:
#
#  - `trafilatura` scores the DOM for content density and emits markdown, which
#    is the difference between 900 tokens of documentation and 6,000 tokens of
#    documentation plus navigation. Tag-name stripping cannot do this — the modern
#    web puts its chrome in `<div class="sidebar">`, not in `<nav>`.
#
#  - `ddgs` is a metasearch library over nine backends (Brave, DuckDuckGo, Google,
#    Grokipedia, Mojeek, Startpage, Wikipedia, Yahoo, Yandex). It replaced three
#    scrapers written here, and the reason is not tidiness: scraping search
#    front-ends from one residential IP gets that IP blocked, and the answer is
#    more independent front doors rather than better selectors. Measured with
#    DuckDuckGo, Mojeek and Brave all blocking this machine at once, `auto` still
#    answered in under a second from the others.
#
# apk's `py3-lxml` is left in place and pip is told to reuse it: building lxml
# from source needs a compiler toolchain and several minutes for a library that is
# already installed.
#
# The three office readers are here for the same reason and are cheap — pure
# Python over the zip archive each format really is. `py3-pillow` comes from apk
# above rather than being pulled in here as a `python-pptx` dependency: building
# Pillow from source needs a compiler toolchain and several minutes for a library
# alpine already packages.
RUN apk add --no-cache --virtual .build py3-pip \
 && pip install --break-system-packages --no-cache-dir \
      trafilatura \
      ddgs \
      python-docx \
      openpyxl \
      python-pptx \
 && apk del .build \
 && rm -rf /root/.cache

# The compiled scanners, dropped where the rest of the PATH already looks.
COPY --from=build /go/bin/ /usr/local/bin/

# A non-root user whose uid matches the profile's `user`, so anything written
# into the mounted workspace stays editable by the host's own tools. Root-owned
# artefacts are the most common complaint about this whole pattern.
RUN adduser -D -u 1000 -h /home/ghost ghost

# Every recon binary the manifest promises, asserted at build time. A box whose
# first `httpx` or `amass` call is "not found" is worse than no box, and finding
# out here costs one layer. Keep this list in step with the manifest's `tools`.
RUN for bin in nmap masscan subfinder amass dnsx httpx katana tlsx gau \
               waybackurls whois dig sslscan wget gf anew \
               curl openssl python3 jq rg; do \
      command -v "${bin}" >/dev/null || { echo "missing: ${bin}" >&2; exit 1; }; \
    done

# Three programs, and no reference file beside them. There used to be a
# `TOOLS.md` and a `tools` command that printed it, from when the manifest could
# not describe a flag; now `expose: "tools"` turns every entry's `use`, `args`
# and `example` into a real tool schema, so the flags reach the model where it
# is already looking. A second copy in prose was a second thing to keep in step.
COPY lib/ /opt/ghost/lib/
COPY bin/ /opt/ghost/bin/
RUN chmod +x /opt/ghost/bin/*

# `PYTHONPATH` so `fetch` and `search` share one extraction module rather than two
# copies that can disagree about what a page says.
ENV PATH="/opt/ghost/bin:${PATH}" \
    PYTHONPATH="/opt/ghost/lib" \
    HOME=/home/ghost \
    PYTHONDONTWRITEBYTECODE=1

USER ghost
WORKDIR /workspace
