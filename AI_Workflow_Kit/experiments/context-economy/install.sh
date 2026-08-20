#!/usr/bin/env bash
# Bootstrap the packaged context-economy overlay onto an existing workflow project.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-$PWD}"
TARGET="$(cd "$TARGET" && pwd)"
TEMP_ROOT="$(mktemp -d -t pavans-context-economy-bootstrap.XXXXXX)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
ARCHIVE="$TEMP_ROOT/overlay.tar.bz2"
SOURCE="$TEMP_ROOT/source"

command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required." >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "ERROR: tar is required." >&2; exit 1; }

python3 - "$SCRIPT_DIR" "$SCRIPT_DIR/overlay.sha256" "$ARCHIVE" <<'PY'
from __future__ import annotations

import base64
import hashlib
import pathlib
import sys

parts_dir = pathlib.Path(sys.argv[1])
expected_path = pathlib.Path(sys.argv[2])
out_path = pathlib.Path(sys.argv[3])
parts = sorted(parts_dir.glob("overlay.tar.bz2.b64.part-*"))
if not parts:
    raise SystemExit("ERROR: packaged overlay chunks are missing")
raw = base64.b64decode(b"".join(part.read_bytes() for part in parts), validate=False)
expected = expected_path.read_text(encoding="utf-8").strip().split()[0]
actual = hashlib.sha256(raw).hexdigest()
if actual != expected:
    raise SystemExit(f"ERROR: experiment overlay checksum mismatch: expected {expected}, got {actual}")
out_path.write_bytes(raw)
PY

mkdir -p "$SOURCE"
tar -xjf "$ARCHIVE" -C "$SOURCE"

bash "$SOURCE/AI_Workflow_Kit/script/workflow_experiment.selftest.sh"
WF_EXPERIMENT_SOURCE_ROOT="$SOURCE" \
  bash "$SOURCE/AI_Workflow_Kit/script/workflow_experiment.sh" _apply-source "$TARGET"
