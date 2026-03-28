#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOW_FILE="$REPO_ROOT/examples/flows/pr-triage/pr-triage.flow.ts"
REPO_SLUG="openclaw/acpx"
STAMP="$(date +%Y%m%dT%H%M%S)"
TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"
BATCH_DIR="$TMP_BASE/acpx-pr-triage-batch-$STAMP"
STARTED_TSV="$BATCH_DIR/started.tsv"

usage() {
  cat <<'EOF'
Usage:
  scripts/run-pr-triage-batch.sh <pr> [<pr> ...]

Accepted PR forms:
  178
  #178
  https://github.com/openclaw/acpx/pull/178
EOF
}

normalize_pr() {
  local raw="$1"
  raw="${raw##*/}"
  raw="${raw#\#}"
  if [[ ! "$raw" =~ ^[0-9]+$ ]]; then
    echo "Invalid PR argument: $1" >&2
    return 1
  fi
  printf '%s\n' "$raw"
}

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 1
fi

command -v pnpm >/dev/null || { echo "pnpm is required" >&2; exit 1; }
command -v tmux >/dev/null || { echo "tmux is required for reliable detached runs" >&2; exit 1; }

mkdir -p "$BATCH_DIR"
printf "pr\tlauncher\tlog\tinput\n" >"$STARTED_TSV"

declare -A seen=()

for raw in "$@"; do
  pr_number="$(normalize_pr "$raw")"
  if [[ -n "${seen[$pr_number]:-}" ]]; then
    continue
  fi
  seen[$pr_number]=1

  input_file="$BATCH_DIR/pr-$pr_number.input.json"
  log_file="$BATCH_DIR/pr-$pr_number.log"
  session_name="acpx-pr-$pr_number-$STAMP"

  cat >"$input_file" <<JSON
{"repo":"$REPO_SLUG","prNumber":$pr_number}
JSON

  run_cmd=$(
    cat <<EOF
cd $(printf '%q' "$REPO_ROOT") && \
pnpm exec tsx src/cli.ts --approve-all flow run $(printf '%q' "$FLOW_FILE") --input-file $(printf '%q' "$input_file")
EOF
  )

  tmux new-session -d -s "$session_name" "bash -lc $(printf '%q' "$run_cmd") >> $(printf '%q' "$log_file") 2>&1"
  printf "%s\t%s\t%s\t%s\n" "$pr_number" "tmux:$session_name" "$log_file" "$input_file" >>"$STARTED_TSV"
  printf "started PR #%s in tmux session %s\n" "$pr_number" "$session_name"
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
