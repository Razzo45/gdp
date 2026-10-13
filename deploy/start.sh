#!/bin/sh
set -eu
kind="${1:-${SERVICE_KIND:-web}}"

renderer_ok() {
  if [ -n "${LIBREOFFICE_BIN:-}" ] && [ -x "$LIBREOFFICE_BIN" ]; then return 0; fi
  command -v soffice >/dev/null 2>&1 && return 0
  [ -x /usr/bin/soffice ] && return 0
  return 1
}

case "$kind" in
  web)
    exec node server.js
    ;;
  worker)
    if ! renderer_ok; then
      echo "start.sh: LibreOffice (soffice) is missing from this image." >&2
      exit 1
    fi
    exec npx tsx --conditions=react-server scripts/worker.ts
    ;;
  migrate)
    exec npx tsx --conditions=react-server scripts/migrate.ts
    ;;
  catchup)
    if [ "${CATCHUP_SYNC:-0}" != "1" ]; then
      echo "catchup is off. Live Supabase is not read."
      exit 0
    fi
    exec npx tsx --conditions=react-server scripts/sync-live.ts --apply --board-only --no-catalog
    ;;
  *)
    echo "Unknown service kind: $kind (web|worker|migrate|catchup)" >&2
    exit 2
    ;;
esac
