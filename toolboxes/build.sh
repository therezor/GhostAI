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
# Usage:  toolboxes/build.sh web-research
set -euo pipefail

name="${1:?usage: build.sh <toolbox-name>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
context="${here}/${name}"
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

# `TOOLS.md` beside the manifest, not only inside the image.
#
# Inside the image it was reachable only if the model chose to run `tools`, and it
# did not — it answered a research question from search snippets with the
# reference one command away. Here it is readable by the prompt builder, so the
# model is told rather than invited to ask. The same directory is mounted
# read-only into the container, so the in-container `tools` command still finds it.
#
# Not covered by the approval hash: see `ApprovedToolbox.docs` for why prose that
# changes nothing about what the container may *do* must not force a re-approval.
if [[ -f "${context}/TOOLS.md" ]]; then
  cp "${context}/TOOLS.md" "${target}/TOOLS.md"
  echo "    docs    ${target}/TOOLS.md"
fi

echo
echo "    image   ${image_id}"
echo "    toolbox ${target}/toolbox.json"
echo
echo "Not yet approved. Review the manifest above, then approve it:"
echo
echo "    node packages/cli/dist/index.js toolbox approve ${name}"
echo
