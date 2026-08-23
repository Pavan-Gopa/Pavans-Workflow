#!/usr/bin/env bash
# User-facing entry for the lean-pipeline experiment.
# apply | check | doctor | rollback [project]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/../experiments/lean-pipeline/install.sh" "${@:-apply}"
