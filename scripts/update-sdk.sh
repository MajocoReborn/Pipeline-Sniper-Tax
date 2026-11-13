#!/usr/bin/env bash
# The site's copy of the TypeScript SDK (`@majocoreborn/sniper-tax-sdk`), until it is on npm.
#
# The SDK lives in MajocoReborn/pipeline-sniper-tax-strate (`sdk/`). This script builds its
# package at a pinned commit and puts it in app/vendor/, with the Rust client's test vectors
# from the same commit in app/test/vectors.json. `npm pack` is reproducible, so the result is
# byte for byte what that commit gives.
#
#   scripts/update-sdk.sh            # rebuild at SDK_COMMIT and update app/vendor and the vectors
#   scripts/update-sdk.sh --check    # fail unless the committed files are what SDK_COMMIT gives
#   SDK_COMMIT=<sha> scripts/update-sdk.sh   # move to another commit (then update the pin below)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SDK_REPO="${SDK_REPO:-https://github.com/MajocoReborn/pipeline-sniper-tax-strate.git}"
SDK_COMMIT="${SDK_COMMIT:-41f4fd24945222d927ab3b4147ae89972b3dcd44}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -c advice.detachedHead=false clone -q --no-checkout "$SDK_REPO" "$work/repo"
git -C "$work/repo" checkout -q "$SDK_COMMIT"
(cd "$work/repo/sdk" && npm ci --silent --no-audit --no-fund && npm pack --silent --pack-destination "$work" >/dev/null)
tarball=$(cd "$work" && ls ./*.tgz)
tarball=${tarball#./}

if [[ "${1:-}" == "--check" ]]; then
  cmp "$work/$tarball" "app/vendor/$tarball"
  cmp "$work/repo/sdk/test/vectors.json" app/test/vectors.json
  echo "app/vendor/$tarball and app/test/vectors.json are the SDK at $SDK_COMMIT." >&2
  exit 0
fi

rm -f app/vendor/*.tgz
cp "$work/$tarball" "app/vendor/$tarball"
cp "$work/repo/sdk/test/vectors.json" app/test/vectors.json
(cd app && npm install --no-audit --no-fund "./vendor/$tarball")
echo "app/vendor/$tarball: $(sha256sum "app/vendor/$tarball" | cut -d' ' -f1) (SDK at $SDK_COMMIT)" >&2
