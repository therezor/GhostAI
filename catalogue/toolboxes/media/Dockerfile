# The media toolbox: inspect and transform audio, video and images.
#
# Built locally and referenced by image ID, never pulled at runtime — GhostAI
# has to come up on a machine with no internet, so the only network this image
# needs is the network that built it.
#
# **Alpine, with ffmpeg straight from the package repo.** That is worth stating
# because the obvious assumption is the opposite one: that a small distro means
# a cut-down ffmpeg and a full build has to be compiled from source (the
# `Vilsol/ffmpeg-alpine` approach). Measured rather than assumed — Alpine 3.21's
# `ffmpeg` carries libx264, libx265, libvpx-vp9, libaom-av1, **libsvtav1**,
# libopus, libmp3lame, libvorbis and libwebp. That is a superset of Debian's
# build, which has no SVT-AV1 encoder at all, for a fraction of the size and
# with no source build to wait on or maintain.
#
# Alpine also ships **ImageMagick 7**, so `magick` is the real command. On
# Debian it is ImageMagick 6, whose tools are `convert`/`identify`, and this
# manifest needed a dispatch shim to keep the name a model expects. That shim
# is gone.
#
# Six programs, each for a job the others do badly:
#
#  - **ffmpeg/ffprobe** — anything with a timeline.
#  - **ImageMagick** — still images. A resize is one argument here and a filter
#    graph in ffmpeg.
#  - **sox** — audio as a signal rather than as a stream: normalise, fade,
#    concatenate, measure loudness.
#  - **exiftool** — metadata, both directions. Reading the camera and GPS a
#    photo carries, and *stripping* them before something is shared.
#  - **mediainfo** — the human-readable inventory of a container, where
#    `ffprobe` is the machine-readable one.
#  - **gifsicle** — GIFs, which ffmpeg makes badly and this makes small.
FROM alpine:3.21

# One layer, no cache, and versions unpinned on purpose: the image ID is the
# pin. A toolbox references the built result by content hash, so what matters
# is that a given image is immutable — not that rebuilding it reproduces byte
# for byte, which Alpine's rolling repos cannot promise anyway.
#
# `bash` because a toolbox lifts the exec guard's shell ban, so a model
# reaching for a pipeline writes `bash -lc '…'` — which is what it has seen
# everywhere — and busybox `ash` alone answers "bash: not found".
RUN apk add --no-cache \
      bash \
      ffmpeg \
      imagemagick \
      imagemagick-jpeg \
      imagemagick-webp \
      imagemagick-heic \
      imagemagick-tiff \
      sox \
      exiftool \
      mediainfo \
      gifsicle \
 && rm -rf /var/cache/apk/*

# Everything the manifest promises, asserted at build time. A media box whose
# first `-c:v libx264` or `magick` call fails is worse than no media box, and
# finding out here costs one layer. This list is the manifest's `tools` array
# plus the encoders the tool descriptions name — keep them in step.
RUN for encoder in libx264 libx265 libvpx-vp9 libaom-av1 libsvtav1 libopus libmp3lame; do \
      ffmpeg -hide_banner -encoders 2>/dev/null | grep -q " ${encoder} " \
        || { echo "missing encoder: ${encoder}" >&2; exit 1; }; \
    done \
 && ffprobe -version >/dev/null \
 && magick -version >/dev/null \
 && sox --version >/dev/null \
 && exiftool -ver >/dev/null \
 && mediainfo --Version >/dev/null \
 && gifsicle --version >/dev/null

# A non-root user whose uid matches the profile's `user`, so anything written
# into the mounted workspace stays editable by the host's own tools. Root-owned
# artefacts are the most common complaint about this whole pattern.
RUN adduser -D -u 1000 -h /home/ghost ghost

ENV HOME=/home/ghost

USER ghost
WORKDIR /workspace
