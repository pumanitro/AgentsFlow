# Peers Flow · notification designs

Six design mock-ups for how Peers Flow could tell you that a routine needs you (a file to check, questions to answer, a job to do by hand), all shown on the same example: the "Abilitie timesheet" routine on 15 Oct 2026. Pick one; nothing here is wired into the app yet.

Open the gallery (works straight from disk, no server, no network):

```
open /Users/iij/Desktop/AgentsFlow/design/notifications/index.html
```

## Folder map

```
index.html                  start here: the six side by side, numbers, recommendation, build notes
concepts/01-bell-drawer.html        Bell + drawer
concepts/02-needs-you-dock.html     Needs-you pane
concepts/03-needs-you-view.html     Needs-you tab + banner
concepts/04-toast-cards.html        Toasts + sticky cards
concepts/05-status-tray.html        Status-bar tray
concepts/06-agent-asks-in-chat.html Agent asks in chat
concepts/*.meta.js          each design's summary + measured numbers (the index reads only these)
shared/scenario.js          the one example every page uses
shared/app-shell.{css,js}   the look-alike Peers Flow screens (home, routines, chat)
shared/gallery.{css,js}     page chrome: nav, tooltips, theme, step rail, bar chart
shared/tokens.css           colours and sizes, copied from the real app
shared/reference/           screenshots of the real app for comparison
tools/shot.sh               screenshot + error check for any page
```

Add `#embed` to a concept page URL to see only its clickable mock-up (the index thumbnails use this); add `?step=1..4` to open it at a given step.

## Screenshots

```
tools/shot.sh <abs-html-path> <abs-out-png> [width=1440] [height=900] [dark|light] [hash]
# e.g.
tools/shot.sh "$PWD/index.html" /tmp/index.png 390 844 light
SHOT_FULL=1 tools/shot.sh "$PWD/concepts/01-bell-drawer.html" /tmp/01.png   # whole page
```

It runs a private, headless, muted Chrome for Testing (never your own Chrome) and prints `shot: <png> · errors=[] · scroll=ok`, or exits 1 with the reason (JS errors, sideways scrolling, no PNG).
