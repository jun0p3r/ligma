#!/usr/bin/env bash
# Launches Ligma from the source checkout.
export PATH="$HOME/.local/opt/node/bin:$PATH"
cd "$(dirname "$(readlink -f "$0")")" && exec npx electron . "$@"
