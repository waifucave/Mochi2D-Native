#!/usr/bin/env bash
# tests/package/publish.sh against a stand-in `gh` (a script first on the PATH
# that answers from JSON files: tag refs, tag objects, releases, assets), so
# the release path's rules show without a real run:
#   - a tag is followed to its commit: a lightweight and an annotated tag
#     both pass at the run's commit, and both are refused at another;
#   - only a pushed tag is a tag's start: a run by hand from a tag ref
#     without `release` is a dry run, in the script and in the workflow's
#     job conditions (evaluated here from release.yml);
#   - the releases and the tag are read again right before the draft is
#     published: one that appears after the draft was made stops it;
#   - the packages folder must hold exactly the four packages, regular and
#     not empty;
#   - a rehearsal (private repositories only) makes every call of a release
#     with rehearsal-<run number>, a pre-release, then deletes its release
#     and tag and finds nothing left; it stops at any release or tag of that
#     name it did not make, removes what it made when it fails on the way,
#     fails when it cannot, and never writes to v<version> or its release.
# Needs bash, jq and node; exits 77 (skipped) without jq or node.
set -euo pipefail
command -v jq >/dev/null && command -v node >/dev/null || { echo "publish_test: needs jq and node; skipped"; exit 77; }
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PUBLISH="$HERE/publish.sh"
V="$(sed -n 's/^project(mochi2d_native VERSION \([0-9.]*\) .*/\1/p' "$ROOT/CMakeLists.txt")"
TAG="v$V"
REPO=example/project
SHA=1111111111111111111111111111111111111111
OTHER=2222222222222222222222222222222222222222
OBJ=3333333333333333333333333333333333333333
T="$(mktemp -d "${TMPDIR:-/tmp}/publish_test.XXXXXX")"
trap '[ -n "${KEEP:-}" ] || rm -rf "$T"' EXIT

