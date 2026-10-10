#!/usr/bin/env bash
# Prints a homebrew-core style formula, which builds from source (homebrew-core does not accept
# prebuilt binaries; its CI builds the bottles).
#
#   scripts/make-core-formula.sh <version> <source-tarball-url> <source-tarball-file>
#
# For a release, the URL is https://github.com/apptekstudios/spm-update-deps/archive/refs/tags/v<version>.tar.gz
# and the file is that download, so its checksum can be computed. CI passes a `git archive` of
# HEAD with a file:// URL.
set -euo pipefail

version=$1
url=$2
file=$3

[ -f "$file" ] || { echo "missing $file" >&2; exit 1; }
if command -v sha256sum >/dev/null; then sha=$(sha256sum "$file" | cut -d' ' -f1); else sha=$(shasum -a 256 "$file" | cut -d' ' -f1); fi

cat <<RUBY
class SpmUpdate < Formula
  desc "Check and update Swift Package Manager dependencies"
  homepage "https://github.com/apptekstudios/spm-update-deps"
  url "$url"
  sha256 "$sha"
  license "MIT"

  depends_on xcode: ["15.0", :build]

  uses_from_macos "swift" => :build

  on_macos do
    depends_on macos: :ventura
  end

  deny_network_access!

  def install
    system "swift", "build", "--disable-sandbox", "--product", "spm-update", *std_swift_args
    bin.install ".build/release/spm-update"
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
