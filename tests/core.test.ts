import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzePath,
  buildSuggestion,
  classifyError,
  detectDestructive,
  formatErrorLine,
  gitNeedsRepo,
  gitWorkDir,
  isGitRepo,
  isPythonCommand,
  looksLikeRealError,
  probeEncoding,
  rewritePythonCommand,
} from "../src/core.ts";

/* ---------------- classifyError ---------------- */

test("classifyError: GBK/编码", () => {
  const c = classifyError("Traceback ... UnicodeEncodeError: 'gbk' codec can't encode character '\\u2714'");
  assert.equal(c.kind, "ENCODING");
  assert.equal(c.retryable, false);
  assert.equal(c.modelFixable, true);
});

test("classifyError: ENOENT/路径", () => {
  const c = classifyError("ENOENT: no such file or directory, access 'D:\\x\\plan.md'");
  assert.equal(c.kind, "FILE_NOT_FOUND");
  assert.ok(c.suggestion.includes("路径"));
});

test("classifyError: 权限", () => {
  assert.equal(classifyError("EACCES: permission denied").kind, "PERMISSION");
});

test("classifyError: 占用/锁", () => {
  const c = classifyError("EBUSY: resource busy or locked");
  assert.equal(c.kind, "FILE_BUSY");
  assert.equal(c.retryable, true);
});

test("classifyError: 超时", () => {
  assert.equal(classifyError("Operation timed out after 120s").kind, "TIMEOUT");
});

test("classifyError: 限流 429", () => {
  const c = classifyError("HTTP 429 Too Many Requests / rate limit");
  assert.equal(c.kind, "API_RATE_LIMIT");
  assert.equal(c.retryable, true);
});

test("classifyError: git", () => {
  assert.equal(classifyError("fatal: not a git repository").kind, "GIT");
});

test("classifyError: unknown", () => {
  const c = classifyError("some weird thing happened");
  assert.equal(c.kind, "UNKNOWN");
  assert.equal(c.retryable, false);
});

test("formatErrorLine 单行紧凑", () => {
  const line = formatErrorLine("ENOENT: no such file");
  assert.ok(line.startsWith("[fs-guard] kind=FILE_NOT_FOUND"));
  assert.ok(!line.includes("\n"));
});

/* ---------------- rewritePythonCommand ---------------- */

test("rewrite: python 开头注入 -X utf8", () => {
  assert.equal(rewritePythonCommand("python script.py"), "python -X utf8 script.py");
});

test("rewrite: python3 -m pip 也注入", () => {
  assert.equal(rewritePythonCommand("python3 -m pip install x"), "python3 -X utf8 -m pip install x");
});

test("rewrite: 已带 -X 不再注入", () => {
  assert.equal(rewritePythonCommand("python -X dev a.py"), "python -X dev a.py");
});

test("rewrite: 非 python 命令不动", () => {
  assert.equal(rewritePythonCommand("echo hello | python -c 'x'"), "echo hello | python -c 'x'");
  assert.equal(rewritePythonCommand("npm run build"), "npm run build");
});

test("isPythonCommand", () => {
  assert.ok(isPythonCommand("python -c '1'"));
  assert.ok(isPythonCommand("  py script.py"));
  assert.ok(!isPythonCommand("echo python x"));
});

/* ---------------- detectDestructive ---------------- */

test("destructive: rm -rf 命中", () => {
  const h = detectDestructive("rm -rf node_modules");
  assert.ok(h && h.pattern.includes("rm"));
});

test("destructive: rm -fr 命中", () => {
  assert.ok(detectDestructive("rm -fr /d/x"));
});

test("destructive: del /s 命中", () => {
  assert.ok(detectDestructive("del /s /q D:\\x\\*"));
});

test("destructive: git reset --hard 命中", () => {
  assert.ok(detectDestructive("git reset --hard HEAD~1"));
});

test("destructive: 安全命令不命中", () => {
  assert.equal(detectDestructive("ls -la"), null);
  assert.equal(detectDestructive("npm run build"), null);
  assert.equal(detectDestructive("git status"), null);
  assert.equal(detectDestructive("git clean -n"), null); // dry-run 放行
});

test("destructive: #fsguard-allow 放行", () => {
  assert.equal(detectDestructive("rm -rf x #fsguard-allow"), null);
});

/* ---------------- analyzePath / probeEncoding ---------------- */

test("probeEncoding: BOM/utf8/gbk", () => {
  assert.equal(probeEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), "utf8-bom");
  assert.equal(probeEncoding(Buffer.from("你好", "utf8")), "utf8");
  assert.equal(probeEncoding(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])), "gbk"); // 你好 GBK
});

test("analyzePath: 文件/目录/不存在", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsg-"));
  const f = join(dir, "a.txt");
  writeFileSync(f, "hello 世界", "utf8");
  const file = analyzePath(dir, "a.txt");
  assert.equal(file.exists, true);
  assert.equal(file.isFile, true);
  assert.equal(file.encoding, "utf8");
  assert.ok(file.size > 0);
  assert.equal(analyzePath(dir, "nope.txt").exists, false);
  assert.equal(analyzePath(dir, ".").isDir, true);
  assert.equal(analyzePath(dir, "a.txt").path.includes("/"), true); // 正斜杠
});

test("buildSuggestion: 相似候选", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsg-"));
  writeFileSync(join(dir, "config.ts"), "x");
  writeFileSync(join(dir, "config.js"), "x");
  writeFileSync(join(dir, "index.ts"), "x");
  const s = buildSuggestion(dir, "config.tx");
  assert.ok(s.some((x) => x.includes("config")));
});

/* ---------------- git ---------------- */

test("isGitRepo: 向上查找", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsg-"));
  assert.equal(isGitRepo(dir), null);
  mkdirSync(join(dir, ".git"));
  assert.equal(isGitRepo(dir)?.replace(/\\/g, "/"), dir.replace(/\\/g, "/"));
  const sub = join(dir, "a", "b");
  mkdirSync(sub, { recursive: true });
  assert.ok(isGitRepo(sub) !== null);
});

test("gitWorkDir / gitNeedsRepo", () => {
  assert.equal(gitWorkDir("git status"), null);
  assert.equal(gitWorkDir("git -C D:/repo status")?.replace(/\\/g, "/"), "D:/repo");
  assert.equal(gitNeedsRepo("git clone https://x"), false);
  assert.equal(gitNeedsRepo("git init"), false);
  assert.equal(gitNeedsRepo("git status"), true);
});

/* ---------------- looksLikeRealError ---------------- */

test("looksLikeRealError: 真错误/文档排除", () => {
  assert.ok(looksLikeRealError("ENOENT: no such file or directory, access 'x'"));
  assert.ok(looksLikeRealError("Error: cannot find module 'ws'"));
  assert.ok(looksLikeRealError("fatal: not a git repository"));
  assert.ok(!looksLikeRealError("# 调研文档 讨论 error 场景"));
  assert.ok(!looksLikeRealError("plain success output"));
  assert.ok(!looksLikeRealError("---\n# heading\ncontent about errors"));
});