# ---------------------------------------------------------------- the stand-in gh
mkdir -p "$T/bin"
cat >"$T/bin/gh" <<'GH'
#!/usr/bin/env bash
# Answers from $FAKE: repo.json, refs/<tag>.json, objects/<sha>.json,
# releases.json, assets/<id>.json, as GitHub's REST API would. Records each
# call in $FAKE/calls. An executable $FAKE/on-assets runs when a draft's
# assets are read (to change the repository in the middle of a run); with a
# file $FAKE/deletes-fail, every DELETE fails as GitHub would with 403.
set -euo pipefail
S="${FAKE:?}"
echo "gh $*" >>"$S/calls"
not_found() { echo '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
case "$1" in
  api)
    shift
    method=GET path="" expr=. fields=()
    while [ $# -gt 0 ]; do
      case "$1" in
        -X) method="$2"; shift 2 ;;
        --jq) expr="$2"; shift 2 ;;
        --paginate) shift ;;
        -F | -f) fields+=("$2"); shift 2 ;;
        *) path="$1"; shift ;;
      esac
    done
    path="${path#repos/$FAKE_REPO/}"
    case "$method $path" in
      "GET repos/$FAKE_REPO") f="$S/repo.json" ;;
      "GET git/ref/tags/"*) f="$S/refs/${path#git/ref/tags/}.json" ;;
      "GET git/tags/"*) f="$S/objects/${path#git/tags/}.json" ;;
      "GET releases") f="$S/releases.json" ;;
      "GET releases/latest")
        # The latest: the newest published release that is not a pre-release.
        jq 'map(select(.draft == false and .prerelease != true)) | max_by(.id) // empty' "$S/releases.json" >"$S/latest.json"
        [ -s "$S/latest.json" ] || not_found
        f="$S/latest.json" ;;
      "GET releases/"*/assets)
        id="${path#releases/}"; id="${id%/assets}"
        [ ! -x "$S/on-assets" ] || "$S/on-assets"
        f="$S/assets/$id.json" ;;
      "GET releases/"*)
        id="${path#releases/}"
        jq --argjson id "$id" '.[] | select(.id == $id)' "$S/releases.json" >"$S/one.json"
        [ -s "$S/one.json" ] || not_found
        f="$S/one.json" ;;
      "DELETE "*)
        [ ! -f "$S/deletes-fail" ] || { echo '{"message":"Resource not accessible by integration"}'; echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1; }
        case "$path" in
          releases/*)
            id="${path#releases/}"
            jq -e --argjson id "$id" 'any(.id == $id)' "$S/releases.json" >/dev/null || not_found
            jq --argjson id "$id" 'map(select(.id != $id))' "$S/releases.json" >"$S/r" && mv "$S/r" "$S/releases.json" ;;
          git/refs/tags/*)
            # Deleting a release leaves its tag; the tag is deleted by its ref.
            [ -f "$S/refs/${path#git/refs/tags/}.json" ] || not_found
            rm "$S/refs/${path#git/refs/tags/}.json" ;;
          *) echo "stand-in gh: unexpected DELETE $path" >&2; exit 1 ;;
        esac
        exit 0 ;;
      "PATCH releases/"*)
        id="${path#releases/}"
        [ "${fields[*]}" = draft=false ] || { echo "stand-in gh: unexpected fields ${fields[*]}" >&2; exit 1; }
        rel="$(jq --argjson id "$id" '.[] | select(.id == $id)' "$S/releases.json")"
        tag="$(jq -r .tag_name <<<"$rel")"
        # Publishing makes the tag at the target, when there is none.
        [ -f "$S/refs/$tag.json" ] || jq -n --arg sha "$(jq -r .target_commitish <<<"$rel")" \
          '{object: {type: "commit", sha: $sha}}' >"$S/refs/$tag.json"
        jq --argjson id "$id" 'map(if .id == $id then .draft = false else . end)' "$S/releases.json" >"$S/r" && mv "$S/r" "$S/releases.json"
        exit 0 ;;
      *) echo "stand-in gh: unexpected call $method $path" >&2; exit 1 ;;
    esac
    [ -f "$f" ] || not_found
    jq -r "$expr" "$f" ;;
  release)
    case "$2" in
      create)
        tag="$3"; shift 3
        files=() verify=0 target="" title="" pre=false
        while [ $# -gt 0 ]; do
          case "$1" in
            -R | --notes-file) shift 2 ;;
            --draft) shift ;;
            --prerelease) pre=true; shift ;;
            --verify-tag) verify=1; shift ;;
            --target) target="$2"; shift 2 ;;
            --title) title="$2"; shift 2 ;;
            -*) echo "stand-in gh: unexpected option $1" >&2; exit 1 ;;
            *) files+=("$1"); shift ;;
          esac
        done
        if [ "$verify" = 1 ]; then
          [ -f "$S/refs/$tag.json" ] || { echo "tag $tag doesn't exist in the repo" >&2; exit 1; }
          target="$tag"
        fi
        id=$(( $(jq '[.[].id] | max // 100' "$S/releases.json") + 1 ))
        jq --argjson id "$id" --arg tag "$tag" --arg title "$title" --arg target "$target" --argjson pre "$pre" \
          '. + [{id: $id, tag_name: $tag, name: $title, draft: true, prerelease: $pre, target_commitish: $target}]' \
          "$S/releases.json" >"$S/r" && mv "$S/r" "$S/releases.json"
        for f in "${files[@]}"; do
          jq -n --arg name "$(basename "$f")" --argjson size "$(wc -c <"$f" | tr -d ' ')" '{name: $name, size: $size}'
        done | jq -s . >"$S/assets/$id.json" ;;
      view) echo "(release view)" ;;
      *) echo "stand-in gh: unexpected release $2" >&2; exit 1 ;;
    esac ;;
  *) echo "stand-in gh: unexpected command $1" >&2; exit 1 ;;
esac
GH
chmod +x "$T/bin/gh"

# ---------------------------------------------------------------- helpers
FAILED=0
CASE=""
fresh() {  # fresh <name>: an empty repository and the four packages
  CASE="$1"
  export FAKE="$T/$1"
  mkdir -p "$FAKE/refs" "$FAKE/objects" "$FAKE/assets" "$FAKE/packages"
  echo '[]' >"$FAKE/releases.json"
  echo '{"private": true}' >"$FAKE/repo.json"
  : >"$FAKE/calls"
  for p in linux-arm64.tar.gz linux-x64.tar.gz macos-universal.tar.gz windows-x64.zip; do
    echo "package $p" >"$FAKE/packages/mochi2d-native-$V-$p"
  done
}
lightweight() { jq -n --arg sha "$1" '{object: {type: "commit", sha: $sha}}' >"$FAKE/refs/$TAG.json"; }
annotated() {
  jq -n --arg sha "$OBJ" '{object: {type: "tag", sha: $sha}}' >"$FAKE/refs/$TAG.json"
  jq -n --arg sha "$1" '{object: {type: "commit", sha: $sha}}' >"$FAKE/objects/$OBJ.json"
}
published_release() {
  jq --arg tag "$TAG" '. + [{id: 7, tag_name: $tag, name: "x", draft: false, target_commitish: "main"}]' \
    "$FAKE/releases.json" >"$FAKE/r" && mv "$FAKE/r" "$FAKE/releases.json"
}
# run <event> <ref> <release> <mode> [packages dir]: the script as a job would run it
run() {
  local event="$1" ref="$2" release="$3"; shift 3
  env PATH="$T/bin:$PATH" FAKE_REPO="$REPO" GITHUB_REPOSITORY="$REPO" GITHUB_SHA="$SHA" \
    GITHUB_EVENT_NAME="$event" GITHUB_REF="$ref" GITHUB_REF_NAME="${ref##*/}" RELEASE="$release" \
    REHEARSAL="${REHEARSAL_IN:-false}" GITHUB_RUN_NUMBER="${RUN_IN:-42}" \
    bash "$PUBLISH" "$@" >"$FAKE/out" 2>&1
}
# rehearse <release> <mode> [packages dir]: a run by hand on main with `rehearsal` checked
rehearse() { local release="$1"; shift; REHEARSAL_IN=true run workflow_dispatch refs/heads/main "$release" "$@"; }
ok() { echo "ok    $CASE: $1"; }
bad() { echo "FAIL  $CASE: $1"; grep -v '^  | ' "$FAKE/out" | sed 's/^/      | /'; FAILED=1; }
passes() { if run "$@"; then ok "passes"; else bad "should pass"; fi; }
refused() {  # refused <message> [rehearse] <run args...>
  local msg="$1" how=run; shift
  [ "$1" != rehearse ] || { how=rehearse; shift; }
  if "$how" "$@"; then bad "should be refused ($msg)"
  elif grep -qF -- "$msg" "$FAKE/out"; then ok "refused: $msg"
  else bad "refused, but without '$msg'"; fi
}
says() { if grep -qF -- "$1" "$FAKE/out"; then ok "says '$1'"; else bad "does not say '$1'"; fi; }
state() {  # state <jq expression over releases.json> <expected>
  local got; got="$(jq -c "$1" "$FAKE/releases.json")"
  if [ "$got" = "$2" ]; then ok "$1 = $2"; else bad "$1 is $got, not $2"; fi
}
no_call() { if grep -q -- "$1" "$FAKE/calls"; then bad "called '$1'"; else ok "no '$1'"; fi; }
tag_is() {
  local got; got="$(jq -r .object.sha "$FAKE/refs/$TAG.json" 2>/dev/null || echo none)"
  if [ "$got" = "$1" ]; then ok "the tag is at $1"; else bad "the tag is at $got, not $1"; fi
}
PUSH=(push "refs/tags/$TAG" false)
BY_HAND=(workflow_dispatch refs/heads/main true)

