#!/usr/bin/env bash
# Reset Narra to test first-run onboarding. Quit Narra first (menu-bar icon → Quit Narra).
#
#   scripts/reset-narra.sh            # back to onboarding; keeps the old Google Sheet copy
#                                     # so "bring in my history" can be tested again
#   scripts/reset-narra.sh --fresh    # like a brand-new install (a colleague's first run)
#   scripts/reset-narra.sh --restore  # undo the last reset
#
# Every reset first saves the current data next to it, so --restore brings it all back.
set -euo pipefail

DIR="$HOME/Library/Application Support/com.renz.narra"
STORE="$DIR/store.json"
SAVED="$DIR/store.before-reset.json"
BACKUP="$HOME/Documents/Narra/narra-backup.json"

if pgrep -xq narra 2>/dev/null; then
  echo "Narra is still running. Quit it first (menu-bar icon → Quit Narra), then run this again." >&2
  exit 1
fi

case "${1:-}" in
  --restore)
    [ -f "$SAVED" ] || { echo "Nothing to restore ($SAVED not found)." >&2; exit 1; }
    cp "$SAVED" "$STORE"
    [ -f "$SAVED.backup" ] && cp "$SAVED.backup" "$BACKUP"
    echo "Restored your data from before the reset. Open Narra."
    exit 0
    ;;
  --fresh | "")
    ;;
  *)
    echo "Unknown option: $1" >&2
    exit 1
    ;;
esac

[ -f "$STORE" ] || { echo "No Narra data yet; it's already fresh."; exit 0; }
cp "$STORE" "$SAVED"
[ -f "$BACKUP" ] && cp "$BACKUP" "$SAVED.backup"

if [ "${1:-}" = "--fresh" ]; then
  rm -f "$STORE" "$BACKUP"
  echo "Narra is reset like a new install. Open it to see onboarding."
else
  # Clear who you are, the timesheet, and the mode; keep the sheet copy (for the import
  # step), holidays, widget position and reminder settings.
  python3 - "$STORE" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
for key in ('name', 'monthly_rate', 'mode', 'api_url', 'api_key', 'sheet_url', 'sheet_name', 'sync_error'):
    data.pop(key, None)
data['days'] = {}
data['dirty'] = []
json.dump(data, open(path, 'w'), indent=2)
PY
  rm -f "$BACKUP"
  echo "Narra is back to onboarding (your old sheet copy is kept, so the import step shows)."
fi
echo "Undo any time with: scripts/reset-narra.sh --restore"
