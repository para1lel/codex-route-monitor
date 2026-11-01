#!/usr/bin/env bash
# An OS schedule for the monitor, for a machine whose magpie may be down when a
# slot comes: two systemd --user timers, both calling `scan --scope auto`, which
# does nothing unless the schedule says a slot is due (so the plugin's own tick
# and this one never run a scan twice).
#
#   bash scripts/install-schedule.sh [--cli <path to bin/codex-route-monitor.mjs>]
#                                    [--node <path to node>] [--dry-run] [--uninstall]
set -euo pipefail

CLI=""
NODE=""
UNINSTALL=0
DRY=0
while [ $# -gt 0 ]; do
    case "$1" in
        --cli) CLI="${2:-}"; shift 2 ;;
        --node) NODE="${2:-}"; shift 2 ;;
        --uninstall) UNINSTALL=1; shift ;;
        --dry-run) DRY=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "$CLI" ] || CLI="$(dirname "$HERE")/bin/codex-route-monitor.mjs"
[ -n "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node was not found; pass --node <path to node>" >&2; exit 1; }
[ -f "$CLI" ] || { echo "the monitor's command line was not found at $CLI" >&2; exit 1; }

# The unit must find magpie itself: systemd --user starts it with a bare PATH
# (/usr/local/bin:/usr/bin:/bin), while magpie usually lives in ~/.local/bin.
# Pin the binary found now, and put its folder (and node's) on the unit's PATH
# so anything magpie runs finds the same tools.
MAGPIE_BIN="$(command -v magpie || true)"
if [ -z "$MAGPIE_BIN" ] && [ -x "$HOME/.local/bin/magpie" ]; then
    MAGPIE_BIN="$HOME/.local/bin/magpie"
fi
NODE_DIR="$(dirname "$NODE")"
UNIT_PATH="$NODE_DIR"
if [ -n "$MAGPIE_BIN" ]; then
    MAGPIE_DIR="$(dirname "$MAGPIE_BIN")"
    case ":$UNIT_PATH:" in
        *":$MAGPIE_DIR:"*) ;;
        *) UNIT_PATH="$UNIT_PATH:$MAGPIE_DIR" ;;
    esac
else
    UNIT_PATH="$UNIT_PATH:$HOME/.local/bin"
fi
UNIT_PATH="$UNIT_PATH:/usr/local/bin:/usr/bin:/bin"

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"

DAILY_SERVICE="codex-route-monitor-daily.service"
THREE_SERVICE="codex-route-monitor-3h.service"
DAILY_TIMER="codex-route-monitor-daily.timer"
THREE_TIMER="codex-route-monitor-3h.timer"

run() {
    if [ "$DRY" -eq 1 ]; then echo "would run: $*"; else "$@"; fi
}

if [ "$UNINSTALL" -eq 1 ]; then
    run systemctl --user disable --now "$DAILY_TIMER" "$THREE_TIMER" 2>/dev/null || true
    for unit in "$DAILY_TIMER" "$THREE_TIMER" "$DAILY_SERVICE" "$THREE_SERVICE"; do
        if [ -f "$UNIT_DIR/$unit" ]; then
            if [ "$DRY" -eq 1 ]; then echo "would remove: $UNIT_DIR/$unit"; else rm -f "$UNIT_DIR/$unit"; echo "removed: $UNIT_DIR/$unit"; fi
        fi
    done
    run systemctl --user daemon-reload || true
    exit 0
fi

service_content() {
    cat <<EOF
[Unit]
Description=Codex route monitor for magpie (magpie-codex-route-monitor)

[Service]
Type=oneshot
Environment="PATH=$UNIT_PATH"
EOF
    if [ -n "$MAGPIE_BIN" ]; then
        cat <<EOF
Environment="CODEX_ROUTE_MONITOR_MAGPIE=$MAGPIE_BIN"
EOF
    fi
    cat <<EOF
ExecStart=$NODE $CLI scan --scope auto --trigger os
EOF
}

write_service() {
    local file="$1"
    service_content > "$file"
    echo "wrote: $file"
}

write_timer() {
    local file="$1" calendar="$2" description="$3"
    cat > "$file" <<EOF
[Unit]
Description=$description

[Timer]
OnCalendar=$calendar
Persistent=true

[Install]
WantedBy=timers.target
EOF
    echo "wrote: $file"
}

if [ "$DRY" -eq 1 ]; then
    echo "would write $UNIT_DIR/$DAILY_SERVICE:"
    service_content
    echo "would write $UNIT_DIR/$DAILY_TIMER and $UNIT_DIR/$THREE_TIMER, then enable them"
    exit 0
fi

write_service "$UNIT_DIR/$DAILY_SERVICE"
# one service per schedule is one name; the three-hourly timer reuses it
cp "$UNIT_DIR/$DAILY_SERVICE" "$UNIT_DIR/$THREE_SERVICE"
write_timer "$UNIT_DIR/$DAILY_TIMER" "*-*-* 00:00:00" "Codex route monitor: every Codex account at midnight"
write_timer "$UNIT_DIR/$THREE_TIMER" "*-*-* 03,06,09,12,15,18,21:00:00" "Codex route monitor: the Codex accounts in use, every three hours"

systemctl --user daemon-reload
systemctl --user enable --now "$DAILY_TIMER" "$THREE_TIMER"
echo
echo "enabled: $DAILY_TIMER, $THREE_TIMER"
echo "next runs: systemctl --user list-timers 'codex-route-monitor*'"