# ---------------------------------------------------------------- 1. tags to commits
fresh lightweight-here; lightweight "$SHA"
passes "${PUSH[@]}" gate
passes "${PUSH[@]}" publish "$FAKE/packages"
state '[.[] | {draft, name}]' "[{\"draft\":false,\"name\":\"Mochi2D Native $V\"}]"
says "published $TAG at $SHA"

fresh annotated-here; annotated "$SHA"
passes "${PUSH[@]}" gate
says "tag $TAG at $SHA"
passes "${PUSH[@]}" publish "$FAKE/packages"
state '[.[] | .draft]' '[false]'

fresh lightweight-elsewhere; lightweight "$OTHER"
refused "points at '$OTHER', not at this run's commit" "${PUSH[@]}" gate

fresh annotated-elsewhere; annotated "$OTHER"
refused "points at '$OTHER', not at this run's commit" "${PUSH[@]}" gate
refused "points at '$OTHER', not at this run's commit" "${PUSH[@]}" publish "$FAKE/packages"
state 'length' '0'

fresh annotated-by-hand; annotated "$SHA"
refused "the tag $TAG exists already (at $SHA)" "${BY_HAND[@]}" gate

# ---------------------------------------------------------------- 2. a tag ref by hand is a dry run
fresh tag-ref-by-hand; lightweight "$SHA"
refused "publish needs a tag or a run with release or rehearsal checked" workflow_dispatch "refs/tags/$TAG" false publish "$FAKE/packages"
passes workflow_dispatch "refs/tags/$TAG" false dry-run "$FAKE/packages"
says "start: dry"
no_call "release create"

