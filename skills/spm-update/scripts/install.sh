#!/bin/sh
# Installs the spm-update binary from the latest GitHub release, after checking it against the
# release's SHA256SUMS. macOS (universal) and Linux (static x86_64/aarch64) only.
#
#   sh install.sh                 # installs to ~/.local/bin
#   SPM_UPDATE_INSTALL_DIR=/usr/local/bin sh install.sh
#   SPM_UPDATE_VERSION=2.0.0 sh install.sh   # a specific release instead of the latest
set -eu

repo="https://github.com/apptekstudios/spm-update-deps"
dir=${SPM_UPDATE_INSTALL_DIR:-"$HOME/.local/bin"}
base=${SPM_UPDATE_BASE_URL:-} # for testing: where the release assets are, instead of GitHub

fail() { echo "install.sh: $*" >&2; exit 1; }
command -v curl >/dev/null || fail "curl is required"

case "$(uname -s)/$(uname -m)" in
  Darwin/*) target=macos-universal ;;
  Linux/x86_64 | Linux/amd64) target=linux-x86_64 ;;
  Linux/aarch64 | Linux/arm64) target=linux-aarch64 ;;
  *) fail "no prebuilt binary for $(uname -s) $(uname -m); build from source: $repo#from-source" ;;
esac

version=${SPM_UPDATE_VERSION:-}
if [ -z "$version" ]; then
  # /releases/latest redirects to /releases/tag/v<version>; this needs no API token.
  url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$repo/releases/latest") || fail "could not reach $repo"
  version=${url##*/tag/v}
  [ "$version" != "$url" ] || fail "no release found at $repo/releases"
fi
[ -n "$base" ] || base="$repo/releases/download/v$version"

asset="spm-update-$version-$target.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$asset" "$base/$asset" || fail "download failed: $base/$asset"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"

expected=$(awk -v f="$asset" '$2 == f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "$asset is not listed in SHA256SUMS"
if command -v sha256sum >/dev/null; then actual=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
else actual=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1); fi
[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset"

tar -xzf "$tmp/$asset" -C "$tmp" spm-update
mkdir -p "$dir"
mv "$tmp/spm-update" "$dir/spm-update"
chmod +x "$dir/spm-update"
echo "installed $("$dir/spm-update" --version | head -1) to $dir/spm-update"
case ":$PATH:" in *":$dir:"*) ;; *) echo "note: $dir is not on PATH" ;; esac
