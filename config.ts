import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHILD_ROLES, ROLE_LABEL, THINKING_EFFORTS } from "./types.ts";
import type { ChildConfig, ChildRole, Queue, QueueItem, RoleConfigs, ThinkingEffort } from "./types.ts";

export function asEffort(v: unknown): ThinkingEffort | undefined {
  return THINKING_EFFORTS.find((e) => e === v);
}

/**
 * Reject a malformed model/thinking block at LOAD time. A `thinking: "higher"` typo is
 * otherwise dropped in silence somewhere down in pi's model resolution, and the run looks
 * configured while every child is on the default effort.
 */
export function assertChildConfig(where: string, c: ChildConfig | undefined): void {
  if (!c) return;
  if (typeof c !== "object" || Array.isArray(c)) throw new Error(`fr-batch: ${where} model/thinking config must be an object`);
  const extra = Object.keys(c).filter((k) => k !== "model" && k !== "thinking");
  if (extra.length > 0) throw new Error(`fr-batch: ${where} has unknown field(s) ${extra.join(", ")} — only model and thinking are read here`);
  if (c.model !== undefined && (typeof c.model !== "string" || !c.model.trim())) {
    throw new Error(`fr-batch: ${where} model must be a non-empty string like "anthropic/claude-sonnet-4-5"`);
  }
  if (c.thinking !== undefined && !asEffort(c.thinking)) {
    throw new Error(`fr-batch: ${where} thinking "${String(c.thinking)}" is not a reasoning effort — use one of ${THINKING_EFFORTS.join(", ")}`);
  }
}

export function assertRoleConfigs(where: string, roles: RoleConfigs | undefined): void {
  if (roles === undefined) return;
  if (typeof roles !== "object" || roles === null || Array.isArray(roles)) throw new Error(`fr-batch: ${where} must be an object keyed by role`);
  for (const [role, cfg] of Object.entries(roles)) {
    if (!CHILD_ROLES.includes(role as ChildRole)) {
      throw new Error(`fr-batch: ${where} names role "${role}" — only ${CHILD_ROLES.join(", ")} run children`);
    }
    assertChildConfig(`${where}.${role}`, cfg);
  }
}

/**
 * Split a trailing `:<effort>` off a model id, so `"sonnet:high"` behaves exactly like
 * `{ model: "sonnet", thinking: "high" }` at that layer — and can therefore be overridden
 * field-by-field by a more specific layer instead of surviving as an opaque string.
 */
export function splitEffortSuffix(model: string | undefined): ChildConfig {
  if (!model?.trim()) return {};
  const m = model.trim();
  const at = m.lastIndexOf(":");
  const effort = at > 0 ? asEffort(m.slice(at + 1)) : undefined;
  return effort ? { model: m.slice(0, at), thinking: effort } : { model: m };
}

/** One layer, normalized: an effort in the model string is lifted into `thinking`. */
export function normalizeChildConfig(c: ChildConfig | undefined): ChildConfig {
  const fromModel = splitEffortSuffix(c?.model);
  const thinking = asEffort(c?.thinking) ?? fromModel.thinking;
  // `"inherit"` is pi's own sentinel for "use the parent's model" (model-fallback.ts
  // INHERIT_MODEL). Here it means "this layer sets no model", so the next layer down
  // supplies one — which is what makes `{ model: "inherit", thinking: "high" }` a legal way
  // to raise the effort without naming a model. Passing it through instead would send
  // `inherit:high`, which no longer matches the sentinel and fails the registry lookup.
  const model = fromModel.model && fromModel.model.toLowerCase() !== "inherit" ? fromModel.model : undefined;
  return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}

export function resolveChildConfig(q: Queue, item: QueueItem, role: ChildRole, session: ChildConfig): ChildConfig {
  const layers = [
    item.roles?.[role],
    { model: item.model, thinking: item.thinking },
    q.roles?.[role],
    { model: q.defaultModel, thinking: q.defaultThinking },
    session,
  ].map(normalizeChildConfig);
  const model = layers.find((l) => l.model)?.model;
  const thinking = layers.find((l) => l.thinking)?.thinking;
  return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}

/**
 * The supervising conversation's own model and effort, read once when a run starts.
 *
 * `ctx.model` / `ctx.thinkingLevel` are the authority; the PI_* env vars are the fallback
 * for a session runtime that exposes neither (they are set for every pi process).
 */
export function sessionChildConfig(ctx: ExtensionContext): ChildConfig {
  const m = ctx.model as { provider?: string; id?: string } | undefined;
  const model =
    m?.provider && m?.id
      ? `${m.provider}/${m.id}`
      : process.env.PI_PROVIDER && process.env.PI_MODEL
        ? `${process.env.PI_PROVIDER}/${process.env.PI_MODEL}`
        : undefined;
  const thinking = asEffort(ctx.thinkingLevel) ?? asEffort(process.env.PI_REASONING_LEVEL);
  return normalizeChildConfig({ ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) });
}

/**
 * The spawn params that carry model + effort to one child.
 *
 * THE EFFORT RIDES ON THE MODEL STRING. pi-subagents' spawn RPC has no `thinking` param
 * (schemas.ts exposes it for watchdog.configure only); the supported channel is the
 * `provider/id:<effort>` suffix, which pi resolves around (model-fallback.ts
 * resolveSubagentModelCandidate splits the suffix, resolves the base id, reattaches it)
 * and preserves (pi-args.ts applyThinkingSuffix keeps an existing suffix). So an effort
 * without a model cannot be delivered at all — hence `modelUnresolved` below, which the
 * caller reports rather than dropping the setting in silence.
 */
export function childSpawnParams(cfg: ChildConfig): { model?: string } {
  if (!cfg.model) return {};
  return { model: cfg.thinking ? `${cfg.model}:${cfg.thinking}` : cfg.model };
}

/** True when an effort was configured but no model resolved, so the effort cannot be sent. */
export function effortUndeliverable(cfg: ChildConfig): boolean {
  return Boolean(cfg.thinking && !cfg.model);
}

/** `claude-sonnet-4-5:high` — the provider prefix dropped, since status lines are narrow. */
export function modelLabel(cfg: ChildConfig): string {
  if (!cfg.model) return cfg.thinking ? `inherit (thinking:${cfg.thinking} NOT applied — no model resolved)` : "inherit";
  const short = cfg.model.split("/").pop() ?? cfg.model;
  return cfg.thinking ? `${short}:${cfg.thinking}` : short;
}

/** One label for an item, collapsed to a single value when all three roles agree. */
export function itemModelLabel(q: Queue, item: QueueItem, session: ChildConfig): string {
  const per = CHILD_ROLES.map((r) => [r, modelLabel(resolveChildConfig(q, item, r, session))] as const);
  return new Set(per.map(([, l]) => l)).size === 1 ? per[0][1] : per.map(([r, l]) => `${ROLE_LABEL[r]}=${l}`).join(" ");
}
