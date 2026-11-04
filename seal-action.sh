#!/usr/bin/env bash
# Body of action.yml: writes seal.json for the release files and hands its root to the job. FILES (one path or glob per line),
# VERSION, PROJECT and OUT come from the step's env; GITHUB_ACTION_PATH, GITHUB_OUTPUT and GITHUB_STEP_SUMMARY from Actions.
set -euo pipefail
shopt -s nullglob

if [ -z "${VERSION:-}" ]; then
  if [ "${GITHUB_REF_TYPE:-}" = tag ]; then
    VERSION="$GITHUB_REF_NAME"
  else
    echo "::error::Set the version input; it defaults to the tag name only on a tag push." >&2
    exit 1
  fi
fi

paths=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -z "$line" ] && continue
  IFS=$'\n'
  # shellcheck disable=SC2206 # the glob in the line is meant to expand
  matched=($line)
  unset IFS
  if [ ${#matched[@]} -eq 0 ] || [ ! -f "${matched[0]}" ]; then
    echo "::error::No file matches $line" >&2
    exit 1
  fi
  paths+=("${matched[@]}")
done <<< "${FILES:-}"
if [ ${#paths[@]} -eq 0 ]; then
  echo "::error::The files input is empty." >&2
  exit 1
fi

args=(--version "$VERSION" --out "$OUT")
if [ -n "${PROJECT:-}" ]; then args+=(--project "$PROJECT"); fi
root=$(node "$GITHUB_ACTION_PATH/public/seal-manifest.mjs" "${args[@]}" "${paths[@]}")

echo "root=$root" >> "$GITHUB_OUTPUT"
echo "path=$OUT" >> "$GITHUB_OUTPUT"
{
  echo "### Release Seal: $VERSION"
  echo
  echo "Root \`$root\`, list written to \`$OUT\`."
  echo
  echo "Next: publish \`$OUT\` with the release, open https://emilhuseyn.github.io/release-seal/ > Seal a release, drop \`$OUT\` and confirm in the wallet."
} >> "$GITHUB_STEP_SUMMARY"
