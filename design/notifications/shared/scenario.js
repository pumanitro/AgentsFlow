// shared/scenario.js — the ONE scenario every concept page renders. Frozen after wave 0.
window.PF_SCENARIO = {
  now: "2026-10-15T09:04:00+02:00",
  appVersion: "11.0.0",
  peers: [
    { id: "p-atlas",      name: "atlas-of-doors", path: "~/IdeaProjects/atlas-of-doors" },
    { id: "p-nutrable",   name: "nutrable",       path: "~/IdeaProjects/nutrable" },
    { id: "p-arrow",      name: "arrow",          path: "~/IdeaProjects/arrow" },
    { id: "p-agentsflow", name: "AgentsFlow",     path: "~/Desktop/AgentsFlow" },
    { id: "p-abi",        name: "abi",            path: "~/Desktop/abi" },
    { id: "p-lisa",       name: "LISA",           path: "~/Desktop/LISA" }
  ],
  selectedPeerId: "p-lisa",
  accounts: { active: "me.di…@gmail.com", activePct: 83, others: [{ label: "pe…@gmail.com", pct: 29 }, { label: "pa…@gmail.com", pct: 98 }] },
  usage: { plan: "Max (20x)", session: 48, weekly: 83 },
  routines: [
    { id: "r-timesheet", name: "Abilitie timesheet", peerId: "p-lisa",  icon: "coin",   cadence: "monthly",      monthDays: [15],    time: "09:00", prompt: "/log-time-abilitie --prepare-only" },
    { id: "r-reddit",    name: "Reddit daily",       peerId: "p-atlas", icon: "reddit", cadence: "daily",                            time: "09:00", prompt: "/reddit-daily-routine" },
    { id: "r-crash",     name: "Crash sweep",        peerId: "p-atlas", icon: "bug",    cadence: "daily",                            time: "08:00", prompt: "Sweep new crash reports and file the repeats" },
    { id: "r-invoices",  name: "Invoice run",        peerId: "p-lisa",  icon: "mail",   cadence: "twiceMonthly", monthDays: [1, 15], time: "12:00", prompt: "/draft-invoices" }
  ],
  runs: [
    { id: "run-ts-1015", routineId: "r-timesheet", slotAt: "2026-10-15T09:00:00+02:00", status: "attention", conversationId: "c-timesheet",     summary: "Timesheet prepared — 4 questions for you" },
    { id: "run-rd-1015", routineId: "r-reddit",    slotAt: "2026-10-15T09:00:00+02:00", status: "success",   conversationId: "c-reddit",        summary: "3 posts summarized, nothing needed" },
    { id: "run-cs-1015", routineId: "r-crash",     slotAt: "2026-10-15T08:00:00+02:00", status: "failed",    conversationId: "c-crash",         error: "chat exited 1 before finishing" },
    { id: "run-ts-0915", routineId: "r-timesheet", slotAt: "2026-09-15T09:00:00+02:00", status: "success",   conversationId: "c-timesheet-sep", summary: "Timesheet sent" }
  ],
  conversations: [   // the home list, top to bottom; kind:"divider" rows are separators
    { kind: "divider", id: "d-important", title: "IMPORTANT" },
    { id: "c-timesheet", peerId: "p-lisa",       title: "Abilitie timesheet · 15 Oct 09:00", state: "done",        routineId: "r-timesheet" },
    { id: "c-reddit",    peerId: "p-atlas",      title: "Reddit daily · 15 Oct 09:00",       state: "done",        routineId: "r-reddit" },
    { id: "c-crash",     peerId: "p-atlas",      title: "Crash sweep · 15 Oct 08:00",        state: "failed",      routineId: "r-crash" },
    { id: "c-1",         peerId: "p-atlas",      title: "V2 · /game-council Man – old priorities", state: "working" },
    { id: "c-2",         peerId: "p-agentsflow", title: "Eye icon, reset IDE to release and then do IMG and new tag version", state: "done" },
    { kind: "divider", id: "d-later", title: "LATER" },
    { id: "c-3",         peerId: "p-nutrable",   title: "Components",  state: "needs-input" },
    { id: "c-4",         peerId: "p-abi",        title: "Arrow Lint",  state: "done" },
    { id: "c-5",         peerId: "p-lisa",       title: "/hn-search whisper", state: "done" }
  ],
  chat: {   // the transcript shown in the session view for c-timesheet (the real app shows a terminal; we show plain lines in the terminal's look)
    conversationId: "c-timesheet",
    lines: [
      { who: "you",   text: "/log-time-abilitie --prepare-only" },
      { who: "agent", text: "Collected 61 commits across arrow, influence and case-challenge for 1–15 Oct." },
      { who: "agent", text: "Built the timesheet: 11 working days, 88 h. Your calendar says 3 Oct and 10 Oct were vacation, so they are left empty." },
      { who: "agent", text: "Saved the PDF: ~/Desktop/LISA/timesheets/2026-10-abilitie-timesheet.pdf" },
      { who: "agent", text: "Before you send it I need four answers from you (see the notification). I will not send the email — that is yours to do." }
    ]
  },
  files: [
    { path: "/Users/iij/Desktop/LISA/timesheets/2026-10-abilitie-timesheet.pdf", label: "October timesheet (PDF)", kind: "pdf", sizeKb: 184 }
  ],
  notifications: [
    {
      id: "n-timesheet", level: "action",
      title: "Abilitie timesheet is ready — needs you",
      body: "The routine prepared the 1–15 October timesheet. Check the PDF, answer four questions, then send the email yourself.",
      createdAt: "2026-10-15T09:04:00+02:00",
      source: { kind: "routine", routineId: "r-timesheet", runId: "run-ts-1015", conversationId: "c-timesheet", peerId: "p-lisa" },
      files: [{ path: "/Users/iij/Desktop/LISA/timesheets/2026-10-abilitie-timesheet.pdf", label: "October timesheet (PDF)" }],
      questions: [
        { id: "q1", text: "Any days off between 1 and 15 October that I should take out?", kind: "yesno", hint: "I found none in your calendar.", sampleAnswer: "No" },
        { id: "q2", text: "Did you hand any of this work to someone else (so it should not be billed as yours)?", kind: "yesno", sampleAnswer: "No" },
        { id: "q3", text: "I marked 3 Oct and 10 Oct as vacation from your calendar — is that right?", kind: "choice", choices: ["Yes, both", "Only 3 Oct", "Only 10 Oct", "Neither"], sampleAnswer: "Only 10 Oct" },
        { id: "q4", text: "Any changes to the descriptions or hours before I finalize the file?", kind: "text", sampleAnswer: "Rename 'misc fixes' on 7 Oct to 'Arrow lint clean-up'." }
      ],
      todos: [{ id: "t1", text: "Send the timesheet email to Abilitie yourself — the agent never sends email", done: false }],
      dismissPolicy: "when-complete"
    },
    {
      id: "n-reddit", level: "info",
      title: "Reddit daily finished", body: "Nothing needed — 3 posts summarized.",
      createdAt: "2026-10-15T09:03:10+02:00",
      source: { kind: "routine", routineId: "r-reddit", runId: "run-rd-1015", conversationId: "c-reddit", peerId: "p-atlas" },
      autoDismissMs: 6000, dismissPolicy: "auto"
    },
    {
      id: "n-crash", level: "warn",
      title: "Crash sweep did not finish", body: "The chat stopped before the sweep was done (exit 1). Open it to retry.",
      createdAt: "2026-10-15T08:02:40+02:00",
      source: { kind: "routine", routineId: "r-crash", runId: "run-cs-1015", conversationId: "c-crash", peerId: "p-atlas" },
      dismissPolicy: "one-click"
    }
  ],
  levels: {
    info:   { label: "Just so you know",     color: "var(--pf-info)",      glyph: "ⓘ", rule: "Fades by itself after 6 seconds" },
    warn:   { label: "Something went wrong", color: "var(--pf-warn)",      glyph: "⚠", rule: "Stays until you close it (one click)" },
    action: { label: "Needs you",            color: "var(--pf-attention)", glyph: "●", rule: "Stays until every question is answered and every to-do is ticked" }
  }
};
