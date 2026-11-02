#!/bin/bash
# Manages the dedicated E2E emulator ($AVD on $SERIAL). Never touches other AVDs.
#   avd.sh create | start | stop | status | screenshot <file>
set -euo pipefail
source /Users/iij/Desktop/AgentsFlow/scripts/mobile-e2e/env.sh
A=("$ADB" -s "$SERIAL")
CFG="$HOME/.android/avd/$AVD.avd/config.ini"

set_cfg() { # key value
  if grep -q "^$1=" "$CFG"; then sed -i '' "s#^$1=.*#$1=$2#" "$CFG"; else echo "$1=$2" >> "$CFG"; fi
}
running() { "$ADB" devices | grep -q "^$SERIAL[[:space:]]*device"; }
booted() { [[ "$("${A[@]}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; }

case "${1:-}" in
  create)
    JAVA_HOME="$JAVA_HOME" "$AVDMANAGER" create avd -n "$AVD" \
      -k "system-images;android-34;google_apis_playstore;arm64-v8a" -d pixel_7 --force < /dev/null
    set_cfg hw.ramSize 2048
    set_cfg hw.keyboard yes
    set_cfg disk.dataPartition.size 4G
    set_cfg hw.audioInput no
    set_cfg hw.camera.back none
    set_cfg hw.camera.front none
    echo "created $AVD ($CFG)" ;;
  start)
    if running && booted; then echo "$SERIAL already running"; exit 0; fi
    if ! running; then
      nohup "$EMULATOR" -avd "$AVD" -no-window -no-audio -gpu swiftshader_indirect -no-boot-anim \
        -no-snapshot -port 5600 > "$PF_TMP/emulator.log" 2>&1 &
      echo "emulator pid $!"
    fi
    t0=$(date +%s)
    "$ADB" -s "$SERIAL" wait-for-device
    until booted; do
      if (( $(date +%s) - t0 > 240 )); then echo "boot timed out after 240 s" >&2; tail -20 "$PF_TMP/emulator.log" >&2; exit 1; fi
      sleep 3
    done
    echo "booted in $(( $(date +%s) - t0 )) s"
    "${A[@]}" shell settings put global window_animation_scale 0
    "${A[@]}" shell settings put global transition_animation_scale 0
    "${A[@]}" shell settings put global animator_duration_scale 0
    "${A[@]}" shell svc power stayon true
    "${A[@]}" shell input keyevent 82 >/dev/null 2>&1 || true ;;
  stop)
    "${A[@]}" emu kill ;;
  status)
    if running; then
      echo "$SERIAL running, boot_completed=$("${A[@]}" shell getprop sys.boot_completed | tr -d '\r'), sdk=$("${A[@]}" shell getprop ro.build.version.sdk | tr -d '\r')"
    else echo "$SERIAL not running"; exit 1; fi ;;
  screenshot)
    f=${2:?usage: avd.sh screenshot <file>}
    "${A[@]}" exec-out screencap -p > "$f"
    sz=$(stat -f %z "$f")
    (( sz > 10240 )) || { echo "screenshot too small ($sz bytes)" >&2; exit 1; }
    echo "$f ($sz bytes)" ;;
  *) echo "usage: avd.sh create|start|stop|status|screenshot <file>" >&2; exit 2 ;;
esac
