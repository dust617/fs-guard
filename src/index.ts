/**
 * fs-guard — pi 工具运行时防护扩展（Tool Runtime Guard）。
 *
 * 四层防护（对齐 Tool Runtime Guard 方案）：
 *  ① Schema 校验层  → tool_call 钩子：read 目标不存在/为目录时直接 block 并给出候选；
 *                      bash 破坏性命令、仓库外 git 命令直接 block。
 *  ② 自动修复层    → bash 命令以 python 开头时自动注入 `-X utf8`（消灭 GBK stdout 错误）。
 *  ③ 错误分类层    → tool_result 钩子：对真实错误追加结构化单行（kind/retryable/fixable/suggestion）。
 *  ④ 防空转层      → 同一工具同一目标连续失败 ≥2 次时追加提醒，禁止盲目重试/换工具。
 *
 * 隔离原则：guard 自身异常一律 try/catch 后原样放行，绝不阻断或二次执行工具。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  isToolCallEventType,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  rewritePythonCommand,
} from "./core.ts";

/* ------------------------------------------------------------------ */
/* 统计与配置                                                           */
/* ------------------------------------------------------------------ */

interface Stats {
  version: 1;
  updatedAt: string;
  guards: Record<GuardKey, boolean>;
  counters: Record<string, number>; // "tool|kind": n
  perTool: Record<string, number>; // "tool": n
}

type GuardKey = "readBlock" | "pythonUtf8" | "gitRepo" | "destructive" | "classify" | "antiSpin";

const DEFAULT_GUARDS: Record<GuardKey, boolean> = {
  readBlock: true,
  pythonUtf8: true,
  gitRepo: true,
  destructive: true,
  classify: true,
  antiSpin: true,
};

const STATS_FILE = join(getAgentDir(), "fs-guard-stats.json");

let statsCache: Stats | null = null;

