#!/usr/bin/env bash
set -euo pipefail
umask 077
bridge_source="$(cd -- "$(dirname -- "$0")" && pwd)"
bridge_state="$HOME/.local/state/personal-agents-bridge"
# Local Ubuntu compatibility library for the installed Node binary, if needed.
bridge_lib="$bridge_state/runtime-libs/usr/lib/x86_64-linux-gnu"
if [[ -d "$bridge_lib" ]]; then export LD_LIBRARY_PATH="$bridge_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; fi
mkdir -p "$bridge_state"
exec flock --nonblock "$bridge_state/controller.lock" node "$bridge_source/server.mjs"
