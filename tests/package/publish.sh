#!/usr/bin/env bash
# The Release workflow's gate and its last step, in one script, so that the
# two ways to start a release (a version tag pushed, or a run by hand with
# `release` checked) and a run by hand without it share every step:
#
#   tests/package/publish.sh gate                    (first job, before anything is built)
#   tests/package/publish.sh dry-run <packages dir>  (a run by hand, `release` off)
#   tests/package/publish.sh publish <packages dir>  (a tag, or a run by hand with `release` on)
#
# How the run was started (GITHUB_EVENT_NAME, GITHUB_REF and RELEASE, the
# `release` input) gives the start:
#   tag       a tag pushed by hand: it must be v<version>, and it exists;
#   dispatch  a run by hand with `release`: it must be on main, and the tag
#             must not exist yet (the release creates it, at GITHUB_SHA);
#   dry       a run by hand without `release`: nothing is created.
#
# The gate (the `gate` mode, and again first in `publish`): the version from
# CMakeLists.txt; CHANGELOG.md's section for it, not empty; the start's
# rules above; and no release of v<version>, published or draft, except a
# draft that a failed run left behind, which `publish` replaces. In `dry`
# the gate only reports what a release run would meet.
#
# `dry-run` and `publish` then require the packages folder to hold exactly
# the four packages of the version, regular and not empty, and nothing else,
# and print what would be created: the tag, the title, the notes and the four
# files with their sizes. Only `publish` goes on: it creates the release as
# a draft with the four files (a draft has no tag: GitHub creates the tag
# when the release is published), checks that it lists exactly those four
# with the same sizes, publishes it, and checks that the tag points at
# GITHUB_SHA. A run that fails leaves at most a draft, which nobody without
# write access sees and the next run replaces; never a tag of its own.
set -euo pipefail
MODE="${1:?usage: publish.sh gate | dry-run <packages dir> | publish <packages dir>}"
case "$MODE" in
  gate) ;;
  dry-run | publish) DIR="${2:?usage: publish.sh $MODE <packages dir>}" ;;
  *) echo "publish.sh: the mode is gate, dry-run or publish" >&2; exit 2 ;;
esac
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO="${GITHUB_REPOSITORY:?publish.sh: GITHUB_REPOSITORY is not set}"
SHA="${GITHUB_SHA:?publish.sh: GITHUB_SHA is not set}"

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

