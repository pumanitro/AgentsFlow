window.PF_CONCEPTS = window.PF_CONCEPTS || {};
window.PF_CONCEPTS["04"] = {
  id: "04", slug: "04-toast-cards", name: "Toasts + sticky cards",
  tagline: "Notices pop up in the bottom-right corner; anything that needs you stays there as a card you work through one step at a time.",
  placement: "Bottom-right corner of every screen, floating over the app",
  answering: "One step at a time inside the card: the PDF, four questions, the to-do, then send",
  proactive: "The card slides up and glows; folded away it stays as an orange “1 needs you” pill in the corner",
  everywhere: true,
  // clicksToResolve counted on this page's mock, manual path with the sample answers:
  // Start 1 · Open the PDF 1 · Q1 Next+No 2 · Q2 Next+No 2 · Q3 Next+“Only 10 Oct” 2 · Q4 Next+type 2 · To-do Next+tick 2 · Send 1 · Dismiss 1 = 14
  metrics: { clicksToResolve: 14, idleSpacePx: 0, interruption: 3, buildEffort: "M" },
  pros: [
    "Takes no space at all when nothing is waiting — it only appears when there is something to say.",
    "Shows up on every screen, so you see it whether you are in a chat, the chat list or the routines board.",
    "One question at a time with a “3 of 6” progress bar: hard to skip one, easy to see how far you are.",
    "The card cannot be closed by accident — folded, it shrinks to a small orange pill that follows you everywhere."
  ],
  cons: [
    "While open, the card covers the bottom-right corner of whatever you are working on.",
    "Next / Back between steps costs clicks: 14 in total for the timesheet.",
    "Several notices at once crowd the corner (only three fit; the rest wait).",
    "No history: once dismissed, a notice is gone — there is no list of past notices to look back at."
  ],
  filesTouched: [
    "renderer/components/notifications/ToastStack.tsx",
    "renderer/components/notifications/StickyActionCard.tsx",
    "renderer/pages/_app.tsx",
    "renderer/components/SpawnBar.tsx",
    "renderer/lib/use-notifications.ts"
  ],
  page: "concepts/04-toast-cards.html"
};
