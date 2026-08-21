#!/usr/bin/env bash
# Install or repair the additive context-economy v2 experiment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TARGET="${1:-$PWD}"
TARGET="$(cd "$TARGET" && pwd)"
TEMP_ROOT="$(mktemp -d -t pavans-context-economy-v2.XXXXXX)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
ARCHIVE="$TEMP_ROOT/context-economy-v2.tar.bz2"
EXTRACTED="$TEMP_ROOT/source"
CHECKSUM_FILE="$SCRIPT_DIR/context-economy-v2.sha256"

command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required." >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "ERROR: tar is required." >&2; exit 1; }
[[ -f "$CHECKSUM_FILE" ]] || { echo "ERROR: v2 checksum file is missing." >&2; exit 1; }

python3 - "$SCRIPT_DIR" "$CHECKSUM_FILE" "$ARCHIVE" <<'PY'
import base64
import hashlib
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
expected = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8").strip().split()[0]
parts = sorted(root.glob("context-economy-v2.tar.bz2.b64.part-*.txt"))
if not parts:
    raise SystemExit("ERROR: context-economy v2 package chunks are missing")
raw = base64.b64decode(b"".join(part.read_bytes() for part in parts), validate=False)
actual = hashlib.sha256(raw).hexdigest()
if actual != expected:
    raise SystemExit(f"ERROR: v2 package checksum mismatch: expected {expected}, got {actual}")
pathlib.Path(sys.argv[3]).write_bytes(raw)
PY

mkdir -p "$EXTRACTED"
tar -xjf "$ARCHIVE" -C "$EXTRACTED"
WF_CONTEXT_ECONOMY_SOURCE_ROOT="$SOURCE_ROOT" \
  exec bash "$EXTRACTED/AI_Workflow_Kit/experiments/context-economy/v2/apply.sh" "$TARGET"
