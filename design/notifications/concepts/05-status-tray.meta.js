window.PF_CONCEPTS = window.PF_CONCEPTS || {};
window.PF_CONCEPTS["05"] = {
  id: "05", slug: "05-status-tray", name: "Status-bar tray",
  tagline: "A thin bar along the bottom of every screen counts what needs you; one click opens a small checklist above it.",
  placement: "A 24 px bar at the very bottom of every screen + a pop-up list above its right end",
  answering: "A step-by-step checklist inside the pop-up: open the file, four questions, the to-do — each row opens in place",
  proactive: "The bar flashes orange and shows the title for 6 seconds, then settles into a counter; it never covers your work",
  everywhere: true,
  // Counted on this page's mock, steps 1→4 with the sample answers, by hand (no "fill sample" shortcut):
  // 1 open the tray · 2 "Open ›" on the PDF · 3 Q1 "No" · 4 Q2 "No" · 5 Q3 "Only 10 Oct" · 6 click into the Q4 box (then type) ·
  // 7 "Send answers to the agent" · 8 tick the to-do · 9 "Dismiss". Rows open the next one by themselves, so no extra clicks.
  metrics: { clicksToResolve: 9, idleSpacePx: 24, interruption: 2, buildEffort: "S" },
  pros: [
    "Always visible on every screen, yet never covers what you are working on",
    "The checklist shows exactly how far you are (for example 3 of 6) and opens the next step for you",
    "Smallest build of the six: one bar and one pop-up, no changes inside the existing screens",
    "Room for other facts too (bridge health, how many agents are working, plan usage)"
  ],
  cons: [
    "Easy to miss: the bottom edge is the quietest place on screen once the 6-second flash is over",
    "The pop-up is small (380 px), so long answers feel cramped",
    "Takes 24 px of height on every screen even when nothing is pending",
    "Nothing nudges you again later — if you miss the flash, only the orange counter remains"
  ],
  filesTouched: [
    "renderer/components/notifications/StatusBar.tsx",
    "renderer/components/notifications/TrayPopover.tsx",
    "renderer/lib/use-notifications.ts",
    "renderer/pages/_app.tsx",
    "renderer/pages/index.tsx",
    "renderer/pages/session.tsx",
    "renderer/pages/preview.tsx"
  ],
  page: "concepts/05-status-tray.html"
};
