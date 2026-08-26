/**
 * Live sampler behind the sidebar Performance panel.
 *
 * Answers "why is the IDE laggy right now" from inside the app, with five
 * views that together separate *us* from *the machine* from *the agents*:
 *
 *   • machine   — whole-box CPU busy %, load vs cores, memory (+ pressure);
 *   • app       — CPU / RSS of the main process and of every Electron child;
 *   • loop      — main event-loop lag (a 500 ms timer's drift), stalls;
 *   • agents    — every `claude` process billed for the whole process subtree
 *                 under it, with its top tool subprocesses (grep, git, vitest…)
 *                 and a by-category roll-up;
 *   • processes — a machine-wide census: claude / node / vitest / chrome
 *                 counts and which command names burn the CPU;
 *
 * plus the per-operation timings perf.ts already keeps for main.log, so the
 * slowest main-thread ops are visible without opening the log.
 *
 * The sampler itself is deliberately cheap: one 500 ms timer (lag ring) and,
 * every fourth tick, one `os.cpus()` + `process.cpuUsage()` read. The
 * ps / vm_stat / sysctl census is the only spawning, runs in the background,
 * and is only kicked when a snapshot is requested — i.e. while the panel is
 * open (or, at a slow cadence, for the collapsed header badge).
 *
 * Electron-specific inputs (`app.getAppMetrics`, the health probe, stall
 * stats, the conversation resolver) are injected by main.ts so this module —
 * and its pure helpers — stay importable under plain `node --test`.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type { PerfAgentRow, PerfAgentsSummary, PerfContainerRow, PerfHistory, PerfHistoryPoint, PerfProcGroup, PerfProcRow, PerfSnapshot, PerfToolCategory, PerfToolRow } from '../shared/types';
import * as perf from './perf';

export interface AppMetricLike {
  type: string;
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number }; // KB
}

export interface AgentQuery { pid: number; sessionId: string | null; conversationId: string | null }
export interface AgentIdentity {
  conversationId?: string | null;
  sessionId?: string | null;
  title?: string | null;
  peer?: string | null;
  status?: string | null;
}
export type AgentResolver = (q: AgentQuery) => AgentIdentity | null;

export interface SysmonProviders {
  appMetrics?: () => AppMetricLike[];
  health?: () => Record<string, unknown>;
  stalls?: () => { count: number; lastAt: string | null; lastMs: number };
  logPath?: () => string | null;
  // Maps a `claude` process to the AgentsFlow conversation it runs (by the
  // conversation id in its --mcp-config path, its session id, or — for --bg
  // daemon workers whose args carry neither — its pid via `claude agents`).
  resolveAgent?: AgentResolver;
}

const LAG_TICK_MS = 500;
const LAG_RING = 120; // 60 s at 500 ms
const CPU_EVERY_TICKS = 4; // 2 s
// Timeline history: one point per HISTORY_TICK_MS, HISTORY_CAP points (~1 h).
// The census behind the agent/process series is refreshed on its own slower
// cadence so the charts keep moving while the monitor is closed.
const HISTORY_TICK_MS = 5000;
const HISTORY_CAP = 720;
const HISTORY_CENSUS_MS = 15_000;
const HISTORY_AGENTS = 8;
const HISTORY_PROCS = 6;
const TOP_CPU_ROWS = 6;
const TOP_AGENT_ROWS = 10;
const TOOLS_PER_AGENT = 4;

// ---------- pure helpers (unit-tested) ----------

/** Fixed-size ring of the most recent event-loop lag samples. */
export class LagRing {
  private buf: number[];
  private idx = 0;
  private filled = 0;
  constructor(private readonly size: number) {
    this.buf = new Array(size).fill(0);
  }
  push(ms: number): void {
    this.buf[this.idx] = ms;
    this.idx = (this.idx + 1) % this.size;
    if (this.filled < this.size) this.filled++;
  }
  stats(): { now: number; max: number; avg: number } {
    if (this.filled === 0) return { now: 0, max: 0, avg: 0 };
    const last = this.buf[(this.idx - 1 + this.size) % this.size];
    let max = 0;
    let sum = 0;
    for (let i = 0; i < this.filled; i++) {
      const v = this.buf[i];
      if (v > max) max = v;
      sum += v;
    }
    return { now: Math.round(last), max: Math.round(max), avg: Math.round(sum / this.filled) };
  }
}

type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number };

