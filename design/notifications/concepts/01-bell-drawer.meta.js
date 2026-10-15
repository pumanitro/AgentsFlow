window.PF_CONCEPTS = window.PF_CONCEPTS || {};
window.PF_CONCEPTS["01"] = {
  id: "01", slug: "01-bell-drawer", name: "Bell + drawer",
  tagline: "A bell in the header; a drawer slides over whatever you are doing.",
  placement: "Header (every screen) + right-side drawer",
  answering: "Cards inside the drawer; you answer in place",
  proactive: "The drawer opens itself when something needs you",
  everywhere: true,
  // clicksToResolve counted on the mock, manual path, sample answers:
  // open the card 1 · open the PDF 1 · Q1 "No" 1 · Q2 "No" 1 · Q3 "Only 10 Oct" 1 · Q4 click into the box 1 (then type) · tick the to-do 1 · Send answers 1 · Dismiss 1 = 9
  // (the drawer opens by itself, so reaching the card costs no click)
  metrics: { clicksToResolve: 9, idleSpacePx: 0, interruption: 3, buildEffort: "M" },
  pros: [
    "Everyone already knows a bell: nothing new to learn.",
    "The bell is on every screen, including inside a chat, so you never miss the count.",
    "Takes no room when nothing is waiting — the drawer is only there while you need it.",
    "You answer the four questions right in the drawer, without leaving what you were doing."
  ],
  cons: [
    "When the drawer opens by itself it covers the right third of the screen until you close it.",
    "The light notices only flash for 6 seconds; after that you have to open the bell to see them.",
    "The drawer is narrow, so a long list of questions means scrolling.",
    "A bell is easy to learn to ignore once it shows a number all day."
  ],
  filesTouched: [
    "renderer/components/notifications/NotificationBell.tsx",
    "renderer/components/notifications/NotificationDrawer.tsx",
    "renderer/components/notifications/NotificationCard.tsx",
    "renderer/lib/use-notifications.ts",
    "renderer/pages/_app.tsx",
    "renderer/pages/index.tsx",
    "renderer/pages/session.tsx",
    "renderer/pages/preview.tsx"
  ],
  page: "concepts/01-bell-drawer.html"
};
