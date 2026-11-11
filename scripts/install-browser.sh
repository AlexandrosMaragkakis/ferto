#!/usr/bin/env bash
set -euo pipefail

# CI-only: GNU timeout bounds apt and downloads. Overrides may only shorten it.
limit="${FERTO_BROWSER_INSTALL_TIMEOUT_SECONDS:-120}"
grace="${FERTO_BROWSER_INSTALL_KILL_SECONDS:-5}"
delay="${FERTO_BROWSER_INSTALL_RETRY_SECONDS:-10}"
for setting in limit grace delay; do
  value="${!setting}"
  if [[ ! "$value" =~ ^[0-9]{1,3}$ ]] || (( 10#$value > 120 )); then
    echo "Invalid browser installer timing: $setting" >&2
    exit 2
  fi
done
if (( 10#$limit < 1 || 10#$grace < 1 || 10#$grace > 5 || 10#$delay > 10 )); then
  echo 'Browser installer timings exceed the supported bounds.' >&2
  exit 2
fi
status=1
node_bin="$(command -v node)"
timeout_bin="$(command -v timeout)"
launcher=()
if [[ "${GITHUB_ACTIONS:-}" == "true" ]] && (( EUID != 0 )); then
  # Playwright otherwise launches root-owned apt under an unprivileged timeout.
  # A timed-out apt could survive and hold the package lock during the retry.
  : "${PLAYWRIGHT_BROWSERS_PATH:?CI must set a shared browser installation path}"
  launcher=(sudo -n env "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH")
fi
for attempt in 1 2; do
  echo "Browser installation attempt $attempt/2 (timeout ${limit}s; termination grace ${grace}s)."
  if "${launcher[@]}" "$timeout_bin" --signal=TERM --kill-after="${grace}s" "${limit}s" \
    "$node_bin" node_modules/@playwright/test/cli.js install --with-deps chromium; then
    echo 'Browser installation completed.'
    exit 0
  else
    status=$?
    echo "Browser installation attempt $attempt failed (exit $status)." >&2
  fi
  if (( attempt < 2 )); then sleep "$delay"; fi
done
echo 'Browser installation failed after two attempts; verification cannot continue.' >&2
exit "$status"
