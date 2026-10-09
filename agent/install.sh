#!/bin/bash
# Installe l'agent d'impression DROP comme service en tache de fond.
set -e

AGENT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_SRC="$AGENT_DIR/com.drop.print.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.drop.print.plist"
LOG="$HOME/Library/Logs/drop-print.log"
NODE="$(command -v node)"

if [ -z "$NODE" ]; then
  echo "node introuvable. Installe Node.js puis relance ce script."
  exit 1
fi

# Le jeton ne vit jamais dans ce depot : il se passe en argument
# (./install.sh <jeton>) ou dans DROP_PRINT_TOKEN, sinon le fichier est cree
# avec une place a remplir. Voir README.md pour le recuperer.
JETON="${1:-$DROP_PRINT_TOKEN}"
if [ ! -f "$HOME/.drop-print.json" ]; then
  cat > "$HOME/.drop-print.json" <<JSON
{
  "server": "https://feurdrop3-production.up.railway.app",
  "token": "${JETON:-COLLE-ICI-LE-JETON-D-IMPRESSION}",
  "printer": "ITPP130_Printer_0",
  "pollSeconds": 10
}
JSON
  chmod 600 "$HOME/.drop-print.json"
  echo "Configuration creee : $HOME/.drop-print.json"
fi
if grep -q "COLLE-ICI-LE-JETON" "$HOME/.drop-print.json"; then
  echo "Mets le jeton d'impression dans $HOME/.drop-print.json (voir README.md), puis relance ce script."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE|" \
    -e "s|__AGENT__|$AGENT_DIR/drop-print.js|" \
    -e "s|__LOG__|$LOG|" \
    "$PLIST_SRC" > "$PLIST_DST"

launchctl bootout "gui/$UID/com.drop.print" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST_DST"

echo "Agent installe et demarre."
echo "  journal   : $LOG"
echo "  arreter   : $AGENT_DIR/agent.sh off"
echo "  redemarrer: $AGENT_DIR/agent.sh on"
