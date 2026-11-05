#!/usr/bin/env bash
# Optional wrapper on YOUR GPU server; keep its configured copy outside Git.
set -euo pipefail
# An absolute path; configure this directory with YOUR provider or login.
export CODEX_HOME="/srv/private/tinylens-codex"
# When using API authentication, load YOUR key from an external, chmod-600 file.
# The file contains only the key, without quotes or variable names.
export TINYLENS_API_KEY
TINYLENS_API_KEY=$(cat "/srv/private/tinylens-api-key")
# Replace with the actual Codex executable installed on your server.
exec /usr/local/bin/codex "$@"