/** Whole-machine busy % between two `os.cpus()` readings; null if no delta. */
export function cpuBusyBetween(prev: CpuTimes[], next: CpuTimes[]): number | null {
  let busy = 0;
  let total = 0;
  const n = Math.min(prev.length, next.length);
  for (let i = 0; i < n; i++) {
    const a = prev[i];
    const b = next[i];
    const dBusy = b.user - a.user + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq);
    const dIdle = b.idle - a.idle;
    busy += dBusy;
    total += dBusy + dIdle;
  }
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((busy / total) * 100)));
}

// One row of `ps -axww -o pid=,ppid=,%cpu=,rss=,args=`.
export interface ProcRec {
  pid: number;
  ppid: number;
  cpu: number;
  rssKB: number;
  exe: string; // executable path as it appears in args
  args: string; // full command line
}

/**
 * The executable portion of a command line. Absolute mac bundle paths contain
 * spaces ("…/Google Chrome Helper (Renderer) --type=renderer"), so for those
 * take everything through the `Contents/MacOS/<name>` segment up to the first
 * ` -` flag; otherwise the first whitespace token.
 */
export function exeFromArgs(args: string): string {
  const a = args.trim();
  if (a.startsWith('(') && a.endsWith(')')) return a.slice(1, -1); // zombie / exiting: "(ps)"
  if (a.startsWith('/') && a.includes('/Contents/MacOS/')) {
    const i = a.indexOf('/Contents/MacOS/') + '/Contents/MacOS/'.length;
    const rest = a.slice(i);
    const cut = rest.search(/ -| \//);
    return a.slice(0, i) + (cut === -1 ? rest : rest.slice(0, cut));
  }
  const sp = a.indexOf(' ');
  return sp === -1 ? a : a.slice(0, sp);
}

export function parsePsLines(text: string): ProcRec[] {
  const out: ProcRec[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const args = m[5].trim();
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rssKB: Number(m[4]), exe: exeFromArgs(args), args });
  }
  return out;
}

/**
 * Collapse an executable into the name we aggregate on. Chrome's many helpers
 * and vitest's per-worker titles would otherwise each be their own row.
 */
