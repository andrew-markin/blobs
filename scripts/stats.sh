#!/bin/sh
# Appends a daily snapshot of the storage usage to ~/blobs/stats.csv:
#   date,edited within 1 day,edited within 7 days,edited within 30 days,total
# Blobs are counted by modification times of their files, so nothing about
# their clients is collected. A blob edited on several days counts once in
# every period it was edited within.
#
# Copy the script to the server and install it to run daily at 23:55:
#   scp scripts/stats.sh developer@blobs.mayfleet.com:blobs/
#   ssh developer@blobs.mayfleet.com "(crontab -l 2>/dev/null | grep -v blobs/stats.sh; echo '55 23 * * * /bin/sh \$HOME/blobs/stats.sh') | crontab -"

set -e

BLOBS_DIR="$HOME/blobs"

# Use the storage directory from the ecosystem file, as the app does
if [ -z "$STORAGE" ] && [ -f "$BLOBS_DIR/ecosystem.json" ]; then
  STORAGE=$(sed -n 's/.*"STORAGE"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$BLOBS_DIR/ecosystem.json")
fi
STORAGE="${STORAGE:-$HOME/.local/share/blobs/storage}"

# Temporary, backup and corrupted files have other extensions
count() {
  find "$STORAGE" -type f -name '*.json' "$@" | wc -l | tr -d ' '
}

echo "$(date +%F),$(count -mtime -1),$(count -mtime -7),$(count -mtime -30),$(count)" >> "$BLOBS_DIR/stats.csv"
