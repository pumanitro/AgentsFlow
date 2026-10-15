window.PF_CONCEPTS = window.PF_CONCEPTS || {};
window.PF_CONCEPTS["06"] = {
  id: "06", slug: "06-agent-asks-in-chat", name: "Agent asks in chat",
  tagline: "The questions wait inside the routine's own chat; a small counter in the header takes you there.",
  placement: "A card at the top of the routine's chat + a “needs you” counter in the header + a badge on the home row",
  answering: "In the card inside that chat; your answers are posted into the chat as your reply",
  proactive: "The home row flashes, a 6-second pop-up appears and the header counter lights up orange",
  everywhere: true,
  metrics: { clicksToResolve: 9, idleSpacePx: 0, interruption: 2, buildEffort: "M" },
  // clicksToResolve counted on the mock, manual path with the sample answers:
  // 1 pop-up "Open ›" · 2 PDF "Open ›" · 3 Q1 "No" · 4 Q2 "No" · 5 Q3 "Only 10 Oct" · 6 click into Q4 and type · 7 tick the to-do · 8 "Send answers to the agent" · 9 "Dismiss"
  pros: [
    "You answer right next to what the agent did, so you see its reasoning while you answer.",
    "Your answers land in the chat as your own reply — the agent picks them up with no copy-paste.",
    "Takes no extra screen space when nothing is waiting: the counter sits in the header that is already there."
  ],
  cons: [
    "You have to leave what you are doing and open that chat to answer.",
    "With several chats waiting you hop between them one at a time.",
    "The pop-up only lasts 6 seconds; if you miss it, only the small counter and the row badge remain."
  ],
  filesTouched: [
    "renderer/components/notifications/AgentAsksCard.tsx",
    "renderer/components/notifications/NeedsYouChip.tsx",
    "renderer/pages/session.tsx",
    "renderer/pages/index.tsx",
    "renderer/components/PinnedRow.tsx",
    "renderer/lib/use-notifications.ts"
  ],
  page: "concepts/06-agent-asks-in-chat.html"
};