export function displayName(exe: string, args = exe): string {
  const base = path.basename(exe.trim());
  if (/Virtualization\.VirtualMachine/.test(exe)) return 'Docker VM';
  if (/^chrome-headless-shell/i.test(base)) return 'Chrome (headless)';
  if (/^Google Chrome/.test(base)) return 'Chrome';
  if (/^Electron/.test(base)) return /\/mcp\/agentsflow-mcp/.test(args) ? 'agentsflow-mcp' : 'AgentsFlow (Electron)';
  if (/^node \(vitest/.test(args) || /^node \(vitest/.test(base)) return 'node (vitest)';
  return base;
}

const SEARCH_RE = /^(grep|egrep|fgrep|rg|ripgrep|ag|ack|find|fd|locate|mdfind)$/;
const BUILD_RE = /^(node|tsc|npm|npx|pnpm|yarn|bun|deno|esbuild|vite|next|webpack|rollup|swc|babel|python3?|pip3?|cargo|rustc|go|swift|swiftc|xcodebuild|java|javac|gradle|mvn|make|cmake|clang|gcc|ld)$/;
const TEST_RE = /(vitest|jest|mocha|playwright|cypress|pytest|karma|ava\b)/i;
const SHELL_RE = /^(zsh|bash|sh|fish|dash|ksh)$/;

export function categorize(name: string, args: string): PerfToolCategory {
  const base = name.replace(/ \(.*\)$/, '');
  if (base === 'claude') return 'claude';
  if (name === 'agentsflow-mcp' || /\bmcp\b/i.test(args) && !/--mcp-config/.test(args)) return 'mcp';
  if (SEARCH_RE.test(base)) return 'search';
  if (base === 'git' || base === 'gh') return 'git';
  // Browsers first: a Playwright-driven Chrome has "playwright" in its path,
  // and "what is it doing" is better answered by "driving a browser".
  if (/chrome|chromium|Chrome|Safari|firefox/i.test(name)) return 'browser';
  if (TEST_RE.test(name) || TEST_RE.test(args)) return 'test';
  if (SHELL_RE.test(base)) return 'shell';
  if (/playwright|puppeteer/i.test(args)) return 'browser';
  if (BUILD_RE.test(base)) return 'build';
  return 'other';
}

/** A short, human argument string for a tool row; '' for shell wrappers etc. */
export function shortCmd(name: string, exe: string, args: string): string {
  const base = name.replace(/ \(.*\)$/, '');
  if (SHELL_RE.test(base) || name === 'agentsflow-mcp' || name === 'node (vitest)') return '';
  // A browser's argv is a wall of flags; the process type is the only useful bit.
  if (/chrome|chromium/i.test(name)) return /--type=([a-z-]+)/.exec(args)?.[1] ?? '';
  let rest = args.startsWith(exe) ? args.slice(exe.length) : args;
  rest = rest.replace(/\s+/g, ' ').trim();
  // A process started via a long absolute path is not more informative for it.
  if (rest.startsWith('/')) {
    const sp = rest.indexOf(' ');
    rest = path.basename(sp === -1 ? rest : rest.slice(0, sp)) + (sp === -1 ? '' : rest.slice(sp));
  }
  return rest.length > 60 ? `${rest.slice(0, 57)}…` : rest;
}

interface ClaudeArgs { isClaude: boolean; kind: 'session' | 'spare' | null; sessionId: string | null; conversationId: string | null }

/**
 * Which `claude` processes are agents. The daemon (`claude daemon run`) and
 * PTY hosts (`claude bg-pty-host`) are plumbing and absorb nothing; every
 * other claude process is billed for its subtree.
 */
export function classifyClaude(exe: string, args: string): ClaudeArgs {
  const none: ClaudeArgs = { isClaude: false, kind: null, sessionId: null, conversationId: null };
  if (path.basename(exe) !== 'claude') return none;
  const a = ` ${args} `;
  if (/ daemon run /.test(a) || / bg-pty-host /.test(a)) return { ...none, isClaude: true };
  if (/ bg-spare /.test(a)) return { isClaude: true, kind: 'spare', sessionId: null, conversationId: null };
  const sid = /--session-id\s+([0-9a-f-]{8,})/i.exec(a)?.[1] ?? /--resume\s+([0-9a-f-]{8,})/i.exec(a)?.[1] ?? null;
  const conv = /mcp-configs\/([0-9a-f-]{8,})\.json/i.exec(a)?.[1] ?? null;
  return { isClaude: true, kind: 'session', sessionId: sid, conversationId: conv };
}

/**
 * Bill every process to its nearest agent ancestor and summarise per agent.
 * Pure: the resolver is what turns pids/ids into conversation titles.
 */
/** Which pids are agents, and each process's nearest agent ancestor (itself for an agent). */
export function buildOwnerMap(procs: ProcRec[]): { agentOf: Map<number, ClaudeArgs>; ownerOf: (pid: number) => number | null } {
  const byPid = new Map<number, ProcRec>();
  for (const p of procs) byPid.set(p.pid, p);
  const agentOf = new Map<number, ClaudeArgs>();
  for (const p of procs) {
    const c = classifyClaude(p.exe, p.args);
    if (c.isClaude && c.kind) agentOf.set(p.pid, c);
  }
  const owner = new Map<number, number | null>();
  const ownerOf = (pid: number, depth = 0): number | null => {
    if (owner.has(pid)) return owner.get(pid)!;
    if (agentOf.has(pid)) { owner.set(pid, pid); return pid; }
    const p = byPid.get(pid);
    const r = !p || p.ppid === pid || depth > 64 ? null : p.ppid <= 1 ? null : ownerOf(p.ppid, depth + 1);
    owner.set(pid, r);
    return r;
  };
  return { agentOf, ownerOf };
}

export function attributeAgents(procs: ProcRec[], resolve?: AgentResolver): PerfAgentsSummary {
  const byPid = new Map<number, ProcRec>();
  for (const p of procs) byPid.set(p.pid, p);
  const { agentOf, ownerOf } = buildOwnerMap(procs);

  type Acc = { self: ProcRec; cpu: number; selfCpu: number; rssKB: number; procs: number; tools: Map<string, PerfToolRow> };
  const acc = new Map<number, Acc>();
  for (const [pid, _c] of agentOf) {
    const self = byPid.get(pid)!;
    acc.set(pid, { self, cpu: self.cpu, selfCpu: self.cpu, rssKB: self.rssKB, procs: 0, tools: new Map() });
  }
  const byCategory: Partial<Record<PerfToolCategory, number>> = {};
  const bump = (cat: PerfToolCategory, cpu: number) => { byCategory[cat] = (byCategory[cat] ?? 0) + cpu; };
  for (const [pid] of agentOf) bump('claude', byPid.get(pid)!.cpu);

  for (const p of procs) {
    if (agentOf.has(p.pid)) continue;
    const o = ownerOf(p.pid);
    if (o === null) continue;
    const a = acc.get(o)!;
    a.cpu += p.cpu;
    a.rssKB += p.rssKB;
    a.procs++;
    const name = displayName(p.exe, p.args);
    const cmd = shortCmd(name, p.exe, p.args);
    const category = categorize(name, p.args);
    bump(category, p.cpu);
    const key = `${name}|${cmd}`;
    const t = a.tools.get(key) ?? { name, cmd, category, cpu: 0, rssMB: 0, count: 0 };
    t.cpu += p.cpu;
    t.rssMB += p.rssKB / 1024;
    t.count++;
    a.tools.set(key, t);
  }

  const rows: PerfAgentRow[] = [];
  for (const [pid, c] of agentOf) {
    const a = acc.get(pid)!;
    let id: AgentIdentity | null = null;
    try { id = resolve?.({ pid, sessionId: c.sessionId, conversationId: c.conversationId }) ?? null; } catch { id = null; }
    const tools = Array.from(a.tools.values())
      .filter((t) => t.cpu >= 0.5)
      .sort((x, y) => y.cpu - x.cpu)
      .slice(0, TOOLS_PER_AGENT)
      .map((t) => ({ ...t, cpu: Math.round(t.cpu * 10) / 10, rssMB: Math.round(t.rssMB) }));
    rows.push({
      pid,
      kind: c.kind!,
      sessionId: id?.sessionId ?? c.sessionId,
      conversationId: id?.conversationId ?? c.conversationId,
      title: id?.title ?? null,
      peer: id?.peer ?? null,
      status: id?.status ?? null,
      cpu: Math.round(a.cpu * 10) / 10,
      selfCpu: Math.round(a.selfCpu * 10) / 10,
      rssMB: Math.round(a.rssKB / 1024),
      procs: a.procs,
      tools,
    });
  }
  rows.sort((x, y) => y.cpu - x.cpu);
  const totalCpu = Math.round(rows.reduce((s, r) => s + r.cpu, 0) * 10) / 10;
  for (const k of Object.keys(byCategory) as PerfToolCategory[]) {
    const v = Math.round((byCategory[k] ?? 0) * 10) / 10;
    if (v > 0) byCategory[k] = v; else delete byCategory[k];
  }
  return { rows: rows.slice(0, TOP_AGENT_ROWS), totalCpu, byCategory };
}

/**
 * Where a process comes from, for the "who runs them" line under a top-CPU
 * row: Chrome by profile directory, node by project, others by command.
 */
export function groupLabel(name: string, p: ProcRec): string {
  const a = p.args;
  if (/^Chrome/.test(name)) {
    if (/^Chrome \(headless\)/.test(name)) return 'headless (Playwright)';
    // Profile paths contain spaces ("Application Support"): read to the next flag.
    const ud = /--user-data-dir=(.+?)(?= --|$)/.exec(a)?.[1]?.trim() ?? '';
    if (!ud || /\/Google\/Chrome(Auto)?\/?$/.test(ud) || /Application Support\/Google\/Chrome/.test(ud)) return 'main profile';
    if (/claude|\.claude\/jobs|\/tmp\//i.test(ud)) return 'claude job (throwaway)';
    if (/zoom/i.test(ud)) return 'Zoom webview';
    return path.basename(ud);
  }
  if (name === 'claude') {
    const c = classifyClaude(p.exe, a);
    return c.kind === 'spare' ? 'bg worker' : c.kind === 'session' ? 'session' : 'daemon / pty-host';
  }
  if (name === 'node (vitest)') return 'vitest worker';
  if (/^AgentsFlow|^Electron/.test(name)) {
    const type = /--type=([a-z-]+)/.exec(a)?.[1];
    return type ? type.replace('-process', '') : /crashpad/.test(a) ? 'crashpad' : 'main';
  }
  // A project directory in the command line is the most useful origin: it
  // says which repo's dev server / test run this is.
  const proj = /\/(IdeaProjects|Desktop|Projects|repos|code)\/([^/\s`'"]+)/i.exec(a)?.[2];
  if (proj) return proj;
  if (/^node/.test(name)) {
    // Relative script paths ("--import tsx dashboard/api/server.mjs"): the
    // script file is the identity; failing that the first non-flag token.
    const tokens = (a.startsWith(p.exe) ? a.slice(p.exe.length) : a).split(/\s+/).filter(Boolean);
    const script = tokens.find((t) => /\.(m?js|cjs|[mc]?ts)$/.test(t)) ?? tokens.find((t) => !t.startsWith('-'));
    return script ? path.basename(script) : 'node';
  }
  const first = shortCmd(name, p.exe, a).split(' ')[0];
  const cmd = first.includes('/') ? path.basename(first) : first;
  return cmd ? `${name} ${cmd}` : name;
}

export function buildCensus(procs: ProcRec[], skipPids: number[] = [process.pid]): NonNullable<PerfSnapshot['processes']> {
  const skip = new Set(skipPids);
  const { ownerOf } = buildOwnerMap(procs);
  let total = 0;
  let claude = 0;
  let claudeRssKB = 0;
  let node = 0;
  let vitest = 0;
  let chrome = 0;
  type Agg = { cpu: number; rssKB: number; count: number; agentCpu: number; agentCount: number; groups: Map<string, { count: number; cpu: number }> };
  const byName = new Map<string, Agg>();
  for (const p of procs) {
    if (skip.has(p.pid)) continue;
    const base = path.basename(p.exe);
    total++;
    if (base === 'claude') { claude++; claudeRssKB += p.rssKB; }
    if (/^node\b/.test(base)) node++;
    if (/vitest/.test(p.args)) vitest++;
    if (/chrome/i.test(base)) chrome++;
    const name = displayName(p.exe, p.args);
    const agg = byName.get(name) ?? { cpu: 0, rssKB: 0, count: 0, agentCpu: 0, agentCount: 0, groups: new Map() };
    agg.cpu += p.cpu;
    agg.rssKB += p.rssKB;
    agg.count++;
    if (base !== 'claude' && ownerOf(p.pid) !== null) { agg.agentCount++; agg.agentCpu += p.cpu; }
    const g = groupLabel(name, p);
    const ga = agg.groups.get(g) ?? { count: 0, cpu: 0 };
    ga.count++;
    ga.cpu += p.cpu;
    agg.groups.set(g, ga);
    byName.set(name, agg);
  }
  const topCpu: PerfProcRow[] = Array.from(byName.entries())
    .map(([name, a]) => ({
      name,
      cpu: Math.round(a.cpu),
      rssMB: Math.round(a.rssKB / 1024),
      count: a.count,
      underAgents: { count: a.agentCount, cpu: Math.round(a.agentCpu) },
      groups: Array.from(a.groups.entries())
        .map(([label, g]): PerfProcGroup => ({ label, count: g.count, cpu: Math.round(g.cpu) }))
        .sort((x, y) => y.cpu - x.cpu || y.count - x.count)
        .slice(0, 3),
    }))
    .filter((r) => r.cpu > 0)
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, TOP_CPU_ROWS);
  return { total, claude, claudeRssMB: Math.round(claudeRssKB / 1024), node, vitest, chrome, topCpu };
}

/** Back-compat convenience: text → census in one step. */
export function parsePsOutput(text: string, skipPids: number[] = [process.pid]): NonNullable<PerfSnapshot['processes']> {
  return buildCensus(parsePsLines(text), skipPids);
}

// ---------- sampler ----------

let providers: SysmonProviders = {};
const lag = new LagRing(LAG_RING);
let cpuBusyPct: number | null = null;
let mainCpuPct = 0;
let prevCpus: CpuTimes[] | null = null;
let prevUsage: NodeJS.CpuUsage | null = null;
let prevUsageAt = 0;
let ticks = 0;
let timer: NodeJS.Timeout | null = null;
let historyTimer: NodeJS.Timeout | null = null;
// Worst lag since the last history point (the 60 s ring is too coarse for a
// 5 s series).
let lagSinceHistory = 0;
const history: PerfHistoryPoint[] = [];
const agentNames: PerfHistory['agentNames'] = {};

function sampleCpu(): void {
  const cpus = os.cpus().map((c) => c.times);
  if (prevCpus) cpuBusyPct = cpuBusyBetween(prevCpus, cpus) ?? cpuBusyPct;
  prevCpus = cpus;

  const now = Date.now();
  const usage = process.cpuUsage();
  if (prevUsage && now > prevUsageAt) {
    const dUs = usage.user - prevUsage.user + (usage.system - prevUsage.system);
    const elapsedUs = (now - prevUsageAt) * 1000;
    mainCpuPct = Math.max(0, Math.round((dUs / elapsedUs) * 1000) / 10);
  }
  prevUsage = usage;
  prevUsageAt = now;
}

export function startSysmon(p: SysmonProviders): () => void {
  providers = p;
  if (timer) return () => stopSysmon();
  let expected = Date.now() + LAG_TICK_MS;
  sampleCpu();
  timer = setInterval(() => {
    const now = Date.now();
    const l = Math.max(0, now - expected);
    lag.push(l);
    if (l > lagSinceHistory) lagSinceHistory = l;
    expected = now + LAG_TICK_MS;
    if (++ticks % CPU_EVERY_TICKS === 0) sampleCpu();
  }, LAG_TICK_MS);
  timer.unref?.();
  historyTimer = setInterval(recordHistoryPoint, HISTORY_TICK_MS);
  historyTimer.unref?.();
  return () => stopSysmon();
}

export function stopSysmon(): void {
  if (timer) clearInterval(timer);
  if (historyTimer) clearInterval(historyTimer);
  timer = null;
  historyTimer = null;
}

/** Append one Timeline point from the latest sampler + census values. */
export function recordHistoryPoint(): void {
  // Keep the census moving on its own cadence so the agent/process series
  // are live even while the monitor is closed (the pill only polls slowly).
  if (!census || Date.now() - census.at > HISTORY_CENSUS_MS) void refreshCensus();
  const c = census;
  const app = appProcesses();
  const [load1] = os.loadavg();
  const point: PerfHistoryPoint = {
    t: Date.now(),
    cpuBusyPct,
    load1: Math.round(load1 * 10) / 10,
    memUsedPct: c?.vm ? Math.round((c.vm.usedMB / Math.max(1, c.vm.totalMB)) * 100) : null,
    lagMaxMs: Math.round(lagSinceHistory),
    mainCpuPct: app.mainCpuPct,
    rendererCpuPct: app.rendererCpuPct,
    agentsCpu: c?.agents ? c.agents.totalCpu : null,
    byCategory: c?.agents ? c.agents.byCategory : null,
    agents: c?.agents ? c.agents.rows.slice(0, HISTORY_AGENTS).map((r) => ({ pid: r.pid, cpu: r.cpu })) : null,
    topProcs: c?.processes ? c.processes.topCpu.slice(0, HISTORY_PROCS).map((r) => ({ name: r.name, cpu: r.cpu })) : null,
  };
  lagSinceHistory = 0;
  if (c?.agents) {
    for (const r of c.agents.rows) {
      // Keep the best name we have seen: a resolved title beats a bare pid.
      const prev = agentNames[String(r.pid)];
      if (!prev || (r.title && !prev.title)) agentNames[String(r.pid)] = { title: r.title, peer: r.peer, kind: r.kind };
    }
  }
  history.push(point);
  if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
}

export function getPerfHistory(): PerfHistory {
  // Drop names for agents no longer present in any retained point.
  const live = new Set<string>();
  for (const p of history) for (const a of p.agents ?? []) live.add(String(a.pid));
  for (const k of Object.keys(agentNames)) if (!live.has(k)) delete agentNames[k];
  return { intervalMs: HISTORY_TICK_MS, points: history.slice(), agentNames: { ...agentNames } };
}

// ---------- machine census: ps + vm_stat + pressure (background, never throws) ----------
//
// On a saturated machine `ps` alone can take 10 s+ (observed at load 205), so
// the census is refreshed in the background and a snapshot only ever reads the
// latest completed one — waiting at most CENSUS_FIRST_WAIT_MS for a fresh
// result so a just-opened panel is not empty when the machine is healthy.

const CENSUS_TTL_MS = 4000;
const CENSUS_FIRST_WAIT_MS = 1500;
const CENSUS_CMD_TIMEOUT_MS = 30_000;
// `docker stats` is a ~1 s CLI round-trip; container CPU does not need to be
// re-read on every census.
const DOCKER_TTL_MS = 60_000;
let dockerCache: { at: number; value: PerfSnapshot['docker'] } | null = null;

export interface VmStatSummary { totalMB: number; usedMB: number }

/**
 * Activity Monitor's "Memory Used" from `vm_stat`: active + wired + compressed,
 * less purgeable. Inactive / speculative / file-cache pages are reclaimable
 * and would otherwise make a healthy 128 GB machine read as 99 % used.
 */
export function parseVmStat(text: string, totalBytes: number): VmStatSummary | null {
  const pageM = /page size of (\d+) bytes/.exec(text);
  if (!pageM) return null;
  const page = Number(pageM[1]);
  const pages = (label: string): number | null => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?$`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const active = pages('Pages active');
  const wired = pages('Pages wired down');
  if (active === null || wired === null) return null;
  const compressed = pages('Pages occupied by compressor') ?? 0;
  const purgeable = pages('Pages purgeable') ?? 0;
  const usedBytes = Math.max(0, (active + wired + compressed - purgeable) * page);
  const totalMB = Math.round(totalBytes / 1024 / 1024);
  return { totalMB, usedMB: Math.min(totalMB, Math.round(usedBytes / 1024 / 1024)) };
}

/** `docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'`. */
export function parseDockerStats(text: string): NonNullable<PerfSnapshot['docker']> {
  const rows: PerfContainerRow[] = [];
  for (const raw of text.split('\n')) {
    const [name, cpuS, memS] = raw.trim().split('\t');
    if (!name || cpuS === undefined) continue;
    const cpu = Number(cpuS.replace('%', ''));
    const memM = /([\d.]+)\s*([KMG]i?B)/i.exec(memS ?? '');
    const unit = (memM?.[2] ?? 'MiB').toUpperCase();
    const memMB = memM ? Number(memM[1]) * (unit.startsWith('G') ? 1024 : unit.startsWith('K') ? 1 / 1024 : 1) : 0;
    rows.push({ name, cpu: Number.isFinite(cpu) ? Math.round(cpu * 10) / 10 : 0, memMB: Math.round(memMB) });
  }
  rows.sort((a, b) => b.cpu - a.cpu || b.memMB - a.memMB);
  return { containers: rows.length, top: rows.slice(0, 4) };
}

/** `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. */
export function parsePressureLevel(text: string): PerfSnapshot['system']['memPressure'] {
  const n = Number(text.trim());
  if (n === 1) return 'normal';
  if (n === 2) return 'warning';
  if (n === 4) return 'critical';
  return null;
}

function run(cmd: string, args: string[]): Promise<{ out: string; pid: number } | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: CENSUS_CMD_TIMEOUT_MS }, (err, stdout) => {
        resolve(err || !stdout ? null : { out: String(stdout), pid: child.pid ?? -1 });
      });
    } catch {
      resolve(null);
    }
  });
}

