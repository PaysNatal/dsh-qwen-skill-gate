/**
 * Qwen skill gate — DeepSeek Harness Host plugin.
 *
 * Exposes the Qwen (`qianwen*`) skills only while the viewing session's model
 * provider is the configured allowed provider (default `qwen-token-plan-cn`).
 * On any other provider the gated skills are hidden from the model catalog and
 * blocked from both the `skill` loader tool and the `/name` user gesture.
 *
 * How it works
 * ------------
 * For each agent, one skill provider is registered in that agent's scoped
 * context (`agent.ctx.inject(["skills"], …)`). The shipped filesystem skills are
 * composed per agent, and the skill registry lets the NEAREST scope layer win a
 * name, so the gate must live in that same nearest layer to shadow them.
 *
 * When the session is NOT on the allowed provider, the provider reports low-rank
 * "tombstone" candidates for each existing gated skill with
 * `invocation: { modelInvocable: false, userInvocable: false }`.
 * `@deepseek-ai/dsh-tool-skill` filters on those flags for the session catalog,
 * the `skill` tool, and the `/name` gesture, so all three surfaces are gated at
 * once. On the allowed provider the provider reports nothing and the real skills
 * pass through untouched (live bodies, resource guidance, watching preserved).
 *
 * Implementation notes
 * --------------------
 * - Provider `list()`/`get()` MUST be async: the registry races them against the
 *   lookup signal via `promise.then`, so a synchronous return value is rejected
 *   and the provider is skipped (which also marks discovery incomplete).
 * - The provider NAME is unique per module generation (`qwen-gate-<suffix>`).
 *   The harness loads a fresh module generation when a linked bundle is
 *   reinstalled, but effects of the previous generation's per-agent
 *   registrations can leak (their disposers never run). With a shared name, the
 *   new generation's registration then fails with "already registered in this
 *   scope", it loses its invalidate() handle, and a later model switch cannot
 *   refresh the registry cache — the stale cache keeps serving the real skills.
 *   A unique name lets every generation register alongside any leaked ones
 *   (identical tombstone semantics, equal lowest rank), so the active generation
 *   always holds a working invalidate() handle and the gate self-heals across
 *   reinstalls. An app restart clears leaked generations entirely.
 * - The gate decision in `list()` follows the VIEWING agent (`options.scope`),
 *   not the agent the provider was registered for: the registry also consults an
 *   ancestor's provider when snapshotting a descendant's catalog, and the gate
 *   must follow the viewer's provider.
 * - The current provider is read from `agent.model.current()` (the same source
 *   the agent loop uses for a step's selection), falling back to the session's
 *   `modelSelection` projection and then the global default.
 * - The registry caches catalogs per (cwd, scope, revision); a `session/event`
 *   listener invalidates only when a session's gate state actually flips, so a
 *   mid-session model switch is reflected on the next step.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const name = "qwen-skill-gate";
export const inject = ["skills", "agents", "sessionProjections", "agentDefaultModel"];

const DEFAULT_PROVIDER = "qwen-token-plan-cn";
const DEFAULT_PREFIXES = ["qianwen"];
/** Unique per module generation; see implementation notes. */
const PROVIDER_NAME = `qwen-gate-${Math.random().toString(36).slice(2, 8)}`;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Below every default filesystem root rank (100..600) and runtime rank (250).
const GATE_RANK = 0;
const LOCKED_INVOCATION = Object.freeze({ modelInvocable: false, userInvocable: false });