CASE=workflow-conditions
if out="$(node - "$ROOT/.github/workflows/release.yml" <<'JS' 2>&1
const fs = require("fs");
const y = fs.readFileSync(process.argv[2], "utf8");
// The `if:` of a job of release.yml, as GitHub reads it: ${{ <expression> }}.
const cond = job => {
  const m = y.match(new RegExp("^  " + job + ":\\n(?:    .*\\n|\\n)*?    if: \\$\\{\\{(.*)\\}\\}\\s*$", "m"));
  if (!m) throw new Error("release.yml: no if: for the job " + job);
  return m[1];
};
const runs = (job, github, inputs) =>
  Boolean(Function("github", "inputs", "startsWith", "return (" + cond(job) + ");")(
    github, inputs, (a, b) => String(a ?? "").startsWith(b)));
const main = {event_name: "workflow_dispatch", ref: "refs/heads/main"};
const tagRef = {event_name: "workflow_dispatch", ref: "refs/tags/v1.0.0"};
const starts = [
  ["a pushed tag", {event_name: "push", ref: "refs/tags/v1.0.0"}, {}, "publish"],
  ["by hand on main, release", main, {release: true, rehearsal: false}, "publish"],
  ["by hand on main", main, {release: false, rehearsal: false}, "dry-run"],
  ["by hand from a tag ref", tagRef, {release: false, rehearsal: false}, "dry-run"],
  ["by hand from a tag ref, release", tagRef, {release: true, rehearsal: false}, "publish"],
  ["by hand on main, rehearsal", main, {release: false, rehearsal: true}, "publish"],
  ["by hand on main, both (the gate refuses)", main, {release: true, rehearsal: true}, "publish"],
];
let bad = 0;
for (const [name, github, inputs, want] of starts) {
  const got = ["dry-run", "publish"].filter(j => runs(j, github, inputs));
  const fine = got.length === 1 && got[0] === want;
  if (!fine) bad = 1;
  console.log(`${fine ? "ok   " : "FAIL "} ${name}: runs ${got.join(" and ") || "neither"}${fine ? "" : `, not only ${want}`}`);
}
process.exit(bad);
JS
)"; then
  sed -E "s/^(ok|FAIL) +/\1    $CASE: /; s/^FAIL    /FAIL  /" <<<"$out"
else
  sed -E "s/^(ok|FAIL) +/\1    $CASE: /; s/^FAIL    /FAIL  /" <<<"$out"; FAILED=1
fi

