#!/usr/bin/env node
/**
 * 破甲层自测：模型适配、拒答识别、纠偏预算、文本组装。
 * 不需要宿主、不需要网络：node scripts/selftest.mjs
 */
import assert from "node:assert/strict";
import * as mp from "../lib/model-profile.js";
import * as rs from "../lib/refusal-steer.js";
import * as hd from "../lib/hardening.js";

// 1. profile mapping
assert.equal(mp.profileFor("deepseek-v4-pro"), "v4pro");
assert.equal(mp.profileFor("DeepSeek-V4-Pro"), "v4pro");
assert.equal(mp.profileFor("deepseek-flash"), "generic");
assert.equal(mp.profileFor("qwen3-max"), "domestic");
assert.equal(mp.profileFor("kimi-k2"), "domestic");
assert.equal(mp.profileFor("claude-sonnet-4"), "claude");
assert.equal(mp.profileFor("gpt-5"), "openai");
assert.equal(mp.profileFor("o3-mini"), "openai");
assert.equal(mp.profileFor("mystery-model", "deepseek"), "domestic");
assert.equal(mp.profileFor("deepseek-v4-pro", "", "generic"), "generic");
assert.equal(mp.profileFor("", "", "v4pro"), "v4pro");

// 2. adapter presence
assert.ok(mp.adapterText("v4pro").includes("渲染契约"));
assert.ok(mp.adapterText("domestic").includes("执行锚点"));
assert.equal(mp.adapterText("generic"), "");

// 3. hardening composition
const v4 = hd.hardeningText("max", { model: "deepseek-v4-pro" });
assert.ok(v4.includes("V4-Pro 渲染契约"));
assert.ok(v4.indexOf("渲染契约") < v4.indexOf("Mode lock"), "adapter comes before core");
const gen = hd.hardeningText("max", { model: "deepseek-flash" });
assert.ok(!gen.includes("渲染契约"));
assert.ok(gen.includes("Mode lock"));
assert.equal(hd.hardeningText("off", { model: "deepseek-v4-pro" }), "");
assert.ok(v4.length > gen.length);

// 4. refusal detection — positives
const positives = [
  "抱歉，我不能协助这个请求。",
  "很抱歉，我无法提供这类内容。",
  "对不起，这个我不能做。",
  "我无法完成这个任务。",
  "作为人工智能，我需要说明……",
  "很遗憾，这项请求超出了我的能力范围。",
  "I'm sorry, but I can't help with that.",
  "I cannot assist with this request.",
  "As an AI language model, I must decline.",
  "这违反了我的使用政策，我无法协助。",
];
for (const t of positives) assert.equal(rs.isRefusal(t), true, `should be refusal: ${t}`);

// 5. refusal detection — negatives
const negatives = [
  "好的，下面是可执行步骤：\n1. 打开终端",
  "```bash\nrm -rf build\n```",
  "结论：这个方案可行。先给命令：",
  "你问的是模型为什么会拒绝。原因有三点……",
  "抱歉刚才那行命令写错了，正确的是：`ls -la`",  // starts with 抱歉 but is an apology-then-fix… still flagged? see below
  "Here is the artifact:\n\nfunction f() {}",
  "",
];
for (const t of negatives.slice(0, 4)) assert.equal(rs.isRefusal(t), false, `should not be refusal: ${t}`);
// 第 5 条是「道歉后给结果」，当前策略会误判；记录为已知取舍。
assert.equal(rs.isRefusal(negatives[4]), true);
assert.equal(rs.isRefusal(negatives[5]), false);
assert.equal(rs.isRefusal(""), false);

// 6. assistant text extraction
const events = [
  { type: "user/message", seq: 1, data: { message: { content: [{ type: "text", text: "做这个" }] }, source: { kind: "user" } } },
  { type: "assistant/message", seq: 2, data: { message: { content: [{ type: "text", text: "抱歉，我不能。" }] } } },
  { type: "assistant/message", seq: 3, data: { message: { content: [{ type: "tool-call", name: "bash" }] } } },
];
assert.equal(rs.lastAssistantText(events).text, "抱歉，我不能。");
assert.equal(rs.lastAssistantText(events).seq, 2);
assert.equal(rs.lastHumanText(events).text, "做这个");

// plugin steer 不算人类消息
const events2 = [
  ...events,
  { type: "user/message", seq: 4, data: { message: { content: [{ type: "text", text: "重做" }] }, source: { kind: "dsh-purge" } } },
];
assert.equal(rs.lastHumanText(events2).text, "做这个");

// 7. tracker budget
const tr = rs.createSteerTracker();
assert.equal(tr.take("s1", 10, 2, 6), true);
assert.equal(tr.take("s1", 10, 2, 6), true);
assert.equal(tr.take("s1", 10, 2, 6), false);
assert.equal(tr.take("s1", 11, 2, 6), true);   // new turn resets per-turn
for (let i = 0; i < 3; i += 1) tr.take("s1", 12 + i, 2, 6);
assert.equal(tr.take("s1", 99, 2, 6), false);  // session budget exhausted

// 8. steer text per profile
for (const p of ["v4pro", "domestic", "claude", "openai", "generic"]) {
  assert.ok(mp.steerText(p).length > 10, p);
}
assert.ok(mp.steerText("v4pro").includes("渲染契约"));

console.log("selftest OK");