interface Census {
  at: number;
  processes: PerfSnapshot['processes'];
  docker: PerfSnapshot['docker'];
  agents: PerfAgentsSummary | null;
  vm: VmStatSummary | null;
  pressure: PerfSnapshot['system']['memPressure'];
}
let census: Census | null = null;
let censusInflight: Promise<void> | null = null;

function refreshCensus(): Promise<void> {
  if (censusInflight) return censusInflight;
  if (census && Date.now() - census.at < CENSUS_TTL_MS) return Promise.resolve();
  const darwin = process.platform === 'darwin';
  censusInflight = Promise.all([
    run('ps', ['-axww', '-o', 'pid=,ppid=,%cpu=,rss=,args=']).then(async (r) => {
      if (!r) return { processes: null, agents: null, docker: null };
      try {
        const procs = parsePsLines(r.out).filter((p) => p.pid !== r.pid);
        const processes = buildCensus(procs, [process.pid]);
        const agents = attributeAgents(procs, providers.resolveAgent);
        // Only ask Docker when its VM is actually up — otherwise the CLI
        // hangs on a dead socket for the whole timeout.
        const dockerUp = procs.some((p) => /Virtualization\.VirtualMachine|com\.docker\.backend/.test(p.args));
        let docker: PerfSnapshot['docker'] = null;
        if (dockerUp) {
          if (dockerCache && Date.now() - dockerCache.at < DOCKER_TTL_MS) docker = dockerCache.value;
          else {
            docker = await run('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}']).then((d) => (d ? parseDockerStats(d.out) : null));
            dockerCache = { at: Date.now(), value: docker };
          }
        }
        return { processes, agents, docker };
      } catch {
        return { processes: null, agents: null, docker: null };
      }
    }),
    darwin ? run('vm_stat', []).then((r) => (r ? parseVmStat(r.out, os.totalmem()) : null)) : Promise.resolve(null),
    darwin ? run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).then((r) => (r ? parsePressureLevel(r.out) : null)) : Promise.resolve(null),
  ]).then(([ps, vm, pressure]) => {
    census = { at: Date.now(), processes: ps.processes, agents: ps.agents, docker: ps.docker, vm, pressure };
  }).catch(() => { /* keep the previous census */ }).finally(() => { censusInflight = null; });
  return censusInflight;
}

