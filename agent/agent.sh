#!/bin/bash
# Demarre, arrete ou interroge l'agent d'impression local.
PLIST="$HOME/Library/LaunchAgents/com.drop.print.plist"
LOG="$HOME/Library/Logs/drop-print.log"

case "$1" in
  on)
    launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null && echo "agent demarre" || echo "agent deja en route"
    ;;
  off)
    launchctl bootout "gui/$UID/com.drop.print" 2>/dev/null && echo "agent arrete" || echo "agent deja arrete"
    ;;
  status)
    if launchctl print "gui/$UID/com.drop.print" > /dev/null 2>&1; then
      echo "agent en route"
    else
      echo "agent arrete"
    fi
    ;;
  log)
    tail -f "$LOG"
    ;;
  *)
    echo "usage : $0 {on|off|status|log}"
    exit 1
    ;;
esac
