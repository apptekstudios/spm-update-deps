#!/usr/bin/env bash
# Prints the Homebrew formula for a release.
#
#   scripts/make-formula.sh <version> <base-url> <dist-dir>
#
# <base-url> is where the tarballs are downloaded from (the GitHub release, or file://<dir> to
# test locally); <dist-dir> holds the tarballs so their checksums can be computed.
set -euo pipefail

version=$1
base=${2%/}
dist=$3

sha() {
  local f="$dist/spm-update-$version-$1.tar.gz"
  [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
  if command -v sha256sum >/dev/null; then sha256sum "$f" | cut -d' ' -f1; else shasum -a 256 "$f" | cut -d' ' -f1; fi
}

cat <<RUBY
class SpmUpdate < Formula
  desc "Check and update Swift Package Manager dependencies in Package.swift and Xcode projects"
  homepage "https://github.com/apptekstudios/spm-update-deps"
  version "$version"
  license "MIT"

  on_macos do
    url "$base/spm-update-$version-macos-universal.tar.gz"
    sha256 "$(sha macos-universal)"
  end

  on_linux do
    on_intel do
      url "$base/spm-update-$version-linux-x86_64.tar.gz"
      sha256 "$(sha linux-x86_64)"
    end
    on_arm do
      url "$base/spm-update-$version-linux-aarch64.tar.gz"
      sha256 "$(sha linux-aarch64)"
    end
  end

  # Needs \`git\` (and \`curl\` on Linux) on PATH at runtime. They are not declared as dependencies:
  # on Linux that would make Homebrew build its own git and curl, which every system already has.

  def install
    bin.install "spm-update"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/spm-update --version")
    (testpath/"Package.swift").write <<~SWIFT
      // swift-tools-version:5.9
      import PackageDescription
      let package = Package(name: "Demo", dependencies: [.package(path: "../Local")])
    SWIFT
    assert_match "local", shell_output("#{bin}/spm-update check #{testpath} --tsv")
  end
end
RUBY
