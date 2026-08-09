#!/usr/bin/env bash
#
# Builds a toolbox image locally and installs its manifest.
#
# The image is referenced by its **image ID** — the content hash `docker build`
# produces — rather than by a registry digest, because GhostAI has to run on a
# machine with no internet. An image ID is a content address and is exactly as
# unrepointable as a registry digest; a tag is neither, and a toolbox pinned to
# one would let the thing an operator approved change underneath them.
#
# Installing is only half of it. The manifest lands on disk here; nothing will
# *run* it until its hash is approved, which is a separate operator action —
# editing a manifest silently revokes its approval, and that is the point.
#
# Usage:  catalogue/build.sh web-research
set -euo pipefail

name="${1:?usage: build.sh <toolbox-name>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
context="${here}/toolboxes/${name}"
home="${GHOSTAI_HOME:-${HOME}/.ghostai}"
target="${home}/toolboxes/${name}"

[[ -d "${context}" ]] || { echo "no such toolbox source: ${context}" >&2; exit 1; }

echo "==> building ${name}"
# `--iidfile` rather than parsing `docker images`: the latter is racy when two
# builds run, and reports a short id that cannot be pinned.
iid_file="$(mktemp)"
trap 'rm -f "${iid_file}"' EXIT
docker build --iidfile "${iid_file}" -t "ghostai/${name}:local" "${context}"

image_id="$(cat "${iid_file}")"
[[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "unexpected image id: ${image_id}" >&2
  exit 1
}

echo "==> installing manifest to ${target}"
mkdir -p "${target}"
# The placeholder is replaced rather than the file being generated, so the
# manifest an operator reviews in the repo is the manifest that gets installed
# apart from one field.
sed "s|__IMAGE_ID__|${image_id}|" "${context}/toolbox.json" > "${target}/toolbox.json"

echo
echo "    image   ${image_id}"
echo "    toolbox ${target}/toolbox.json"
echo
echo "Not yet approved. Review the manifest above, then approve it:"
echo
echo "    node packages/cli/dist/index.js toolbox approve ${name}"

# The preset that runs in this box, if one ships. Presets live in one directory
# and name their toolbox rather than sitting beside it, so this is a search
# rather than a path — and the id it prints is usually not the toolbox's name
# (`coding` is run by `coder`, `data` by `data-analyst`).
for preset in "${here}"/presets/*.json; do
  [[ -f "${preset}" ]] || continue
  if grep -Eq "\"name\"[[:space:]]*:[[:space:]]*\"${name}\"" "${preset}"; then
    echo
    echo "Then install the agent that works in it:"
    echo
    echo "    node packages/cli/dist/index.js agent install $(basename "${preset}" .json)"
  fi
done
echo