// ---------- snapshot ----------

function systemMemory(vm: VmStatSummary | null): { totalMB: number; usedMB: number; usedPct: number; swapUsedMB: number } {
  // Electron adds getSystemMemoryInfo (KB) to `process`; plain node lacks it.
  const getInfo = (process as unknown as { getSystemMemoryInfo?: () => { total: number; free: number; swapUsed?: number } }).getSystemMemoryInfo;
  let totalMB = os.totalmem() / 1024 / 1024;
  let freeMB = os.freemem() / 1024 / 1024;
  let swapUsedMB = 0;
  try {
    if (typeof getInfo === 'function') {
      const info = getInfo.call(process);
      totalMB = info.total / 1024;
      freeMB = info.free / 1024;
      swapUsedMB = (info.swapUsed ?? 0) / 1024;
    }
  } catch { /* fall back to os.* */ }
  // Prefer the vm_stat view (reclaimable cache excluded); total − free is the
  // fallback on non-mac or before the first census lands.
  const usedMB = vm ? vm.usedMB : Math.max(0, totalMB - freeMB);
  return {
    totalMB: Math.round(totalMB),
    usedMB: Math.round(usedMB),
    usedPct: totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0,
    swapUsedMB: Math.round(swapUsedMB),
  };
}

function appProcesses(): PerfSnapshot['app'] {
  const mem = process.memoryUsage();
  let rendererCpu = 0;
  let rendererRssKB = 0;
  let gpuCpu = 0;
  let totalRssKB = mem.rss / 1024;
  try {
    for (const m of providers.appMetrics?.() ?? []) {
      if (m.type === 'Browser') continue; // that's us; measured directly above
      totalRssKB += m.memory?.workingSetSize ?? 0;
      if (m.type === 'GPU') { gpuCpu += m.cpu?.percentCPUUsage ?? 0; continue; }
      rendererCpu += m.cpu?.percentCPUUsage ?? 0;
      rendererRssKB += m.memory?.workingSetSize ?? 0;
    }
  } catch { /* metrics unavailable — leave zeros */ }
  return {
    uptimeS: Math.round(process.uptime()),
    mainCpuPct,
    mainRssMB: Math.round(mem.rss / 1024 / 1024),
    heapMB: Math.round(mem.heapUsed / 1024 / 1024),
    rendererCpuPct: Math.round(rendererCpu * 10) / 10,
    rendererRssMB: Math.round(rendererRssKB / 1024),
    gpuCpuPct: Math.round(gpuCpu * 10) / 10,
    totalRssMB: Math.round(totalRssKB / 1024),
  };
}

