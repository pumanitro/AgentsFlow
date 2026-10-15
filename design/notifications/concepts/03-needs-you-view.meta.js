window.PF_CONCEPTS = window.PF_CONCEPTS || {};
window.PF_CONCEPTS["03"] = {
  id: "03", slug: "03-needs-you-view", name: "Needs-you tab + banner",
  tagline: "A third tab next to Chat and Routines holds everything waiting for you; a slim orange strip on every screen says so until it is handled.",
  placement: "Third tab in the Chat | Routines switch + a strip under the header on every screen",
  answering: "A full page of its own: list on the left, the form in the middle, the routine's story on the right",
  proactive: "An orange strip slides in under the header and pushes the screen down; it has no close button",
  everywhere: true,
  // Counted on this page's mock (manual path, sample answers): Review › 1 · Open PDF 1 · Q1 1 · Q2 1 · Q3 1 · Q4 field 1 (then typing) · to-do 1 · Send answers 1 · Dismiss 1
  metrics: { clicksToResolve: 9, idleSpacePx: 0, interruption: 3, buildEffort: "L" },
  pros: [
    "Hard to miss: the orange strip sits on every screen until the job is done, and it cannot be closed by accident.",
    "Plenty of room to answer: the questions get a whole page, with the file and the routine's history beside them.",
    "One place to look: everything that ever needed you is listed in the same tab, done ones under \"Earlier\".",
    "Nothing covers your work: the strip pushes the screen down instead of floating over it."
  ],
  cons: [
    "Answering takes you away from where you were — you switch to a different tab and back.",
    "The strip costs 32 pixels of height on every screen while something is waiting.",
    "The biggest build of the six: a whole new page plus a strip wired into three screens.",
    "A strip with no close button can feel nagging if you choose to deal with it later."
  ],
  filesTouched: [
    "renderer/lib/ui-state.ts",
    "renderer/pages/index.tsx",
    "renderer/pages/session.tsx",
    "renderer/pages/preview.tsx",
    "renderer/components/needs-you/NeedsYouView.tsx",
    "renderer/components/needs-you/NeedsYouList.tsx",
    "renderer/components/needs-you/NeedsYouWork.tsx",
    "renderer/components/needs-you/NeedsYouContext.tsx",
    "renderer/components/needs-you/NeedsYouBanner.tsx",
    "renderer/lib/needs-you-ui-state.ts",
    "renderer/lib/use-notifications.ts",
    "shared/notifications.ts",
    "electron/notifications-store.ts"
  ],
  page: "concepts/03-needs-you-view.html"
};
