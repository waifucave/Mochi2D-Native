#!/usr/bin/env bash
# The Release workflow's gate and its last step, in one script, so that the
# two ways to start a release (a version tag pushed, or a run by hand with
# `release` checked), a rehearsal, and a run by hand with neither share every
# step:
#
#   tests/package/publish.sh gate                    (first job, before anything is built)
#   tests/package/publish.sh dry-run <packages dir>  (a run by hand, both boxes off)
#   tests/package/publish.sh publish <packages dir>  (a tag, or a run by hand with `release` or `rehearsal`)
#
# How the run was started (GITHUB_EVENT_NAME, GITHUB_REF, and the inputs
# RELEASE and REHEARSAL) gives the start:
#   tag        a tag pushed by hand: it must be v<version>, and it exists;
#   dispatch   a run by hand with `release`: it must be on main, and the tag
#              must not exist yet (the release creates it, at GITHUB_SHA);
#   rehearsal  a run by hand with `rehearsal`, in a private repository only:
#              every call of a release by hand, with a throwaway tag
#              rehearsal-<run number> instead of v<version>, a pre-release
#              titled REHEARSAL, and then both removed again;
#   dry        a run by hand with neither: nothing is created.
#
# The gate (the `gate` mode, and again first in `publish`): the version from
# CMakeLists.txt; CHANGELOG.md's section for it, not empty; the start's
# rules above; and no release of the tag, published or draft, except (for a
# real version) a draft that a failed run left behind, which `publish`
# replaces. In `dry` the gate only reports what a release run would meet.
#
# `dry-run` and `publish` then require the packages folder to hold exactly
# the four packages of the version, regular and not empty, and nothing else,
# and print what would be created: the tag, the title, the notes and the four
# files with their sizes. Only `publish` goes on: it creates the release as
# a draft with the four files (a draft has no tag: GitHub creates the tag
# when the release is published), checks that it lists exactly those four
# with the same sizes, reads the tag and the releases again, publishes it,
# and checks that the tag points at GITHUB_SHA. A run that fails leaves at
# most a draft, which nobody without write access sees and the next run
# replaces; never a tag of its own.
#
# A rehearsal then deletes the release it made, by its id, and the tag
# GitHub made for it, and checks that no release, draft or tag of that name
# is left. Its writes are only ever to rehearsal-<run number>, which the
# gate saw absent: it never creates, replaces or deletes v<version> or its
# release. If it fails on the way, it still removes what it made; a
# rehearsal that cannot remove it fails.
#
# A tag is followed to its commit: a lightweight tag names the commit, an
# annotated one names a tag object, which names the commit.
#
# Drafts are visible only to a token that can write, so only `publish` sees
# them. The gate job and `dry-run` read with the workflow's read-only token:
# they say so where they print, and `publish` reports and replaces any draft.
# tests/package/publish_test.sh runs this script against a stand-in `gh`.
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
REAL_TAG="v$V"
EXPECTED=(
  "mochi2d-native-$V-linux-arm64.tar.gz"
  "mochi2d-native-$V-linux-x64.tar.gz"
  "mochi2d-native-$V-macos-universal.tar.gz"
  "mochi2d-native-$V-windows-x64.zip"
)

