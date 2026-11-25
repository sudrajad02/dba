#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <version> [--push]"
  echo "Example: $0 0.1.2"
  echo "         $0 0.1.2 --push"
  exit 1
fi

RAW_VERSION="$1"
VERSION="${RAW_VERSION#v}"
VERSION="${VERSION#.}"
DO_PUSH="${2:-}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Error: Invalid semver version '$RAW_VERSION' (expected e.g. 0.1.2)"
  exit 1
fi

TAG="v${VERSION}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Updating version to ${VERSION} in package.json, src-tauri/tauri.conf.json, and Cargo.toml..."
node -e '
  const fs = require("fs");
  const v = process.argv[1];
  for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.version = v;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  }
  let cargo = fs.readFileSync("Cargo.toml", "utf8");
  const updated = cargo.replace(/(\[workspace\.package\][\s\S]*?version\s*=\s*")[^"]+(")/, `$1${v}$2`);
  if (updated === cargo && !cargo.includes(`version = "${v}"`)) {
    throw new Error("Could not find [workspace.package] version in Cargo.toml");
  }
  fs.writeFileSync("Cargo.toml", updated);
' "$VERSION"

echo "Updated files:"
git diff --stat package.json src-tauri/tauri.conf.json Cargo.toml

if [[ "$DO_PUSH" == "--push" ]]; then
  git add package.json src-tauri/tauri.conf.json Cargo.toml
  git commit -m "chore: release ${TAG}"
  git tag -f "${TAG}"
  git push
  git push -f origin "${TAG}"
  echo "Done! Pushed commit and tag ${TAG}."
else
  echo ""
  echo "Next steps (or re-run with --push to automate):"
  echo "  git add package.json src-tauri/tauri.conf.json Cargo.toml"
  echo "  git commit -m \"chore: release ${TAG}\""
  echo "  git tag -f ${TAG} && git push && git push -f origin ${TAG}"
fi