# ---------------------------------------------------------------- 4. read again before publishing
fresh published-meanwhile
cat >"$FAKE/on-assets" <<EOF
#!/usr/bin/env bash
jq --arg tag "$TAG" '. + [{id: 7, tag_name: \$tag, name: "x", draft: false, target_commitish: "main"}]' "$FAKE/releases.json" >"$FAKE/r" && mv "$FAKE/r" "$FAKE/releases.json"
EOF
chmod +x "$FAKE/on-assets"
refused "a published release $TAG appeared during the run; the draft stays" "${BY_HAND[@]}" publish "$FAKE/packages"
no_call "-X PATCH"
state '[.[] | .draft] | sort' '[false,true]'

fresh tagged-meanwhile
cat >"$FAKE/on-assets" <<EOF
#!/usr/bin/env bash
jq -n '{object: {type: "commit", sha: "$OTHER"}}' >"$FAKE/refs/$TAG.json"
EOF
chmod +x "$FAKE/on-assets"
refused "the tag $TAG changed during the run (now '$OTHER')" "${BY_HAND[@]}" publish "$FAKE/packages"
no_call "-X PATCH"

fresh by-hand
passes "${BY_HAND[@]}" gate
says "drafts: not visible to this job's read-only token"
passes "${BY_HAND[@]}" publish "$FAKE/packages"
grep -q -- "--target $SHA" "$FAKE/calls" && ok "the draft names the commit" || bad "no --target $SHA"
tag_is "$SHA"
state '[.[] | {draft, name}]' "[{\"draft\":false,\"name\":\"Mochi2D Native $V\"}]"

fresh draft-left; lightweight "$SHA"
jq --arg tag "$TAG" '[{id: 5, tag_name: $tag, name: "x", draft: true, target_commitish: "main"}]' -n >"$FAKE/releases.json"
passes "${PUSH[@]}" publish "$FAKE/packages"
says "a draft of $TAG exists (id 5)"
state '[.[] | {id, draft}]' '[{"id":101,"draft":false}]'

fresh released; lightweight "$SHA"; published_release
refused "the release $TAG exists (published, id 7)" "${PUSH[@]}" gate
passes workflow_dispatch refs/heads/main false dry-run "$FAKE/packages"
says "a release run would stop here"

# ---------------------------------------------------------------- the rehearsal
# The real release, its tag and a draft of it are there; the rehearsal must
# leave all three exactly as they were.
real_state() {
  lightweight "$OTHER"; published_release
  jq --arg tag "$TAG" '. + [{id: 5, tag_name: $tag, name: "left", draft: true, target_commitish: "main"}]' \
    "$FAKE/releases.json" >"$FAKE/r" && mv "$FAKE/r" "$FAKE/releases.json"
  cp "$FAKE/releases.json" "$FAKE/releases.before"; cp "$FAKE/refs/$TAG.json" "$FAKE/tag.before"
}
real_untouched() {
  if cmp -s "$FAKE/releases.json" "$FAKE/releases.before" && cmp -s "$FAKE/refs/$TAG.json" "$FAKE/tag.before"; then
    ok "the release $TAG, its draft and its tag are as they were"
  else bad "the release $TAG, its draft or its tag changed"; fi
  if grep -E '^gh (api -X (DELETE|PATCH)|release create)' "$FAKE/calls" | grep -qE "$TAG|releases/(5|7)( |$)"; then
    bad "a write names $TAG or its releases"
  else ok "no write names $TAG or its releases"; fi
}

fresh rehearsal; real_state
if rehearse false gate; then ok "the gate passes"; else bad "the gate should pass"; fi
says "start: rehearsal; version $V; tag rehearsal-42 (not yet)"
says "the publish job sees any draft of rehearsal-42 and stops at it"
passes_rehearsal() { if rehearse false publish "$FAKE/packages"; then ok "passes"; else bad "should pass"; fi; }
passes_rehearsal
for line in "created: the draft 8 of rehearsal-42" "checked: the draft 8 lists the four packages" \
  "checked again: the tag rehearsal-42 absent, no published release, the one draft 8" "published: the release 8" \
  "verified: the tag rehearsal-42 points at $SHA" "verified: the rehearsal is not the latest release (that is 7)" \
  "deleted: the release 8 (rehearsal-42)" "deleted: the tag rehearsal-42 (at $SHA)" \
  "verified: no release, no draft and no tag rehearsal-42 is left"; do says "$line"; done
