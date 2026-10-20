#!/usr/bin/env bash
# Commands run on the server by the deployment scripts:
#   activate <release>  switch to the release, restart and switch back if it
#                       doesn't respond
#   rollback            switch to the release which was active before
#   prune               remove old releases except the current and previous ones
#
# The `current` link points to the active release, and the `previous` one to
# the release which was active before it.

set -euo pipefail

KEEP_RELEASES=5
HEALTH_ATTEMPTS=15

cd ~/blobs
# shellcheck disable=SC1090
source ~/.nvm/nvm.sh

# The Engine.IO handshake is answered before the token check, so no
# credentials are needed to make sure the server works
healthy() {
  local port
  port=$(node -p "require('./ecosystem.json').apps[0].env?.PORT ?? 3000")
  local url="http://localhost:$port/socket.io/?EIO=4&transport=polling"
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if node -e "fetch('$url').then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1))"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Replacing a link by renaming is atomic, unlike `ln -sfn` alone
link() {
  ln -sfn "$2" "$1.tmp"
  mv -T "$1.tmp" "$1"
}

restart() {
  pm2 startOrRestart ecosystem.json --silent
}

# Switch to the release and restart, or switch back if it doesn't work
start_release() {
  local release=$1 active=$2
  link current "$release"
  # A failed restart is handled like a release not responding
  if restart && healthy; then
    [[ -n $active ]] && link previous "$active"
    pm2 save --silent
    echo "Release $release is active"
    return 0
  fi
  echo "Release $release doesn't respond" >&2
  if [[ -n $active ]]; then
    link current "$active"
    restart || echo "Unable to restart $active" >&2
    echo "Switched back to $active" >&2
  fi
  return 1
}

activate() {
  local release="releases/${1:?Release name is required}"
  [[ -d $release ]] || { echo "Release $release is not found" >&2; return 1; }
  start_release "$release" "$(readlink current || true)"
}

rollback() {
  local previous
  previous=$(readlink previous || true)
  if [[ -z $previous || ! -d $previous ]]; then
    echo "There is no previous release" >&2
    return 1
  fi
  start_release "$previous" "$(readlink current)"
}

prune() {
  local kept
  kept=$(for name in current previous; do basename "$(readlink "$name" || echo none)"; done)
  ls -1 releases | sort -r | tail -n +$((KEEP_RELEASES + 1)) | { grep -vxF "$kept" || true; } |
    while read -r name; do
      rm -rf "releases/$name"
      echo "Release $name is removed"
    done
}

"$@"
