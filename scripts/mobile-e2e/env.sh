#!/bin/bash
# Shared settings for the mobile E2E harness. Source it: `source .../env.sh`.
# Everything lives under PF_TMP; the live Peers Flow app and its userData are never touched.
export PF_REPO=/Users/iij/Desktop/AgentsFlow
export PF_E2E="$PF_REPO/scripts/mobile-e2e"
export PF_TMP=/Users/iij/.claude/jobs/106e55f3/tmp
export PF_USERDATA="$PF_TMP/pf-mobile-userdata"
export PF_SCRATCH_PEER="$PF_TMP/pf-scratch-peer"
# 47821 (the contract's example) is held by ai-factory/rent-model-5090/refresh_server.py (PORT = 47821).
export PF_PORT=${PF_PORT:-47822}
export PF_SIDE=${PF_SIDE:-47832}
export PF_PIDFILE="$PF_TMP/pf-mobile.pid"
export PF_LOG="$PF_TMP/pf-mobile.log"
export ADB=/Users/iij/Library/Android/sdk/platform-tools/adb
export EMULATOR=/Users/iij/Library/Android/sdk/emulator/emulator
export AVDMANAGER=/Users/iij/Library/Android/sdk/cmdline-tools/latest/bin/avdmanager
export AVD=peersflow_api34
export SERIAL=emulator-5600
export APK="$PF_REPO/android/app/build/outputs/apk/debug/app-debug.apk"
export PKG=com.peersflow.mobile
export EVIDENCE=/Users/iij/.claude/plan-and-execute/AgentsFlow-mobile-app/evidence
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
# Claude Code stores transcripts under ~/.claude/projects/<cwd with every non-alphanumeric char -> '-'>
# (electron/transcript-path.ts mungeCwd). Computed, not hardcoded.
export TRANSCRIPTS="$HOME/.claude/projects/$(printf '%s' "$PF_SCRATCH_PEER" | sed 's/[^a-zA-Z0-9]/-/g')"
export PF_BASE="http://127.0.0.1:$PF_PORT/api/v1"
export PF_SIDE_BASE="http://127.0.0.1:$PF_SIDE"
