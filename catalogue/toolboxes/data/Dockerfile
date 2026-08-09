# The data toolbox: data files, documents, and the tools to get inside both.
#
# Built locally and referenced by image ID, never pulled at runtime — GhostAI
# has to come up on a machine with no internet, so the only network this image
# needs is the network that built it.
#
# **Documents live here rather than in a box of their own**, and the reason is
# what actually arrives in a workspace: a zip of spreadsheets, a PDF with a
# table in it, a CSV export beside a Word summary. Splitting "convert it" from
# "query it" put a container boundary through the middle of one job, so the
# agent that read the document could not count the rows and the one that could
# count could not open the file. One box, one turn.
#
# The pieces:
#
#  - **anydoc** — Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV and PDF
#    to markdown. Pure Rust, no models, no network.
#  - **miller (`mlr`)** — CSV, TSV and JSON as records: stats, filter, cut,
#    join, reshape, and conversion between all three.
#  - **sqlite3** — a `.db` someone attaches is a sqlite file, and `.import`
#    turns a CSV into a table when a question really wants SQL.
#  - **jq** / **yq** — JSON, and YAML/XML/TOML.
#  - **exiftool** — what a file says about itself: camera, timestamps, author,
#    the PDF producer that reveals which tool made it.
#  - **strings** and **7z** — the "what is actually in this blob" pair. `7z`
#    lists and extracts far more container formats than `unzip` alone, which is
#    most of what a carving tool is wanted for here.
#
# **No duckdb.** It was here to run SQL straight over CSV, which `mlr` now does
# as record operations and `sqlite3 .import` does as real SQL — and it was the
# only reason this image needed glibc, a pinned release URL and a build-time
# download. Alpine, and one less thing pinned by hand.
FROM alpine:3.21

# One layer, no cache, versions unpinned on purpose: the image ID is the pin. A
# toolbox references the built result by content hash, so what matters is that
# a given image is immutable — not that rebuilding it reproduces byte for byte,
# which Alpine's rolling repos cannot promise anyway.
#
# `bash` because a toolbox lifts the exec guard's shell ban, so a model
# reaching for a pipeline writes `bash -lc '…'` and busybox `ash` is not it.
# `binutils` is here for `strings` alone, which is worth the layer.
RUN apk add --no-cache \
      bash \
      binutils \
      exiftool \
      file \
      jq \
      miller \
      nodejs \
      npm \
      ripgrep \
      sqlite \
      tar \
      xz \
      yq-go \
      zip \
      7zip \
 && rm -rf /var/cache/apk/*

# The document converter, then the proof it actually converts.
#
# **`--help` is not the assertion.** It exits 0 with the native binding
# missing, so an image whose first real conversion would die passes a
# help-check happily — which is exactly what happened on a base whose npm had
# the optional-dependency bug (npm/cli#4828). Converting a file is the only
# check that loads the binding, and it costs one layer. Alpine's npm is
# current, and anydoc publishes a musl build, so this resolves natively.
RUN npm install -g @firecrawl/anydoc \
 && npm cache clean --force \
 && printf 'a,b\n1,2\n' > /tmp/probe.csv \
 && anydoc /tmp/probe.csv | grep -q 1 \
 && rm /tmp/probe.csv

# Everything else the manifest promises, asserted at build time. This list is
# the manifest's `tools` array — keep them in step.
RUN mlr --version >/dev/null \
 && sqlite3 --version >/dev/null \
 && jq --version >/dev/null \
 && yq --version >/dev/null \
 && exiftool -ver >/dev/null \
 && strings --version >/dev/null \
 && 7z i >/dev/null \
 && file --version >/dev/null \
 && rg --version >/dev/null

# A non-root user whose uid matches the profile's `user`, so anything written
# into the mounted workspace stays editable by the host's own tools.
RUN adduser -D -u 1000 -h /home/ghost ghost

ENV HOME=/home/ghost

USER ghost
WORKDIR /workspace
