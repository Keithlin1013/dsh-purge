/**
 * 拒答纠偏 / refusal steering.
 *
 * 有些模型（尤其 deepseek-v4-pro）不是“不会做”，而是先给一句抱歉/我无法，
 * 然后整轮就停在那里。这一层在轮次结束后读最后一条 assistant 文本：
 * 命中拒答开头就作为操作者补一条纠偏消息（`agent.followup`），让同一会话继续跑。
 *
 * 边界：
 *   - 只读会话事件，不改写历史；
 *   - 每轮最多 2 次、每会话最多 6 次，冷却 800ms，避免死循环；
 *   - 用户明确在问“为什么模型会拒绝 / 拒答原理”时完全不介入；
 *   - 关闭方式：`refusalSteer: false`，或 `refusalSteerMax: 0`。
 */
import { randomUUID } from "node:crypto";
import { inboxBusy, lastTurnEnd, sessionEventsOf } from "./continue-retry.js";

export const DEFAULT_REFUSAL_STEER = Object.freeze({
  refusalSteer: true,
  refusalSteerMax: 2,
  refusalSteerSessionMax: 6,
});

/** 开头 240 字内的拒答/软拒句式。只认强信号，避免把正文里的引用当成拒答。 */
const REFUSAL_PATTERNS = [
  /^(?:很|非常|十分)?抱歉/,
  /^对不起/,
  /^很遗憾/,
  /^我(?:无法|不能|不可以|没法|没办法)(?:帮|提供|完成|协助|满足|回答|继续|参与|给出)?/,
  /^(?:作为|身为)(?:一个|一名|一位)?\s*(?:AI|人工智能|语言模型|智能助手)/i,
  /^\s*I(?:'m| am)\s+(?:sorry|unable|not able|afraid)/i,
  /^\s*I\s+(?:can(?:no|')t|cannot|won't|will not|must decline|have to decline)/i,
  /^\s*(?:As an AI|I apologize|Unfortunately, I)/i,
  /^(?:这|该|此)(?:个|项|类)?(?:请求|要求|任务|内容).{0,12}(?:超出|违反|不符合|无法|不在)/,
  /^(?:这|该|此).{0,10}(?:违反|不符合|超出).{0,6}(?:政策|规定|准则|范围|能力|安全)/,
];

/** 用户在问“拒绝本身”的时候不要纠偏。 */
const META_ASK = new RegExp(
  "(?:拒绝|拒答|refusal|jailbreak|越狱|破甲|审查|安全对齐|对齐).{0,24}(?:分析|研究|原理|检测|为什么|评测|测试)"
  + "|(?:分析|研究|原理|检测|评测|测试).{0,24}(?:拒绝|拒答|refusal|对齐)",
  "i",
);

export function isRefusal(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (raw.startsWith("```")) return false;
  const head = raw.slice(0, 240).replace(/^[#>*\-\s]+/, "");
  return REFUSAL_PATTERNS.some((re) => re.test(head));
}

function textOfMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function lastAssistantText(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    if (event?.type !== "assistant/message") continue;
    const text = textOfMessage(event.data?.message);
    if (text) return { text, seq: event.seq || 0 };
  }
  return null;
}

/** 最后一条“人”发的消息；插件自己发的纠偏/续跑不算。 */
export function lastHumanText(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    if (event?.type !== "user/message") continue;
    const kind = event.data?.source?.kind;
    if (kind === "plugin" || kind === "dsh-purge") continue;
    const text = textOfMessage(event.data?.message);
    if (text) return { text, seq: event.seq || 0 };
  }
  return null;
}

export function makeSteerMessage(text) {
  return {
    id: `dsh-purge-steer-${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text: String(text || "").trim() }],
    source: {
      kind: "dsh-purge",
      form: "notice",
      summary: "steer",
    },
  };
}

export function createSteerTracker() {
  const bySession = new Map();
  return {
    take(sessionId, turnSeq, perTurnMax, sessionMax) {
      const id = String(sessionId || "");
      if (!id || perTurnMax <= 0 || sessionMax <= 0) return false;
      const cur = bySession.get(id) || { turn: 0, turnCount: 0, total: 0 };
      if (cur.turn !== turnSeq) {
        cur.turn = turnSeq;
        cur.turnCount = 0;
      }
      if (cur.turnCount >= perTurnMax || cur.total >= sessionMax) {
        bySession.set(id, cur);
        return false;
      }
      cur.turnCount += 1;
      cur.total += 1;
      bySession.set(id, cur);
      return true;
    },
    reset(sessionId) {
      bySession.delete(String(sessionId || ""));
    },
    get(sessionId) {
      return bySession.get(String(sessionId || "")) || null;
    },
  };
}

/**
 * @param ctx cordis 上下文
 * @param {object} options
 * @param {() => object} options.getConfig 返回 { refusalSteer, refusalSteerMax, refusalSteerSessionMax }
 * @param {(agent: any) => string} [options.steerTextFor] 按 agent 选纠偏句
 */
export function installRefusalSteer(ctx, options = {}) {
  if (typeof ctx?.on !== "function") return { dispose() {} };
  const getConfig = typeof options.getConfig === "function" ? options.getConfig : () => ({});
  const tracker = options.tracker || createSteerTracker();
  const timers = new Set();
  const cooldown = new Map();

  function sessionIdOf(agent) {
    return agent?.id || agent?.session?.id || "";
  }

  function schedule(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  }

  function run(agent) {
    const cfg = { ...DEFAULT_REFUSAL_STEER, ...(getConfig() || {}) };
    if (cfg.refusalSteer === false) return;
    const id = sessionIdOf(agent);
    if (!id) return;
    if (agent.status === "running" || inboxBusy(agent)) return;

    const now = Date.now();
    if (now - (cooldown.get(id) || 0) < 800) return;

    const events = sessionEventsOf(agent);
    const end = lastTurnEnd(events);
    // 只处理正常完成的轮次：传输错误交给 continue-retry，动手改写的交给 rewind。
    if (!end || end.data?.reason?.kind !== "completed") return;

    const last = lastAssistantText(events);
    if (!last) return;
    if (!isRefusal(last.text)) return;

    const human = lastHumanText(events);
    if (human && META_ASK.test(human.text.slice(0, 400))) return;

    const perTurn = Number(cfg.refusalSteerMax);
    const sessionMax = Number(cfg.refusalSteerSessionMax);
    if (!tracker.take(id, last.seq, perTurn, sessionMax)) return;

    const text = typeof options.steerTextFor === "function"
      ? options.steerTextFor(agent)
      : "";
    if (!text) return;
    try {
      agent.followup(makeSteerMessage(text));
      cooldown.set(id, now);
    } catch (e) {
      console.warn("[dsh-purge] refusal steer failed:", String(e?.message || e));
    }
  }

  const off = ctx.on("agent/status", (payload) => {
    const agent = payload?.agent;
    if (!agent || payload?.status !== "idle") return;
    schedule(() => {
      try { run(agent); } catch (e) { console.warn("[dsh-purge] steer error:", String(e?.message || e)); }
    }, 420);
  }, { global: true });

  return {
    tracker,
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      cooldown.clear();
      try { off?.(); } catch { /* ignore */ }
    },
  };
}
