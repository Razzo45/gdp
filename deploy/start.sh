#!/bin/sh
set -eu
kind="${1:-${SERVICE_KIND:-web}}"
case "$kind" in
  web)
    exec node server.js
    ;;
  worker)
    exec npx tsx --conditions=react-server scripts/worker.ts
    ;;
  migrate)
    exec npx tsx --conditions=react-server scripts/migrate.ts
    ;;
  *)
    echo "Unknown service kind: $kind (web|worker|migrate)" >&2
    exit 2
    ;;
esac