export function apply(ctx, config = {}) {
  const allowedProvider =
    typeof config.provider === "string" && config.provider.length > 0 ? config.provider : DEFAULT_PROVIDER;
  const prefixes = Array.isArray(config.prefixes)
    ? config.prefixes.filter((p) => typeof p === "string" && p.length > 0)
    : DEFAULT_PREFIXES;
  const extraSkills = Array.isArray(config.skills)
    ? config.skills.filter((s) => typeof s === "string" && s.length > 0)
    : [];
  const failClosed = config.failClosed !== false;

  const matchesGate = (n) => extraSkills.includes(n) || prefixes.some((p) => n.startsWith(p));

  /** Resolve the viewing agent's current model selection, with safe fallbacks. */
  function selectionOf(agent) {
    try {
      const sel = agent?.model?.current?.();
      if (sel) return sel;
    } catch { /* fall through */ }
    try {
      const session = agent?.session;
      if (session) {
        const ms = ctx.sessionProjections.snapshot(session)?.modelSelection;
        const sel = ms?.pending ?? ms?.lastUsed;
        if (sel) return sel;
      }
    } catch { /* fall through */ }
    try {
      return ctx.agentDefaultModel.currentSelection();
    } catch { /* fall through */ }
    return undefined;
  }

  /** Whether the gated skills must be hidden for this viewing agent. */
  function gatedFor(agent) {
    const provider = selectionOf(agent)?.provider;
    if (provider === allowedProvider) return false;
    if (provider === undefined || provider === null || provider === "") return failClosed;
    return true;
  }

  /** Default filesystem roots the shipped skill provider scans (name-level). */
  function rootsFor(cwd) {
    const roots = [];
    if (typeof cwd === "string" && cwd.length > 0) {
      let project = cwd;
      for (let cur = cwd; ; ) {
        if (existsSync(join(cur, ".git"))) { project = cur; break; }
        const parent = dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      roots.push(join(project, ".dsh", "skills"), join(project, ".agents", "skills"));
    }
    const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
    const agentsHome = process.env.DSH_AGENTS_HOME || join(homedir(), ".agents");
    roots.push(join(dshHome, "skills"), join(agentsHome, "skills"));
    return roots;
  }

  /** Existing gated skill names, so we never invent phantom entries. */
  function discoverGatedNames(cwd) {
    const names = new Set();
    for (const root of rootsFor(cwd)) {
      let entries;
      try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        let n;
        if (entry.isDirectory()) {
          if (entry.name === ".system") continue;
          if (existsSync(join(root, entry.name, "SKILL.md"))) n = entry.name;
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          n = entry.name.slice(0, -3);
        }
        if (n && SKILL_NAME.test(n) && matchesGate(n)) names.add(n);
      }
    }
    for (const n of extraSkills) if (SKILL_NAME.test(n)) names.add(n);
    return [...names].sort();
  }

  const tombstone = (n) => ({
    name: n,
    description: `Locked: available only when the session model provider is ${allowedProvider}.`,
    invocation: { ...LOCKED_INVOCATION },
    source: PROVIDER_NAME,
    provider: PROVIDER_NAME,
    rank: GATE_RANK,
  });

  const lockedDefinition = (candidate) => ({
    name: candidate.name,
    description: candidate.description,
    invocation: { ...LOCKED_INVOCATION },
    source: PROVIDER_NAME,
    provider: PROVIDER_NAME,
    content:
      `This skill is locked. It is only available when the session model provider is ` +
      `"${allowedProvider}". Switch the session model to that provider to use it.`,
  });

  const controlBySession = new Map();
  const providerDisposers = new Map();
  const lastGate = new Map();

  // Resolves once the provider is registered. agent/created is serial and awaited
  // before the agent's first step, so the provider is in place before the first
  // catalog snapshot (no registration/collection race for this agent).
  function attach(agent) {
    if (providerDisposers.has(agent.id)) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      try {
        // The agent's scoped context exposes services only through inject; the
        // injected child keeps the agent's scope, so the provider lands in the
        // agent's own (nearest) layer alongside the per-agent filesystem skills.
        const stop = agent.ctx.inject(["skills"], (skillCtx) => {
          try {
            skillCtx.skills.registerProvider((control) => {
              controlBySession.set(agent.id, control);
              return {
                name: PROVIDER_NAME,
                async list(options = {}) {
                  const viewer = options.scope ?? agent;
                  if (!gatedFor(viewer)) return [];
                  return discoverGatedNames(options.cwd).map(tombstone);
                },
                async get(candidate) {
                  return lockedDefinition(candidate);
                },
              };
            });
          } catch (error) {
            ctx.logger.warn(`qwen-skill-gate: provider registration failed for agent ${agent.id}: ${String(error)}`);
          }
          done();
        });
        providerDisposers.set(agent.id, stop);
      } catch (error) {
        // Never block agent creation if registration is unavailable.
        ctx.logger.warn(`qwen-skill-gate: attach failed for agent ${agent.id}: ${String(error)}`);
        done();
      }
    });
  }
  ctx.on("agent/created", ({ agent }) => attach(agent));
  for (const agent of ctx.agents.list()) attach(agent);

  // Refresh the cached catalog when a session's gate state flips (model switch).
  ctx.on("session/event", (session, event) => {
    if (event.type !== "model/selection" && event.type !== "request/header") return;
    const gated = gatedFor(ctx.agents.get(session.id));
    const prev = lastGate.get(session.id);
    lastGate.set(session.id, gated);
    if (prev !== undefined && prev !== gated) controlBySession.get(session.id)?.invalidate();
  });

  ctx.on("agent/disposed", ({ agent }) => {
    lastGate.delete(agent.id);
    controlBySession.delete(agent.id);
    providerDisposers.delete(agent.id);
  });

  // Providers live on agent.ctx, which outlives this plugin; dispose on unload too
  // so either teardown removes them.
  ctx.effect(() => () => {
    for (const dispose of providerDisposers.values()) {
      try { dispose(); } catch { /* already disposed */ }
    }
    providerDisposers.clear();
    controlBySession.clear();
    lastGate.clear();
  });
}