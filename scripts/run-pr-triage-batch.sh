#!/usr/bin/env bash
set -euo pipefail
shopt -s nocasematch

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOW_FILE="$REPO_ROOT/examples/flows/pr-triage/pr-triage.flow.ts"
DEFAULT_REPO="openclaw/acpx"

usage() {
  cat <<'EOF'
Usage:
  scripts/run-pr-triage-batch.sh <pr> [<pr> ...]

Accepted PR forms:
  178
  '#178'
  https://github.com/owner/repo/pull/178

Bare numbers and #numbers use openclaw/acpx. URLs retain their repository.
Leading zeros are removed, and repeated repository/PR pairs run once.
PR numbers must be between 1 and 9007199254740991 so the flow reads them exactly.
All arguments are validated before any detached run starts.
Requires pnpm, tmux, and Bash 3.2 or newer.
EOF
}

# Set the repository, canonical decimal number, and case-insensitive identity.
normalize_pr() {
  local raw="$1"
  local LC_ALL=C
  local url_pattern='^https://github[.]com/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)/pull/([0-9]+)$'
  local number_pattern='^0*([1-9][0-9]*)$'

  pr_repo="$DEFAULT_REPO"
  if [[ "$raw" =~ $url_pattern ]]; then
    pr_repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    raw="${BASH_REMATCH[3]}"
  else
    raw="${raw#\#}"
  fi

  if [[ ! "$raw" =~ $number_pattern || "$pr_repo" == */. || "$pr_repo" == */.. ]]; then
    printf 'Invalid PR argument: %s\n' "$1" >&2
    return 1
  fi
  pr_number="${BASH_REMATCH[1]}"

  # The flow consumes Number(prNumber); larger values can select a rounded ID.
  if [[ ${#pr_number} -gt 16 || ( ${#pr_number} -eq 16 && "$pr_number" > 9007199254740991 ) ]]; then
    printf 'Invalid PR argument: %s (maximum PR number is 9007199254740991)\n' "$1" >&2
    return 1
  fi
  pr_key="$(printf '%s' "$pr_repo" | LC_ALL=C tr '[:upper:]' '[:lower:]')#$pr_number"
}

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 1
fi

for raw in "$@"; do
  normalize_pr "$raw"
done

command -v pnpm >/dev/null || { echo "pnpm is required" >&2; exit 1; }
command -v tmux >/dev/null || { echo "tmux is required for reliable detached runs" >&2; exit 1; }

STAMP="$(date +%Y%m%dT%H%M%S)"
TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"
BATCH_DIR="$TMP_BASE/acpx-pr-triage-batch-$STAMP"
STARTED_TSV="$BATCH_DIR/started.tsv"

mkdir -p "$BATCH_DIR"
printf "pr\tlauncher\tlog\tinput\n" >"$STARTED_TSV"

seen=" "
job_number=0
for raw in "$@"; do
  normalize_pr "$raw"
  case "$seen" in
    *" $pr_key "*) continue ;;
  esac
  seen="$seen$pr_key "
  job_number=$((job_number + 1))

  # Ordinals distinguish equal PR numbers across repos without slug escaping.
  job_name="job-$job_number-pr-$pr_number"
  input_file="$BATCH_DIR/$job_name.input.json"
  log_file="$BATCH_DIR/$job_name.log"
  session_name="acpx-pr-$pr_number-$STAMP-$job_number"
  pr_reference="$pr_repo#$pr_number"

  printf '{"repo":"%s","prNumber":%s}\n' "$pr_repo" "$pr_number" >"$input_file"

  run_cmd=$(
    cat <<EOF
cd $(printf '%q' "$REPO_ROOT") && \
pnpm exec tsx src/cli.ts --approve-all flow run $(printf '%q' "$FLOW_FILE") --input-file $(printf '%q' "$input_file")
EOF
  )

  tmux new-session -d -s "$session_name" "bash -lc $(printf '%q' "$run_cmd") >> $(printf '%q' "$log_file") 2>&1"
  printf "%s\t%s\t%s\t%s\n" "$pr_reference" "tmux:$session_name" "$log_file" "$input_file" >>"$STARTED_TSV"
  printf "started PR %s in tmux session %s\n" "$pr_reference" "$session_name"
done

echo
echo "Started runs:"
if command -v column >/dev/null 2>&1; then
  column -ts $'\t' "$STARTED_TSV"
else
  cat "$STARTED_TSV"
fi
echo
echo "Batch dir: $BATCH_DIR"