function loadStats(): Stats {
  if (statsCache) return statsCache;
  try {
    const raw = readFileSync(STATS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Stats;
    statsCache = { ...parsed, guards: { ...DEFAULT_GUARDS, ...parsed.guards } };
    return statsCache;
  } catch {
    statsCache = {
      version: 1,
      updatedAt: new Date().toISOString(),
      guards: { ...DEFAULT_GUARDS },
      counters: {},
      perTool: {},
    };
    return statsCache;
  }
}

function saveStats(): void {
  const s = loadStats();
  s.updatedAt = new Date().toISOString();
  const json = JSON.stringify(s, null, 2);
  withFileMutationQueue(STATS_FILE, async () => {
    try {
      mkdirSync(resolve(STATS_FILE, ".."), { recursive: true });
      writeFileSync(STATS_FILE, json, "utf-8");
    } catch {
      /* 统计写入失败不影响主流程 */
    }
  }).catch(() => undefined);
}

function bumpStats(tool: string, kind: string): void {
  const s = loadStats();
  const ck = `${tool}|${kind}`;
  s.counters[ck] = (s.counters[ck] ?? 0) + 1;
  s.perTool[tool] = (s.perTool[tool] ?? 0) + 1;
  saveStats();
}

/* ------------------------------------------------------------------ */
/* 防空转状态（会话级内存）                                             */
/* ------------------------------------------------------------------ */

const spinFailures = new Map<string, number>();

function spinKey(tool: string, input: unknown): string {
  let target = "";
  try {
    const obj = (input ?? {}) as Record<string, unknown>;
    target =
      typeof obj.path === "string"
        ? obj.path
        : typeof obj.command === "string"
          ? obj.command.slice(0, 80)
          : JSON.stringify(obj).slice(0, 80);
  } catch {
    target = "";
  }
  return `${tool}::${target}`;
}

function noteSuccess(tool: string, input: unknown): void {
  spinFailures.delete(spinKey(tool, input));
}

function noteFailure(tool: string, input: unknown): number {
  const k = spinKey(tool, input);
  const n = (spinFailures.get(k) ?? 0) + 1;
  spinFailures.set(k, Math.min(n, 99));
  return n;
}

/* ------------------------------------------------------------------ */
/* 工具结果文本提取                                                     */
/* ------------------------------------------------------------------ */

function contentText(content: (TextContent | ImageContent)[]): string {
  return (content || [])
    .map((c) => (typeof c === "string" ? c : (c as { text?: string }).text ?? ""))
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* 扩展入口                                                             */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI): void {
  /* ---------- ① ② 参数校验 + 自动修复（tool_call 钩子） ---------- */
  pi.on("tool_call", async (event, ctx) => {
    try {
      const guards = loadStats().guards;

      if (isToolCallEventType("read", event)) {
        const { path: p } = event.input;
        if (!p || guards.readBlock === false) return;
        const info = analyzePath(ctx.cwd, p);
        if (info.exists && info.isDir) {
          return {
            block: true,
            reason: `[fs-guard] ${p} 是目录不是文件；read 只能读文件。如需列目录请用 ls/find。`,
          };
        }
        if (!info.exists) {
          const cands = buildSuggestion(ctx.cwd, p, 5);
          const hint = cands.length
            ? `同级目录候选: ${cands.join(", ")}`
            : "同级目录无相似文件";
          return {
            block: true,
            reason: `[fs-guard] 文件不存在: ${p}。${hint}。先列出父目录确认真实路径，不要换工具瞎猜。`,
          };
        }
        return;
      }

      if (isToolCallEventType("bash", event)) {
        const cmd = event.input.command;
        if (!cmd) return;
        if (cmd.includes("#fsguard-allow")) return; // 显式放行

        if (guards.destructive) {
          const hit = detectDestructive(cmd);
          if (hit) {
            return {
              block: true,
              reason: `[fs-guard] 检测到破坏性命令（${hit.pattern}）。如确需执行，请在命令末尾加 #fsguard-allow 后重试。`,
            };
          }
        }

        if (guards.pythonUtf8 && isPythonCommand(cmd)) {
          const rewritten = rewritePythonCommand(cmd);
          if (rewritten !== cmd) event.input.command = rewritten;
        }

        if (guards.gitRepo) {
          const wd = gitWorkDir(cmd) ?? ctx.cwd;
          if (gitNeedsRepo(cmd) && !isGitRepo(wd)) {
            return {
              block: true,
              reason: `[fs-guard] 当前工作目录不是 git 仓库（${wd}）。git 操作会失败，先确认仓库位置（git rev-parse --show-toplevel）或使用 git -C <repo> 指定。`,
            };
          }
        }
        return;
      }
    } catch {
      /* guard 自身异常：原样放行，绝不阻断工具 */
    }
  });

  /* ---------- ③ ④ 错误分类 + 防空转（tool_result 钩子） ---------- */
  pi.on("tool_result", async (event) => {
    try {
      const guards = loadStats().guards;
      if (!guards.classify) return;
      const text = contentText(event.content);
      if (!text.trim()) return;
      const realError = event.isError === true || looksLikeRealError(text);
      if (!realError) {
        noteSuccess(event.toolName, event.input);
        return;
      }
      const n = noteFailure(event.toolName, event.input);
      const cls = classifyError(text);
      bumpStats(event.toolName, cls.kind);
      let hint = formatErrorLine(text);
      if (guards.antiSpin && n >= 2) {
        hint += `（连续失败 ${n} 次：先定位根因，勿盲目重试或一报错就换工具）`;
      }
      const extra: TextContent = { type: "text", text: `\n${hint}` };
      return { content: [...(event.content ?? []), extra] };
    } catch {
      /* 分类失败不影响原结果 */
    }
  });

  /* ---------- 主动诊断工具 fs_guard ---------- */
  pi.registerTool({
    name: "fs_guard",
    label: "FS Guard",
    description:
      "文件系统防护/诊断工具。action=check: 检查路径存在/大小/编码/是否被锁，文件不存在时给出同级候选；action=find: 在当前项目内按文件名片段查找（跳过 node_modules/.git/dist）；action=classify: 对一段错误文本做分类并给出修复建议；action=python: 以 UTF-8 模式执行 python 代码（无需手写 -X utf8，argv 数组调用无 shell 转义问题）。",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("check"),
        Type.Literal("find"),
        Type.Literal("classify"),
        Type.Literal("python"),
      ]),
      path: Type.Optional(Type.String({ description: "check 用：目标路径" })),
      fragment: Type.Optional(Type.String({ description: "find 用：文件名片段" })),
      text: Type.Optional(Type.String({ description: "classify 用：错误文本" })),
      code: Type.Optional(Type.String({ description: "python 用：要执行的 Python 源码" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const out: Record<string, unknown> = {};
      switch (params.action) {
        case "check": {
          const p = params.path ?? ".";
          const info = analyzePath(ctx.cwd, p);
          out.exists = info.exists;
          out.isFile = info.isFile;
          out.isDir = info.isDir;
          out.size = info.size;
          out.encoding = info.encoding;
          out.locked = info.locked;
          out.mtimeMs = info.mtimeMs;
          out.path = info.path;
          if (!info.exists) out.suggestions = buildSuggestion(ctx.cwd, p, 5);
          break;
        }
        case "find": {
          const frag = (params.fragment ?? "").toLowerCase();
          const hits: string[] = [];
          const skip = new Set(["node_modules", ".git", "dist", "build", "release", "archive", ".backup", "coverage"]);
          const walk = (dir: string, depth: number) => {
            if (hits.length >= 20 || depth > 4) return;
            let items: string[] = [];
            try {
              items = readdirSync(dir);
            } catch {
              return;
            }
            for (const it of items) {
              if (skip.has(it)) continue;
              const full = join(dir, it);
              if (frag && it.toLowerCase().includes(frag)) hits.push(full);
              let isDir = false;
              try {
                isDir = statSync(full).isDirectory();
              } catch {
                continue;
              }
              if (isDir) walk(full, depth + 1);
            }
          };
          walk(ctx.cwd, 0);
          out.hits = hits;
          out.count = hits.length;
          break;
        }
        case "classify": {
          const c = classifyError(params.text ?? "");
          out.kind = c.kind;
          out.retryable = c.retryable;
          out.modelFixable = c.modelFixable;
          out.suggestion = c.suggestion;
          break;
        }
        case "python": {
          const code = params.code ?? "";
          const { stdout, stderr, exitCode } = await runPythonUtf8(code, ctx.cwd);
          out.exitCode = exitCode;
          out.stdout = stdout.slice(0, 4000);
          out.stderr = stderr.slice(0, 2000);
          break;
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }] as TextContent[],
        details: { action: params.action },
      };
    },
  });

  /* ---------- /fs-guard 命令：查看统计与开关 ---------- */
  pi.registerCommand("fs-guard", {
    description: "查看 fs-guard 统计与防护开关；参数 reset 清空统计",
    handler: async (args, ctx) => {
      const s = loadStats();
      if (args?.trim() === "reset") {
        statsCache = {
          version: 1,
          updatedAt: new Date().toISOString(),
          guards: { ...s.guards },
          counters: {},
          perTool: {},
        };
        saveStats();
        ctx.ui.notify("fs-guard 统计已清空", "info");
        return;
      }
      const top = Object.entries(s.counters)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");
      const byTool = Object.entries(s.perTool)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");
      ctx.ui.notify(
        `fs-guard stats\n━━ 按工具 ━━\n${byTool || "  (空)"}\n\n━━ 按类别 ━━\n${top || "  (空)"}\n\n开关配置: ${STATS_FILE}\n禁用某防护: 编辑该 JSON 中 guards 对应项为 false`,
        "info",
      );
    },
  });
}

/* ------------------------------------------------------------------ */
/* python -X utf8 执行（argv 数组，无 shell）                           */
/* ------------------------------------------------------------------ */

function runPythonUtf8(code: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolvePromise) => {
    const finish = (err: unknown, stdout: string, stderr: string) => {
      if (err) {
        const e = err as { code?: number | string; message?: string };
        const exitCode = typeof e.code === "number" ? e.code : 1;
        resolvePromise({ stdout, stderr: stderr || String(e.message ?? err), exitCode });
      } else {
        resolvePromise({ stdout, stderr, exitCode: 0 });
      }
    };
    execFile(
      "python",
      ["-X", "utf8", "-c", code],
      { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => finish(err, stdout, stderr),
    );
  });
}