grep -q -- "release create rehearsal-42 .*--target $SHA --prerelease --title Mochi2D Native $V REHEARSAL" "$FAKE/calls" \
  && ok "the draft is a pre-release titled REHEARSAL at the commit" || bad "the create call is not the rehearsal's"
[ ! -f "$FAKE/refs/rehearsal-42.json" ] && ok "no tag rehearsal-42 is left" || bad "the tag rehearsal-42 is left"
real_untouched

fresh rehearsal-public; echo '{"private": false}' >"$FAKE/repo.json"
refused "a rehearsal runs only in a private repository" rehearse false gate
refused "a rehearsal runs only in a private repository" rehearse false publish "$FAKE/packages"
no_call "release create"

fresh rehearsal-and-release; real_state
refused "release and rehearsal are both checked" rehearse true gate
refused "release and rehearsal are both checked" rehearse true publish "$FAKE/packages"
no_call "release create"
real_untouched

fresh rehearsal-not-ours
jq -n '[{id: 9, tag_name: "rehearsal-42", name: "someone else", draft: true, target_commitish: "main"}]' >"$FAKE/releases.json"
jq -n --arg sha "$SHA" '{object: {type: "commit", sha: $sha}}' >"$FAKE/refs/rehearsal-42.json"
refused "a release rehearsal-42 exists (id 9, draft true), and this run did not make it" rehearse false publish "$FAKE/packages"
says "the tag rehearsal-42 exists already"
no_call "-X DELETE"
state '[.[] | .id]' '[9]'

fresh rehearsal-run-number
RUN_IN="$TAG" refused "the run number '$TAG' is not a number" rehearse false publish "$FAKE/packages"
no_call "release create"

fresh rehearsal-fails-on-the-way; real_state
printf '#!/usr/bin/env bash\nfor f in "%s"/assets/*.json; do jq %s "$f" >"$f.x" && mv "$f.x" "$f"; done\n' \
  "$FAKE" "'. + [{name: \"stray.txt\", size: 1}]'" >"$FAKE/on-assets"
chmod +x "$FAKE/on-assets"
refused "the draft lists other files than the four packages" rehearse false publish "$FAKE/packages"
says "removing what it made"
says "deleted: the release 8 (rehearsal-42)"
says "verified: no release, no draft and no tag rehearsal-42 is left"
no_call "-X PATCH"
real_untouched

fresh rehearsal-cannot-clean; real_state
touch "$FAKE/deletes-fail"
refused "cannot delete the release 8" rehearse false publish "$FAKE/packages"
says "the rehearsal could not remove what it made"

# ---------------------------------------------------------------- the packages
fresh extra-file
echo x >"$FAKE/packages/notes.md"
refused "must hold exactly the four packages" workflow_dispatch refs/heads/main false dry-run "$FAKE/packages"

fresh empty-package
: >"$FAKE/packages/mochi2d-native-$V-linux-x64.tar.gz"
refused "mochi2d-native-$V-linux-x64.tar.gz is not a non-empty file" workflow_dispatch refs/heads/main false dry-run "$FAKE/packages"

fresh linked-package
mv "$FAKE/packages/mochi2d-native-$V-windows-x64.zip" "$FAKE/zip"
ln -s "$FAKE/zip" "$FAKE/packages/mochi2d-native-$V-windows-x64.zip"
refused "mochi2d-native-$V-windows-x64.zip is not a non-empty file" workflow_dispatch refs/heads/main false dry-run "$FAKE/packages"

fresh folder-in-packages
mkdir "$FAKE/packages/judge"
refused "must hold exactly the four packages" "${BY_HAND[@]}" publish "$FAKE/packages"
no_call "release create"

[ "$FAILED" = 0 ] && echo "publish_test: all passed" || echo "publish_test: FAILED"
exit "$FAILED"
