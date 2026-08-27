// 冒烟测试：用假 ExtensionAPI 驱动 fs-guard factory，验证钩子行为
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const jiti = createJiti(here);
const mod = jiti(import.meta.resolve ? new URL("../src/index.ts", import.meta.url).href : "../src/index.ts");
const factory = mod.default;

const handlers = { tool_call: [], tool_result: [] };
const tools = [];
const commands = [];

const fakePi = {
  on: (ev, h) => { handlers[ev]?.push(h); },
  registerTool: (t) => tools.push(t),
  registerCommand: (n, c) => commands.push({ n, ...c }),
  sendUserMessage: () => {},
};

factory(fakePi);
console.log("✓ factory 执行成功");
console.log("✓ 钩子注册:", Object.keys(handlers).map((k) => `${k}=${handlers[k].length}`).join(", "));
console.log("✓ 工具:", tools.map((t) => t.name).join(","));
console.log("✓ 命令:", commands.map((c) => c.n).join(","));

const ctx = { cwd: "D:/PI-web-desktop/fs-guard", ui: { notify: () => {} } };
const tc = handlers.tool_call[0];
const tr = handlers.tool_result[0];
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name} ${extra}`); }
};

/* ---- ① read 拦截 ---- */
let r = await tc({ toolName: "read", input: { path: "no-such-file.md" } }, ctx);
check("read 不存在 → block", r?.block === true && r.reason.includes("不存在"), JSON.stringify(r));
r = await tc({ toolName: "read", input: { path: "package.json" } }, ctx);
check("read 存在 → 放行", r === undefined, JSON.stringify(r));
r = await tc({ toolName: "read", input: { path: "src" } }, ctx);
check("read 目录 → block", r?.block === true && r.reason.includes("目录"), JSON.stringify(r));

/* ---- ② python 改写 ---- */
const ev = { toolName: "bash", input: { command: "python -c \"print('✓')\"" } };
await tc(ev, ctx);
check("bash python → 注入 -X utf8", ev.input.command === 'python -X utf8 -c "print(\'✓\')"', ev.input.command);

/* ---- 附加: 破坏性 / git 边界 ---- */
r = await tc({ toolName: "bash", input: { command: "rm -rf node_modules" } }, ctx);
check("rm -rf → block", r?.block === true && r.reason.includes("破坏性"), JSON.stringify(r));
r = await tc({ toolName: "bash", input: { command: "git status" } }, { cwd: process.env.TEMP, ui: {} });
check("非仓库 git → block", r?.block === true && r.reason.includes("git"), JSON.stringify(r));
r = await tc({ toolName: "bash", input: { command: "rm -rf x #fsguard-allow" } }, ctx);
check("#fsguard-allow → 放行", r === undefined);

/* ---- ③④ tool_result 分类 + 防空转 ---- */
r = await tr({ toolName: "read", toolCallId: "1", input: { path: "a" }, content: [{ type: "text", text: "ENOENT: no such file or directory, access 'D:\\x\\plan.md'" }], isError: true, details: undefined }, ctx);
const joined = JSON.stringify(r);
check("错误结果 → 注入分类行", joined.includes("FILE_NOT_FOUND") && joined.includes("fs-guard"), joined.slice(0, 160));
r = await tr({ toolName: "bash", toolCallId: "2", input: { command: "python x" }, content: [{ type: "text", text: "UnicodeEncodeError: 'gbk' codec can't encode character" }], isError: true, details: undefined }, ctx);
check("GBK → 注入编码建议", JSON.stringify(r).includes("ENCODING"), JSON.stringify(r).slice(0, 160));
r = await tr({ toolName: "bash", toolCallId: "3", input: { command: "retry-me" }, content: [{ type: "text", text: "Error: boom 1" }], isError: true, details: undefined }, ctx);
r = await tr({ toolName: "bash", toolCallId: "4", input: { command: "retry-me" }, content: [{ type: "text", text: "Error: boom 2" }], isError: true, details: undefined }, ctx);
check("连续失败2次 → 防空转提醒", JSON.stringify(r).includes("连续失败"), JSON.stringify(r).slice(0, 200));
r = await tr({ toolName: "bash", toolCallId: "5", input: { command: "ok-cmd" }, content: [{ type: "text", text: "all good" }], isError: false, details: undefined }, ctx);
check("成功结果 → 不注入", r === undefined || !JSON.stringify(r).includes("fs-guard"), JSON.stringify(r));

/* ---- fs_guard 工具 ---- */
const tool = tools[0];
let out = await tool.execute("x", { action: "check", path: "package.json" }, undefined, undefined, ctx);
const j1 = out.content[0].text;
check("fs_guard check 存在", j1.includes('"exists": true'), j1.slice(0, 80));
out = await tool.execute("x", { action: "classify", text: "ENOENT: no such file" }, undefined, undefined, ctx);
check("fs_guard classify", out.content[0].text.includes("FILE_NOT_FOUND"), out.content[0].text.slice(0, 120));
out = await tool.execute("x", { action: "python", code: "print('✓ utf8 ok')" }, undefined, undefined, ctx);
const j3 = out.content[0].text;
check("fs_guard python utf8 执行", j3.includes('"exitCode": 0') && j3.includes("utf8 ok"), j3.slice(0, 200));
out = await tool.execute("x", { action: "find", fragment: "core" }, undefined, undefined, ctx);
check("fs_guard find", out.content[0].text.includes('"count"'), out.content[0].text.slice(0, 120));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