export async function getPerfSnapshot(): Promise<PerfSnapshot> {
  const [load1, load5, load15] = os.loadavg();
  // Kick a census refresh; wait briefly for it only when we have none yet.
  const refresh = refreshCensus();
  if (!census) await Promise.race([refresh, new Promise((r) => setTimeout(r, CENSUS_FIRST_WAIT_MS))]);
  const c = census;
  const mem = systemMemory(c?.vm ?? null);
  const lagStats = lag.stats();
  const stalls = (() => { try { return providers.stalls?.() ?? null; } catch { return null; } })();
  const resources: PerfSnapshot['resources'] = {};
  try {
    for (const [k, v] of Object.entries(providers.health?.() ?? {})) {
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') resources[k] = v;
    }
  } catch { /* ignore */ }
  const win = perf.windowSnapshot(8);
  return {
    at: new Date().toISOString(),
    system: {
      cpuBusyPct,
      load1: Math.round(load1 * 10) / 10,
      load5: Math.round(load5 * 10) / 10,
      load15: Math.round(load15 * 10) / 10,
      cores: os.cpus().length || 1,
      memTotalMB: mem.totalMB,
      memUsedMB: mem.usedMB,
      memUsedPct: mem.usedPct,
      swapUsedMB: mem.swapUsedMB,
      memPressure: c?.pressure ?? null,
    },
    app: appProcesses(),
    loop: {
      lagNowMs: lagStats.now,
      lagMaxMs: lagStats.max,
      lagAvgMs: lagStats.avg,
      stalls: stalls?.count ?? 0,
      lastStallAt: stalls?.lastAt ?? null,
      lastStallMs: stalls?.lastMs ?? 0,
    },
    resources,
    censusAt: c ? new Date(c.at).toISOString() : null,
    agents: c?.agents ?? null,
    processes: c?.processes ?? null,
    docker: c?.docker ?? null,
    ops: { windowSince: win.since, rows: win.rows, recentSlow: perf.recentSlowOps(6) },
    logPath: (() => { try { return providers.logPath?.() || null; } catch { return null; } })(),
  };
}
