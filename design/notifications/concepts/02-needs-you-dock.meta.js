window.PF_CONCEPTS = window.PF_CONCEPTS || {};
window.PF_CONCEPTS["02"] = {
  id: "02", slug: "02-needs-you-dock", name: "Needs-you pane",
  tagline: "A “Needs you” panel sits on top of Accounts and Usage; clicking a notice opens a short step-by-step sheet.",
  placement: "Sidebar panel above Accounts (home + chat) · small chip on the Routines toolbar",
  answering: "A step-by-step sheet: the file, one question per page, your to-do, then send and dismiss",
  proactive: "The panel unfolds by itself and its header pulses orange twice; nothing covers your work",
  everywhere: true,
  // clicksToResolve: counted on this page's mock, manual path with the sample answers:
  // row 1 · Open › 1 · Next 1 · Q1 "No" 1 · Q2 "No" 1 · Q3 "Only 10 Oct" 1 · Q4 click+type+Next 2 · tick + Next 2 · Send answers 1 · Mark done & dismiss 1 = 12
  // idleSpacePx: the folded panel header (34 px) + the dock gap (8 px); the page re-measures it at step 4 and reports a mismatch as an error
  metrics: { clicksToResolve: 12, idleSpacePx: 42, interruption: 2, buildEffort: "M" },
  pros: [
    "Nothing ever covers your work — notices wait in the sidebar until you are ready.",
    "Everything waiting for you is in one tidy list, in a panel style you already know from Accounts and Usage.",
    "The step-by-step sheet turns four questions into a short form; close it half-way and it remembers where you were.",
    "Finish button stays locked, with a note saying exactly what is still missing, so nothing slips through."
  ],
  cons: [
    "It lives in the bottom-left corner — easy to miss when your eyes are on a chat.",
    "On the Routines screen there is no sidebar, so only a small chip in the toolbar tells you.",
    "One question per page is slower than answering everything at once: 12 clicks in total.",
    "The panel header stays on screen (42 px) even when nothing is waiting, and it squeezes the peers list."
  ],
  filesTouched: [
    "renderer/components/notifications/NeedsYouPane.tsx",
    "renderer/components/notifications/ActionSheet.tsx",
    "renderer/components/routines/NeedsYouChip.tsx",
    "renderer/components/DockedPanes.tsx",
    "renderer/components/routines/RoutinesView.tsx",
    "renderer/pages/_app.tsx",
    "renderer/lib/use-notifications.ts",
    "electron/notifications-store.ts"
  ],
  page: "concepts/02-needs-you-dock.html"
};