# ---------------------------------------------------------------- the start
if [ "${GITHUB_EVENT_NAME:-}" = push ] && [[ "${GITHUB_REF:-}" == refs/tags/* ]]; then
  START=tag
elif [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ] && [ "${RELEASE:-false}" = true ]; then
  START=dispatch
elif [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ]; then
  START=dry
else
  echo "publish.sh: started by '${GITHUB_EVENT_NAME:-}' at '${GITHUB_REF:-}', which makes no release" >&2
  exit 1
fi
case "$MODE/$START" in
  publish/dry) echo "publish.sh: publish needs a tag or a run with release checked" >&2; exit 1 ;;
  dry-run/tag | dry-run/dispatch) echo "publish.sh: this run makes a release; dry-run is for runs without it" >&2; exit 1 ;;
esac

# What the repository holds: GitHub's answer, or a failure (never "absent" for an error).
api() { gh api "$@" 2>&1; }
TAG_SHA=""
if out="$(api "repos/$REPO/git/ref/tags/$TAG" --jq .object.sha)"; then
  TAG_SHA="$out"
elif ! grep -q "HTTP 404" <<<"$out"; then
  echo "publish.sh: cannot read the tags of $REPO: $out" >&2
  exit 1
fi
# Releases, drafts included (a draft is not found by its tag): "<id> <draft>" per release of TAG.
releases_of_tag() {
  local all
  all="$(api "repos/$REPO/releases" --paginate --jq ".[] | select(.tag_name == \"$TAG\") | \"\(.id) \(.draft)\"")" || {
    echo "publish.sh: cannot read the releases of $REPO: $all" >&2
    return 1
  }
  printf '%s\n' "$all" | sed '/^$/d'
}

NOTES="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/notes.XXXXXX")"
trap 'rm -f "$NOTES"' EXIT

# ---------------------------------------------------------------- the gate
gate() {
  local problems=() line id draft
  awk -v h="## $V" '$0 == h {on = 1; next} on && /^## / {exit} on' "$ROOT/CHANGELOG.md" >"$NOTES"
  grep -q '[^[:space:]]' "$NOTES" || problems+=("CHANGELOG.md has no section ## $V")
  case "$START" in
    tag)
      [ "${GITHUB_REF_NAME:-}" = "$TAG" ] || problems+=("the tag being built is '${GITHUB_REF_NAME:-}', not $TAG")
      [ "$TAG_SHA" = "$SHA" ] || problems+=("the tag $TAG points at '${TAG_SHA:-nothing}', not at this run's commit $SHA")
      ;;
    dispatch)
      [ "${GITHUB_REF:-}" = refs/heads/main ] || problems+=("a release is made from main; this run is on '${GITHUB_REF:-}'")
      [ -z "$TAG_SHA" ] || problems+=("the tag $TAG exists already (at $TAG_SHA): the release exists, or a tag was pushed")
      ;;
  esac
  DRAFTS=()
  local listed
  listed="$(releases_of_tag)" || exit 1
  while read -r id draft; do
    [ -n "${id:-}" ] || continue
    if [ "$draft" = true ]; then DRAFTS+=("$id"); else problems+=("the release $TAG exists (published, id $id)"); fi
  done <<<"$listed"
  [ "${#DRAFTS[@]}" -eq 0 ] || echo "a draft of $TAG exists (id ${DRAFTS[*]}), left by a failed run; publish replaces it"
  echo "start: $START; version $V; tag $TAG $(if [ -n "$TAG_SHA" ]; then echo "at $TAG_SHA"; else echo "(not yet)"; fi); commit $SHA"
  if [ "${#problems[@]}" -gt 0 ]; then
    for p in "${problems[@]}"; do echo "gate: $p" >&2; done
    if [ "$START" = dry ]; then
      echo "(a run without release makes nothing: a release run would stop here)"
      return 0
    fi
    return 1
  fi
  echo "gate: open"
}

gate || exit 1
[ "$MODE" = gate ] && exit 0

# ---------------------------------------------------------------- the packages
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

sizes() { for f in "${FILES[@]}"; do printf '%s %s\n' "$(basename "$f")" "$(wc -c <"$f" | tr -d ' ')"; done | LC_ALL=C sort; }
echo "== release $TAG of $REPO, at $SHA"
echo "title: $TITLE"
echo "files:"
sizes | awk '{printf "  %12d  %s\n", $2, $1}'
echo "notes ($(wc -l <"$NOTES" | tr -d ' ') lines):"
sed 's/^/  | /' "$NOTES"

if [ "$MODE" = dry-run ]; then
  echo "dry run: nothing created (a run with release checked, or a tag $TAG, would create this release)"
  exit 0
fi

# ---------------------------------------------------------------- the release
for id in "${DRAFTS[@]}"; do
  echo "deleting the draft $id left by a failed run"
  api -X DELETE "repos/$REPO/releases/$id" >/dev/null
done
# The two starts differ only here: a pushed tag exists, and the release must
# use it (--verify-tag); otherwise the release names the commit, and GitHub
# creates the tag there when the draft is published.
if [ "$START" = tag ]; then WHERE=(--verify-tag); else WHERE=(--target "$SHA"); fi
gh release create "$TAG" "${FILES[@]}" -R "$REPO" --draft "${WHERE[@]}" --title "$TITLE" --notes-file "$NOTES"
listed="$(releases_of_tag)"
ids="$(awk '$2 == "true" {print $1}' <<<"$listed")"
[ "$(wc -w <<<"$ids")" -eq 1 ] || { echo "publish.sh: expected one draft of $TAG, found: $listed" >&2; exit 1; }
ID="$ids"
assets="$(api "repos/$REPO/releases/$ID/assets" --paginate --jq '.[] | "\(.name) \(.size)"' | LC_ALL=C sort)"
if [ "$assets" != "$(sizes)" ]; then
  echo "publish.sh: the draft lists other files than the four packages; it stays a draft" >&2
  diff <(sizes) <(echo "$assets") >&2 || true
  exit 1
fi
# The gate once more, right before the release becomes real (nothing may
# have appeared since the first one: a tag, a release).
TAG_NOW=""
if out="$(api "repos/$REPO/git/ref/tags/$TAG" --jq .object.sha)"; then TAG_NOW="$out"
elif ! grep -q "HTTP 404" <<<"$out"; then echo "publish.sh: cannot read the tags of $REPO: $out" >&2; exit 1; fi
[ "$TAG_NOW" = "$TAG_SHA" ] || { echo "publish.sh: the tag $TAG changed during the run (now '${TAG_NOW:-none}'); the release stays a draft" >&2; exit 1; }
published="$(awk '$2 == "false"' <<<"$listed")"
[ -z "$published" ] || { echo "publish.sh: a published release $TAG appeared during the run; the draft stays" >&2; exit 1; }
api -X PATCH "repos/$REPO/releases/$ID" -F draft=false >/dev/null
# What was made: the tag at the commit, the release published with the four files.
made="$(api "repos/$REPO/git/ref/tags/$TAG" --jq .object.sha)" || { echo "publish.sh: no tag $TAG after publishing: $made" >&2; exit 1; }
[ "$made" = "$SHA" ] || { echo "publish.sh: the tag $TAG points at $made, not $SHA" >&2; exit 1; }
gh release view "$TAG" -R "$REPO" --json name,tagName,isDraft,isPrerelease,url,assets \
  --jq '"\(.name): \(.url)\ndraft \(.isDraft), pre-release \(.isPrerelease)\n" + ([.assets[] | "  \(.size)  \(.name)"] | join("\n"))'
echo "published $TAG at $SHA"
