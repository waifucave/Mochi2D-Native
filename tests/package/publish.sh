#!/usr/bin/env bash
# The Release workflow's last step, in one script for both of its modes, so
# that a run by hand exercises everything a tag's run does but the release:
#
#   tests/package/publish.sh dry-run <packages dir>   (workflow_dispatch)
#   tests/package/publish.sh publish <packages dir>   (a version tag)
#
# Both modes:
#   1. read the project's version from CMakeLists.txt;
#   2. require the packages folder to hold exactly the four packages of that
#      version, each a regular file that is not empty, and nothing else;
#   3. take CHANGELOG.md's section for the version as the notes (a temporary file),
#      which must not be empty;
#   4. require that no published release of the tag exists yet (GH_TOKEN,
#      read access, and GITHUB_REPOSITORY);
#   5. print what would be created: the tag, the title, the notes and the
#      four files with their sizes.
# Only `publish` then requires the tag being built to be v<version>, and
# creates the release: as a draft with the four files, checked to list
# exactly those four with the same sizes, and only then published. A run
# that fails leaves at most a draft, which nobody else sees and which the
# next run replaces.
set -euo pipefail
MODE="${1:?usage: publish.sh dry-run|publish <packages dir>}"
DIR="${2:?usage: publish.sh dry-run|publish <packages dir>}"
case "$MODE" in dry-run | publish) ;; *) echo "publish.sh: mode is dry-run or publish" >&2; exit 2 ;; esac
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO="${GITHUB_REPOSITORY:?publish.sh: GITHUB_REPOSITORY is not set}"

V="$(sed -n 's/^project(mochi2d_native VERSION \([0-9.]*\) .*/\1/p' "$ROOT/CMakeLists.txt")"
[ -n "$V" ] || { echo "publish.sh: no project version in CMakeLists.txt" >&2; exit 1; }
TAG="v$V"
TITLE="Mochi2D Native $TAG"
EXPECTED=(
  "mochi2d-native-$V-linux-arm64.tar.gz"
  "mochi2d-native-$V-linux-x64.tar.gz"
  "mochi2d-native-$V-macos-universal.tar.gz"
  "mochi2d-native-$V-windows-x64.zip"
)

# 2. Exactly the four packages, nothing else (no folders, no other artifacts).
found="$(cd "$DIR" && find . -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)"
wanted="$(printf '%s\n' "${EXPECTED[@]}" | LC_ALL=C sort)"
if [ "$found" != "$wanted" ]; then
  echo "publish.sh: $DIR must hold exactly the four packages of $V" >&2
  diff <(echo "$wanted") <(echo "$found") >&2 || true
  exit 1
fi
FILES=()
for f in "${EXPECTED[@]}"; do
  [ -f "$DIR/$f" ] && [ ! -L "$DIR/$f" ] && [ -s "$DIR/$f" ] || { echo "publish.sh: $f is not a non-empty file" >&2; exit 1; }
  FILES+=("$DIR/$f")
done

# 3. The notes.
NOTES="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/notes.XXXXXX")"
trap 'rm -f "$NOTES"' EXIT
awk -v h="## $V" '$0 == h {on = 1; next} on && /^## / {exit} on' "$ROOT/CHANGELOG.md" > "$NOTES"
grep -q '[^[:space:]]' "$NOTES" || { echo "publish.sh: CHANGELOG.md has no section ## $V" >&2; exit 1; }

# 4. No published release of the tag yet.
state=""
if out="$(gh release view "$TAG" -R "$REPO" --json isDraft --jq .isDraft 2>&1)"; then
  state="$out"
  [ "$state" = "true" ] || { echo "publish.sh: a published release $TAG already exists" >&2; exit 1; }
  echo "a draft release $TAG exists; publish replaces it"
elif ! grep -qi "not found" <<<"$out"; then
  # Not "no such release": the releases could not be read, so nothing is known.
  echo "publish.sh: cannot read the releases of $REPO: $out" >&2
  exit 1
fi

# 5. What would be created.
sizes() { for f in "${FILES[@]}"; do printf '%s %s\n' "$(basename "$f")" "$(wc -c <"$f" | tr -d ' ')"; done | LC_ALL=C sort; }
echo "== release $TAG of $REPO"
echo "title: $TITLE"
echo "files:"
sizes | awk '{printf "  %12d  %s\n", $2, $1}'
echo "notes ($(wc -l <"$NOTES" | tr -d ' ') lines):"
sed 's/^/  | /' "$NOTES"

if [ "$MODE" = dry-run ]; then
  echo "dry run: nothing created (a tag $TAG would create this release)"
  exit 0
fi

# publish: only for the tag of this version.
[ "${GITHUB_REF_NAME:-}" = "$TAG" ] || { echo "publish.sh: the tag being built is '${GITHUB_REF_NAME:-}', not $TAG" >&2; exit 1; }
if [ "$state" = "true" ]; then gh release delete "$TAG" -R "$REPO" --yes; fi
gh release create "$TAG" "${FILES[@]}" -R "$REPO" --draft --verify-tag --title "$TITLE" --notes-file "$NOTES"
listed="$(gh release view "$TAG" -R "$REPO" --json assets --jq '.assets[] | "\(.name) \(.size)"' | LC_ALL=C sort)"
if [ "$listed" != "$(sizes)" ]; then
  echo "publish.sh: the draft lists other files than the four packages; it stays a draft" >&2
  diff <(sizes) <(echo "$listed") >&2 || true
  exit 1
fi
gh release edit "$TAG" -R "$REPO" --draft=false
echo "published $TAG"
