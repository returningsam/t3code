#!/bin/zsh
# Builds the macOS arm64 app from origin/main and publishes it as the latest
# release on returningsam/t3code. Installed apps update from there through
# electron-updater, and `t3-update` in ~/.dotfiles does a first install.

set -euo pipefail

repo=returningsam/t3code
identity="T3 Fork Local"
leaf=5d4aaf3fd7ba4069c1f08e3a6766f3318da181ff
asset=T3-Code-arm64.zip

cd "$(git rev-parse --show-toplevel)"

# Squirrel.Mac only installs an update signed with the running app's certificate.
if [[ $(security find-identity -v -p codesigning) != *"${(U)leaf} \"$identity\""* ]]; then
  print -u2 "publish-fork: \"$identity\" is not a valid signing identity, so trust it with: security find-certificate -c \"$identity\" -p > /tmp/t3-fork.pem && security add-trusted-cert -p codeSign /tmp/t3-fork.pem"
  exit 1
fi

git fetch -q origin main
if [[ -n "$(git status --porcelain)" ]]; then
  print -u2 "publish-fork: commit or stash your changes first"
  exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  print -u2 "publish-fork: HEAD is not origin/main, so push or pull first"
  exit 1
fi

# Without the public relay config the build ships with T3 Connect turned off.
if [[ -z "${T3CODE_RELAY_URL:-}" ]] && ! grep -qs '^T3CODE_RELAY_URL=.' .env .env.local; then
  print -u2 "publish-fork: T3CODE_RELAY_URL is unset, so run cp .env.example .env first"
  exit 1
fi

git fetch -q upstream --tags
upstream=$(git tag --merged HEAD -l 'v*' --sort=-v:refname | grep -Em1 '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)
if [[ -z $upstream ]]; then
  print -u2 "publish-fork: no upstream release tag in HEAD's history, so fetch upstream tags first"
  exit 1
fi
sha=$(git rev-parse --short HEAD)
# electron-updater only offers a greater semver, and the commit count keeps growing.
version=${upstream#v}-fork.$(git rev-list --count HEAD)
# Upstream's release workflow fires on v*.*.* tags, so fork tags drop the v.
tag=$version
zip=T3-Code-$version-arm64.zip

if gh release view $tag --repo $repo > /dev/null 2>&1; then
  print -u2 "publish-fork: $tag is already published"
  exit 1
fi
previous=$(gh release view --repo $repo --json tagName -q .tagName 2>/dev/null || true)
if [[ $previous == *-fork.* && $(print -l $previous $version | sort -V | tail -1) != $version ]]; then
  print -u2 "publish-fork: $version is not newer than the published $previous"
  exit 1
fi

rm -f release/*.yml(N) release/$zip release/$zip.blockmap

# The rustup stable cargo is too old for the resource monitor; Homebrew cargo works.
PATH="/opt/homebrew/bin:$PATH" T3CODE_DESKTOP_VERSION=$version T3CODE_DESKTOP_UPDATE_REPOSITORY=$repo CSC_NAME=${(U)leaf} \
  pnpm dist:desktop:dmg:arm64

tmp=$(mktemp -d)
trap "rm -rf $tmp" EXIT
ditto -x -k release/$zip $tmp/unzipped
app=($tmp/unzipped/*.app(N))
if [[ ${#app} -ne 1 ]]; then
  print -u2 "publish-fork: $zip does not hold exactly one app"
  exit 1
fi
if ! codesign --verify --deep --strict -R="identifier \"com.t3tools.t3code\" and certificate leaf = H\"$leaf\"" $app[1]; then
  print -u2 "publish-fork: the app is not signed by \"$identity\", so installed apps would reject the update"
  exit 1
fi
if ! grep -qx "owner: ${repo%/*}" $app[1]/Contents/Resources/app-update.yml; then
  print -u2 "publish-fork: the app has no update feed for $repo"
  exit 1
fi
if ! grep -q "url: $zip\$" release/latest-mac.yml; then
  print -u2 "publish-fork: release/latest-mac.yml does not name $zip"
  exit 1
fi

# A fixed asset name lets t3-update download releases/latest without the GitHub API.
cp release/$zip $tmp/$asset

gh release create $tag release/latest-mac.yml release/$zip release/$zip.blockmap $tmp/$asset \
  --repo $repo --target "$(git rev-parse HEAD)" --title "T3 Code $version ($sha)" --notes "Fork build of $sha." --latest

print "Published $tag. Installed apps pick it up through their updater, and t3-update installs it on a new machine."