# ---------------------------------------------------------------- the start
if [ "${GITHUB_EVENT_NAME:-}" = push ] && [[ "${GITHUB_REF:-}" == refs/tags/* ]]; then
  START=tag
elif [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ] && [ "${REHEARSAL:-false}" = true ]; then
  START=rehearsal
elif [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ] && [ "${RELEASE:-false}" = true ]; then
  START=dispatch
elif [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ]; then
  START=dry
else
  echo "publish.sh: started by '${GITHUB_EVENT_NAME:-}' at '${GITHUB_REF:-}', which makes no release" >&2
  exit 1
fi
case "$MODE/$START" in
  publish/dry) echo "publish.sh: publish needs a tag or a run with release or rehearsal checked" >&2; exit 1 ;;
  dry-run/tag | dry-run/dispatch | dry-run/rehearsal)
    echo "publish.sh: this run makes a release or a rehearsal; dry-run is for runs without either" >&2; exit 1 ;;
esac
if [ "$START" = rehearsal ]; then
  RUN="${GITHUB_RUN_NUMBER:?publish.sh: GITHUB_RUN_NUMBER is not set}"
  [[ "$RUN" =~ ^[0-9]+$ ]] || { echo "publish.sh: the run number '$RUN' is not a number" >&2; exit 1; }
  TAG="rehearsal-$RUN"
  TITLE="Mochi2D Native $V REHEARSAL (run $RUN; not a release, deleted by the run)"
else
  TAG="$REAL_TAG"
  TITLE="Mochi2D Native $V"
fi
# Every write of a rehearsal goes through this: only its own throwaway tag.
rehearsal_only() {
  [ "$START" = rehearsal ] && [[ "$TAG" =~ ^rehearsal-[0-9]+$ ]] && [ "$TAG" != "$REAL_TAG" ] || {
    echo "publish.sh: a rehearsal writes only to rehearsal-<run number>, not to '$TAG'" >&2
    exit 1
  }
}

# What the repository holds: GitHub's answer, or a failure (never "absent" for an error).
api() { gh api "$@" 2>&1; }
# The commit the tag TAG names, or nothing when there is no such tag. An
# annotated tag's ref names its tag object; the object names the commit (or,
# rarely, another tag object).
tag_commit() {
  local out type sha hops=0
  if ! out="$(api "repos/$REPO/git/ref/tags/$TAG" --jq '"\(.object.type) \(.object.sha)"')"; then
    grep -q "HTTP 404" <<<"$out" && return 0
    echo "publish.sh: cannot read the tags of $REPO: $out" >&2
    return 1
  fi
  read -r type sha <<<"$out"
  while [ "$type" = tag ]; do
    hops=$((hops + 1))
    [ "$hops" -le 8 ] || { echo "publish.sh: the tag $TAG does not lead to a commit" >&2; return 1; }
    out="$(api "repos/$REPO/git/tags/$sha" --jq '"\(.object.type) \(.object.sha)"')" || {
      echo "publish.sh: cannot read the tag object $sha of $TAG: $out" >&2
      return 1
    }
    read -r type sha <<<"$out"
  done
  [ "$type" = commit ] || { echo "publish.sh: the tag $TAG names a $type, not a commit" >&2; return 1; }
  printf '%s\n' "$sha"
}
TAG_SHA="$(tag_commit)" || exit 1
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
CREATING=0 # a rehearsal: set once the release is being created, so that a failure removes it
CLEANED=0

# ---------------------------------------------------------------- the gate
gate() {
  local problems=() line id draft private
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
    rehearsal)
      [ "${RELEASE:-false}" != true ] || problems+=("release and rehearsal are both checked: a run is one or the other")
      private="$(api "repos/$REPO" --jq .private)" || { echo "publish.sh: cannot read $REPO: $private" >&2; exit 1; }
      [ "$private" = true ] || problems+=("a rehearsal runs only in a private repository; $REPO is public")
      [ -z "$TAG_SHA" ] || problems+=("the tag $TAG exists already (at $TAG_SHA), and this run did not make it")
      ;;
  esac
  DRAFTS=()
  local listed
  listed="$(releases_of_tag)" || exit 1
  while read -r id draft; do
    [ -n "${id:-}" ] || continue
    if [ "$START" = rehearsal ]; then problems+=("a release $TAG exists (id $id, draft $draft), and this run did not make it")
    elif [ "$draft" = true ]; then DRAFTS+=("$id")
    else problems+=("the release $TAG exists (published, id $id)"); fi
  done <<<"$listed"
  if [ "$MODE" != publish ]; then
    echo "drafts: not visible to this job's read-only token; the publish job sees any draft of $TAG and $(if [ "$START" = rehearsal ]; then echo "stops at it"; else echo "replaces it"; fi)"
  elif [ "${#DRAFTS[@]}" -gt 0 ]; then
    echo "a draft of $TAG exists (id ${DRAFTS[*]}), left by a failed run; it is replaced"
  fi
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

# ---------------------------------------------------------------- a rehearsal's cleanup
# Removes what this rehearsal made: every release of rehearsal-<run number>
# (none existed at the gate, so each is this run's), by id, and the tag
# GitHub made for it at this run's commit. Then checks that nothing is left.
cleanup_rehearsal() {
  rehearsal_only
  local listed id tag_name now tries
  listed="$(releases_of_tag)" || return 1
  while read -r id _; do
    [ -n "${id:-}" ] || continue
    tag_name="$(api "repos/$REPO/releases/$id" --jq .tag_name)" || { echo "publish.sh: cannot read the release $id: $tag_name" >&2; return 1; }
    [ "$tag_name" = "$TAG" ] || { echo "publish.sh: the release $id is of '$tag_name', not $TAG; not deleted" >&2; return 1; }
    out="$(api -X DELETE "repos/$REPO/releases/$id")" || { echo "publish.sh: cannot delete the release $id: $out" >&2; return 1; }
    echo "deleted: the release $id ($TAG)"
  done <<<"$listed"
  now="$(tag_commit)" || return 1
  if [ -n "$now" ]; then
    [ "$now" = "$SHA" ] || { echo "publish.sh: the tag $TAG points at $now, not at this run's commit; not deleted" >&2; return 1; }
    out="$(api -X DELETE "repos/$REPO/git/refs/tags/$TAG")" || { echo "publish.sh: cannot delete the tag $TAG: $out" >&2; return 1; }
    echo "deleted: the tag $TAG (at $now)"
  fi
  # Nothing left: no release or draft of the tag, no tag (read again a few
  # times, should GitHub's reads lag behind its deletes).
  for tries in 1 2 3 4 5; do
    listed="$(releases_of_tag)" || return 1
    now="$(tag_commit)" || return 1
    if [ -z "$listed" ] && [ -z "$now" ]; then
      echo "verified: no release, no draft and no tag $TAG is left"
      CLEANED=1
      return 0
    fi
    [ "$tries" = 5 ] || sleep 2
  done
  echo "publish.sh: after the cleanup, $TAG still has: releases '${listed//$'\n'/, }', tag '${now:-none}'" >&2
  return 1
}
on_exit() {
  local status=$?
  rm -f "$NOTES"
  if [ "$START" = rehearsal ] && [ "$CREATING" = 1 ] && [ "$CLEANED" = 0 ]; then
    echo "the rehearsal stopped (status $status); removing what it made" >&2
    cleanup_rehearsal || { echo "publish.sh: the rehearsal could not remove what it made" >&2; exit 1; }
    [ "$status" -ne 0 ] || exit 1
  fi
  exit "$status"
}
trap on_exit EXIT

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

if [ "$START" = rehearsal ]; then
  { printf '**REHEARSAL** of the release path (run %s): not a release. The run deletes it and its tag again.\n\n' "$RUN"; cat "$NOTES"; } >"$NOTES.r"
  mv "$NOTES.r" "$NOTES"
fi
sizes() { for f in "${FILES[@]}"; do printf '%s %s\n' "$(basename "$f")" "$(wc -c <"$f" | tr -d ' ')"; done | LC_ALL=C sort; }
echo "== $(if [ "$START" = rehearsal ]; then echo "rehearsal"; else echo "release"; fi) $TAG of $REPO, at $SHA"
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
# The starts differ only here: a pushed tag exists, and the release must use
# it (--verify-tag); otherwise the release names the commit, and GitHub
# creates the tag there when the draft is published. A rehearsal is a
# pre-release, so that it is never the repository's latest release.
case "$START" in
  tag) WHERE=(--verify-tag) ;;
  dispatch) WHERE=(--target "$SHA") ;;
  rehearsal) rehearsal_only; WHERE=(--target "$SHA" --prerelease); CREATING=1 ;;
esac
gh release create "$TAG" "${FILES[@]}" -R "$REPO" --draft "${WHERE[@]}" --title "$TITLE" --notes-file "$NOTES"
listed="$(releases_of_tag)" || exit 1
ids="$(awk '$2 == "true" {print $1}' <<<"$listed")"
[ "$(wc -w <<<"$ids")" -eq 1 ] || { echo "publish.sh: expected one draft of $TAG, found: $listed" >&2; exit 1; }
ID="$ids"
echo "created: the draft $ID of $TAG"
assets="$(api "repos/$REPO/releases/$ID/assets" --paginate --jq '.[] | "\(.name) \(.size)"' | LC_ALL=C sort)"
if [ "$assets" != "$(sizes)" ]; then
  echo "publish.sh: the draft lists other files than the four packages; it stays a draft" >&2
  diff <(sizes) <(echo "$assets") >&2 || true
  exit 1
fi
echo "checked: the draft $ID lists the four packages with their sizes"
# The gate once more, right before the release becomes real: the tag and the
# releases are read again (nothing may have appeared since the first gate: a
# tag, a published release, another draft).
TAG_NOW="$(tag_commit)" || exit 1
[ "$TAG_NOW" = "$TAG_SHA" ] || { echo "publish.sh: the tag $TAG changed during the run (now '${TAG_NOW:-none}'); the release stays a draft" >&2; exit 1; }
listed="$(releases_of_tag)" || exit 1
published="$(awk '$2 == "false"' <<<"$listed")"
[ -z "$published" ] || { echo "publish.sh: a published release $TAG appeared during the run; the draft stays" >&2; exit 1; }
[ "$(awk '$2 == "true" {print $1}' <<<"$listed")" = "$ID" ] || { echo "publish.sh: the drafts of $TAG changed during the run: $listed" >&2; exit 1; }
echo "checked again: the tag $TAG $(if [ -n "$TAG_NOW" ]; then echo "at $TAG_NOW"; else echo "absent"; fi), no published release, the one draft $ID"
[ "$START" != rehearsal ] || rehearsal_only
api -X PATCH "repos/$REPO/releases/$ID" -F draft=false >/dev/null
echo "published: the release $ID"
# What was made: the tag at the commit, the release published with the four files.
made="$(tag_commit)" || exit 1
[ -n "$made" ] || { echo "publish.sh: no tag $TAG after publishing" >&2; exit 1; }
[ "$made" = "$SHA" ] || { echo "publish.sh: the tag $TAG points at $made, not $SHA" >&2; exit 1; }
echo "verified: the tag $TAG points at $SHA"
gh release view "$TAG" -R "$REPO" --json name,tagName,isDraft,isPrerelease,url,assets \
  --jq '"\(.name): \(.url)\ndraft \(.isDraft), pre-release \(.isPrerelease)\n" + ([.assets[] | "  \(.size)  \(.name)"] | join("\n"))'
if [ "$START" != rehearsal ]; then
  echo "published $TAG at $SHA"
  exit 0
fi

# ---------------------------------------------------------------- the rehearsal's end
latest="$(api "repos/$REPO/releases/latest" --jq .id)" || {
  grep -q "HTTP 404" <<<"$latest" || { echo "publish.sh: cannot read the latest release: $latest" >&2; exit 1; }
  latest=none
}
[ "$latest" != "$ID" ] || { echo "publish.sh: the rehearsal $ID became the latest release" >&2; exit 1; }
echo "verified: the rehearsal is not the latest release (that is ${latest})"
cleanup_rehearsal || exit 1
echo "rehearsal $TAG at $SHA: made, checked, published, verified and removed"
