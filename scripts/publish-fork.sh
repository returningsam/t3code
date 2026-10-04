#!/bin/zsh
# Builds the macOS arm64 app from origin/main and publishes it as the latest
# release on returningsam/t3code. `t3-update` in ~/.dotfiles installs from there.

set -euo pipefail

repo=returningsam/t3code
asset=T3-Code-arm64.zip

cd "$(git rev-parse --show-toplevel)"

git fetch -q origin main
if [[ -n "$(git status --porcelain)" ]]; then
  print -u2 "publish-fork: commit or stash your changes first"
  exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  print -u2 "publish-fork: HEAD is not origin/main, so push or pull first"
  exit 1
fi

sha=$(git rev-parse --short HEAD)
version=$(jq -r .version apps/desktop/package.json)
# Upstream release workflow fires on v*.*.* tags, so fork tags avoid that shape.
tag=fork-$version-$sha

if gh release view $tag --repo $repo > /dev/null 2>&1; then
  print -u2 "publish-fork: $tag is already published"
  exit 1
fi

# The rustup stable cargo is too old for the resource monitor; Homebrew cargo works.
PATH="/opt/homebrew/bin:$PATH" pnpm dist:desktop:dmg:arm64

# A fixed asset name lets t3-update download releases/latest without the GitHub API.
tmp=$(mktemp -d)
trap "rm -rf $tmp" EXIT
cp release/T3-Code-$version-arm64.zip $tmp/$asset

gh release create $tag $tmp/$asset --repo $repo --target "$(git rev-parse HEAD)" --title "T3 Code $version ($sha)" --notes "Fork build of $sha." --latest

print "Published $tag. Run t3-update to install it."
