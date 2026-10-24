#!/usr/bin/env node
/**
 * 校验当前解包目录里每条补丁的锚点是否还在。
 *
 *   DSH_BASE=/Applications/DeepSeek\ Harness.app/Contents/Resources/app \
 *     node scripts/verify-patches.mjs
 *   # 或
 *   node scripts/verify-patches.mjs --base <resources/app>
 *
 * 只读：不写文件、不留备份。pending = 锚点存在但还没打；missing_file = 这一端没有那个包。
 * 退出码 1 表示有非可选补丁处于 pending（官方升级后最需要先跑这条）。
 */
import * as core from "../lib/core.js";

const args = process.argv.slice(2);
const baseArg = args.find((a) => a.startsWith("--base="))?.split("=").slice(1).join("=")
  || args[args.indexOf("--base") + 1]
  || process.env.DSH_BASE
  || "";

if (!baseArg) {
  console.error("用法 / usage: node scripts/verify-patches.mjs --base <resources/app>（或设置 DSH_BASE）");
  process.exit(2);
}

let status;
try {
  status = await core.patchStatus(baseArg);
} catch (e) {
  console.error(`[ERROR] 读不到 ${baseArg}: ${String(e?.message || e)}`);
  process.exit(2);
}

const rows = core.ALL_PATCHES.map((p) => ({ p, s: status[p.id] || "unknown" }));
const tally = {};
for (const { s } of rows) tally[s] = (tally[s] || 0) + 1;

console.log(`base: ${baseArg}`);
console.log(`patches: ${core.ALL_PATCHES.length}`);
console.log(Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(", "));

const pending = rows.filter(({ p, s }) => s === "pending" && !p.optional);
for (const { p, s } of pending) {
  console.log(`  ✗ pending  #${p.id} ${p.name} → ${[].concat(p.file).join(", ")}`);
}

const missing = rows.filter(({ p, s }) => s === "missing_file" && !p.optional);
if (missing.length) {
  console.log(`  可选缺失 / missing files: ${missing.length}（这一端没有对应包，正常）`);
}

if (pending.length) {
  console.log(`\n有 ${pending.length} 条补丁的锚点还在但未应用：先 --apply，再重启 dsh。`);
  process.exit(1);
}
console.log("\n全部可应用补丁已落盘或本端不需要 / all applicable patches settled.");
