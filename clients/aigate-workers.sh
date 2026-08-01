#!/usr/bin/env bash
# aigate-workers — launch one aigate-worker per CPU core (override with N as $1 or
# AIGATE_WORKERS). Claim is atomic server-side, so N pullers just parallelize with
# zero coordination. Dead workers respawn; Ctrl-C stops the whole pool.
#
#   usage: aigate-workers.sh [N]
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
N="${1:-${AIGATE_WORKERS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}}"
echo "aigate-workers: starting $N worker(s)" >&2

pids=()
trap 'echo "aigate-workers: stopping" >&2; kill "${pids[@]}" 2>/dev/null; exit 0' INT TERM

for i in $(seq 1 "$N"); do
  ( while :; do "$DIR/aigate-worker.sh"; echo "worker $i died (rc=$?) — respawning in 2s" >&2; sleep 2; done ) &
  pids+=($!)
done
wait
