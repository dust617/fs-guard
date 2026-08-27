/**
 * fs-guard 核心纯逻辑：错误分类 / 路径分析 / 编码探测 / 命令改写 / 破坏性检测。
 *
 * 设计原则（源自 Tool Runtime Guard 方案）：
 * - 本模块不依赖 pi API，可被 CLI 或其它 agent harness 直接复用。
 * - 所有判定都基于“机器可理解错误”（kind / retryable / modelFixable / suggestion）。
 * - 非幂等操作绝不自动重试；未知错误先看根因，不盲目重试或换工具。
 */
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";

/* ------------------------------------------------------------------ */
/* 错误分类                                                             */
/* ------------------------------------------------------------------ */

export type ErrorKind =
  | "FILE_NOT_FOUND"
  | "ENCODING"
  | "PERMISSION"
  | "FILE_BUSY"
  | "INVALID_ARG"
  | "TIMEOUT"
  | "API_ERROR"
  | "API_RATE_LIMIT"
  | "GIT"
  | "STALE_EDIT"
  | "TOO_LARGE"
  | "MODULE"
  | "COMMAND"
  | "INTERRUPTED"
  | "UNKNOWN";

export interface ErrorClass {
  kind: ErrorKind;
  /** 瞬时/退避型错误：代码层可安全自动重试 */
  retryable: boolean;
  /** 模型修正参数或动作后可自愈 */
  modelFixable: boolean;
  /** 一句话修复建议（注入给模型） */
  suggestion: string;
}

interface Rule {
  kind: ErrorKind;
  re: RegExp;
  retryable: boolean;
  fixable: boolean;
  suggestion: string;
}

/** 顺序即优先级，命中第一个即返回。对文本前 800 字符（小写）做匹配。 */
const RULES: Rule[] = [
  {
    kind: "ENCODING",
    re: /gbk|cp936|unicodeencodeerror|unicode decode error|codec can'?t encode|codec can'?t decode|illegal multibyte|invalid.*byte sequence/,
    retryable: false,
    fixable: true,
    suggestion: "编码问题：python 用 `-X utf8`（或 PYTHONIOENCODING=utf-8）重跑；已有文件保留原编码/BOM/换行，勿强制转码",
  },
  {
    kind: "FILE_NOT_FOUND",
    re: /enoent|enotdir|no such file|not a directory|file not found|path not found|cannot find|not found|找不到|不存在|没有此文件/,
    retryable: false,
    fixable: true,
    suggestion: "路径不存在：先列出父目录确认真实路径（ls / find），不要换工具瞎猜",
  },
  {
    kind: "PERMISSION",
    re: /eacces|eperm|permission denied|access is denied|access denied|denied|拒绝访问|没有权限|read-?only|只读/,
    retryable: false,
    fixable: false,
    suggestion: "权限/只读：检查文件属性与占用进程；权限错误不要自动重试",
  },
  {
    kind: "FILE_BUSY",
    re: /ebusy|eexist|being used by another|used by another process|another process|locked|占用|另一个进程/,
    retryable: true,
    fixable: false,
    suggestion: "文件被占用/锁定：短暂等待后重试一次；仍失败则查找占用进程（如杀毒/同步盘/打包器）",
  },
  {
    kind: "TIMEOUT",
    re: /timeout|timed out|超时/,
    retryable: true,
    fixable: true,
    suggestion: "超时：加大 timeout，或缩小操作范围（大文件只读行段/用统计工具聚合）",
  },
  {
    kind: "API_RATE_LIMIT",
    re: /\b429\b|rate limit|insufficient_quota|\bquota\b|额度|配额/,
    retryable: true,
    fixable: false,
    suggestion: "限流/额度：退避等待后重试，勿高频连打",
  },
  {
    kind: "API_ERROR",
    re: /\b50[0-9]\b|\beconnrefused\b|\beconnreset\b|fetch failed|connection (error|refused|reset)|getaddrinfo|network error|tcp connectivity/,
    retryable: true,
    fixable: false,
    suggestion: "服务端/网络瞬时错误：退避重试，或先检查网络与隧道",
  },
  {
    kind: "STALE_EDIT",
    re: /patch.*(fail|mismatch|context)|context.*mismatch|does not match|stale edit|out of date/,
    retryable: false,
    fixable: true,
    suggestion: "编辑上下文过期：重新读取文件后再编辑，防止覆盖他人改动",
  },
  {
    kind: "GIT",
    re: /fatal:|not a git repository|outside repository|refusing to merge|unable to access.*git/,
    retryable: false,
    fixable: true,
    suggestion: "git 边界问题：先确认在仓库内（git rev-parse --show-toplevel），仓库外目标用绝对路径",
  },
  {
    kind: "TOO_LARGE",
    re: /too long|too large|exceeds?.*(limit|size)|truncat|argument list too long|output.*exceed/,
    retryable: false,
    fixable: true,
    suggestion: "输出/文件过大：缩小范围（只读行段、分批、用沙箱统计），不要整读大文件",
  },
  {
    kind: "MODULE",
    re: /cannot find module|cannot find package|module not found|npm err|npm error|erresolve|etarget|ebadplatform/,
    retryable: false,
    fixable: false,
    suggestion: "依赖缺失/环境问题：检查 npm install 与模块路径（项目自带的 node_modules）",
  },
  {
    kind: "COMMAND",
    re: /not recognized|command not found|不是内部或外部命令|无效语法|invalid syntax|syntaxerror|usage:|无效参数/,
    retryable: false,
    fixable: true,
    suggestion: "命令写法错误：检查 Windows 命令、引号/转义、参数顺序；复杂逻辑写成文件再执行",
  },
  {
    kind: "INTERRUPTED",
    re: /\babort\b|interrupted|canceled|cancelled|killed|terminated|signal|已终止|被中断/,
    retryable: false,
    fixable: false,
    suggestion: "命令被中断：先确认中断原因（用户停止/资源耗尽/会话切换）再决定是否重跑",
  },
  {
    kind: "INVALID_ARG",
    re: /\beinval\b|invalid argument|invalid pattern|illegal|非法参数|invalid value/,
    retryable: false,
    fixable: true,
    suggestion: "参数非法：修正路径/正则/模式后重调",
  },
];

const UNKNOWN: ErrorClass = {
  kind: "UNKNOWN",
  retryable: false,
  modelFixable: true,
  suggestion: "先读完整错误定位根因；不要盲目重试或一报错就换工具",
};

/** 对错误文本做分类。未命中任何规则返回 UNKNOWN。 */
export function classifyError(text: string): ErrorClass {
  const head = (text || "").slice(0, 800).toLowerCase();
  for (const r of RULES) {
    if (r.re.test(head)) {
      return {
        kind: r.kind,
        retryable: r.retryable,
        modelFixable: r.fixable,
        suggestion: r.suggestion,
      };
    }
  }
  return UNKNOWN;
}

/** 紧凑的单行结构化错误，注入工具结果，模型一眼可读。 */
export function formatErrorLine(text: string): string {
  const c = classifyError(text);
  return `[fs-guard] kind=${c.kind} retryable=${c.retryable} fixable=${c.modelFixable} → ${c.suggestion}`;
}

/* ------------------------------------------------------------------ */
/* 路径分析 / 编码探测                                                  */
/* ------------------------------------------------------------------ */

export interface PathInfo {
  /** 绝对路径，正斜杠形式（Windows 亦可用） */
  path: string;
  exists: boolean;
  isFile: boolean;
  isDir: boolean;
  size: number;
  /** "" | "utf8" | "utf8-bom" | "utf16le" | "utf16be" | "gbk" | "binary" */
  encoding: string;
  /** 是否被其它进程锁定（Windows 常见） */
  locked: boolean;
  mtimeMs: number;
}

/** 探测文本编码：BOM 优先，其次 utf8 严格解码，再退 gbk，最后 binary。 */
export function probeEncoding(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return "utf8-bom";
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return "utf16le";
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return "utf16be";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return "utf8";
  } catch {
    /* not utf8 */
  }
  try {
    new TextDecoder("gbk", { fatal: true }).decode(buf);
    return "gbk";
  } catch {
    /* not gbk either */
  }
  return "binary";
}

/**
 * 分析路径：存在性/类型/大小/编码/锁定。guard 自身异常一律吞掉返回宽松结果，
 * 绝不因 guard 失败而影响正常工具流程。
 */
export function analyzePath(cwd: string, p: string): PathInfo {
  const abs = resolveHome(cwd, p);
  const base: PathInfo = {
    path: abs.replace(/\\/g, "/"),
    exists: false,
    isFile: false,
    isDir: false,
    size: 0,
    encoding: "",
    locked: false,
    mtimeMs: 0,
  };
  try {
    const st = statSync(abs);
    base.exists = true;
    base.isDir = st.isDirectory();
    base.isFile = st.isFile();
    base.size = st.size;
    base.mtimeMs = st.mtimeMs;
    if (base.isFile && st.size > 0) {
      try {
        const fd = openSync(abs, "r");
        const buf = Buffer.alloc(Math.min(4096, st.size));
        readSync(fd, buf, 0, buf.length, 0);
        closeSync(fd);
        base.encoding = probeEncoding(buf);
      } catch {
        /* 读不到就跳过编码探测 */
      }
      try {
        // 以读写方式打开，探测是否被锁（Windows EBUSY/EPERM）
        const fd = openSync(abs, "r+");
        closeSync(fd);
      } catch {
        base.locked = true;
      }
    }
  } catch {
    /* 忽略 stat 异常 */
  }
  return base;
}

/** 展开用户主目录（~ / ~\\user），其余与 path.resolve 一致。 */
export function resolveHome(cwd: string, p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return resolve(cwd, p);
}

/** 读取父目录，返回与目标最相似的候选文件名（供“文件不存在”时提示）。 */
export function buildSuggestion(cwd: string, needle: string, limit = 5): string[] {
  let dir = dirname(resolveHome(cwd, needle));
  const base = basename(needle).toLowerCase();
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    dir = cwd;
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
  }
  const ext = extname(base);
  const scored = entries
    .map((e) => {
      let score = 0;
      const l = e.toLowerCase();
      if (base && l.includes(base)) score += 3;
      if (base && l.length >= 3 && base.includes(l)) score += 2;
      if (ext && l.endsWith(ext)) score += 1;
      return { e, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e);
  return scored.length > 0 ? scored : entries.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* 命令改写 / 仓库边界 / 破坏性命令                                      */
/* ------------------------------------------------------------------ */

/** 仅当命令以解释器开头且未带 -X 时，插入 -X utf8（消灭 GBK stdout 错误）。支持 py/python/python3.x。 */
export function rewritePythonCommand(cmd: string): string {
  const m = /^(\s*)(py|python\d{0,2}(\.\d{1,2})?)(\s+|$)/.exec(cmd);
  if (!m) return cmd;
  if (/(?:^|\s)-X\b/.test(cmd)) return cmd;
  const rest = cmd.slice(m[0].length);
  return rest ? `${m[1]}${m[2]} -X utf8 ${rest}` : `${m[1]}${m[2]} -X utf8`;
}

/** 判断命令是否以 python 解释器开头。 */
export function isPythonCommand(cmd: string): boolean {
  return /^(\s*)(py|python\d{0,2}(\.\d{1,2})?)(\s+|$)/.test(cmd);
}

/** 从 dir 向上查找 .git，返回仓库根目录；找不到返回 null。 */
export function isGitRepo(dir: string): string | null {
  let cur = resolve(dir);
  for (let i = 0; i < 12; i++) {
    if (existsSync(`${cur}/.git`)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/** 命令首词为 git 时提取其工作目录（支持 git -C <dir>），否则 null。 */
export function gitWorkDir(cmd: string): string | null {
  const m = /^\s*git(\s+-C\s+([^\s;|&]+))?/.exec(cmd);
  if (!m) return null;
  return m[2] ? resolve(m[2]) : null;
}

/** git 命令中无需仓库上下文的子命令（clone/init/config --global/--version 等）。注意 -C 不算豁免，它只是指定另一目录，仍需要仓库检查。 */
export function gitNeedsRepo(cmd: string): boolean {
  if (/^\s*git\s+(clone|init|config\s+--global|--version)\b/.test(cmd)) return false;
  return true;
}

export interface DestructiveMatch {
  pattern: string;
  detail: string;
}

/** 破坏性命令检测。命令中含 #fsguard-allow 时返回 null（显式放行）。
 * 为避免误拦（如 echo 输出文本里提到 rm -rf），命令词必须位于行首或分隔符（;|&）后。 */
export function detectDestructive(cmd: string): DestructiveMatch | null {
  if (cmd.includes("#fsguard-allow")) return null;
  const plain = cmd.replace(/["'`][^"'`\n]*["'`]/g, " "); // 剥离引号区域，避免 echo/node -e 内文本误拦
  const atCmd = "(?:^|[;|&]\\s*)";
  const rules: Array<{ pattern: string; re: RegExp }> = [
    { pattern: "rm -rf", re: new RegExp(atCmd + "rm\\b[^;|&]*\\s-[a-z]*r[a-z]*f\\b", "i") },
    { pattern: "rm -fr", re: new RegExp(atCmd + "rm\\b[^;|&]*\\s-[a-z]*f[a-z]*r\\b", "i") },
    { pattern: "del /s", re: new RegExp(atCmd + "del\\b[^;|&]*\\/s\\b", "i") },
    { pattern: "rmdir/rd /s", re: new RegExp(atCmd + "(?:rmdir|rd)\\b[^;|&]*\\/s\\b", "i") },
    { pattern: "Remove-Item -Recurse/-Force", re: new RegExp(atCmd + "Remove-Item\\b[^;|&]*-(?:Recurse|Force)\\b", "i") },
    { pattern: "rm -Recurse", re: new RegExp(atCmd + "rm\\b[^;|&]*-(?:Recurse|Force)\\b", "i") },
    { pattern: "find -exec rm", re: /\bfind\b[^;|&]*(?:^|\s)-exec\b[^;|&]*\brm\b/i },
    { pattern: "format", re: /\bformat\b\s+[a-zA-Z]:/i },
    { pattern: "taskkill /f", re: new RegExp(atCmd + "taskkill\\b[^;|&]*\\/f\\b", "i") },
    { pattern: "git clean -f", re: new RegExp(atCmd + "git\\s+clean\\s+-[a-z]*f", "i") },
    { pattern: "git reset --hard", re: new RegExp(atCmd + "git\\s+reset\\s+--hard\\b") },
    { pattern: "Windows 设备名删除", re: new RegExp(atCmd + "(?:del|rm|remove)\\b[^;|&]*\\b(nul|con|prn|aux)\\b", "i") },
    { pattern: "磁盘/分区工具", re: /\b(?:diskpart|mkfs\.\w+|dd\b[^;|&]*\bof=)/i },
  ];
  for (const r of rules) {
    if (r.re.test(plain)) {
      return { pattern: r.pattern, detail: cmd.slice(0, 120) };
    }
  }
  return null;
}

/** 结果文本是否“看起来像真实错误”（严格：开头即错误特征，排除文档/数据误报）。 */
const CMD_PREFIX = ["ls", "cat", "cp", "mv", "mkdir", "rm", "find", "grep", "sed", "awk", "bash", "node", "npm", "python", "python3", "py", "git", "tar", "unzip", "curl", "wget", "docker", "psql", "npx", "yarn", "pnpm", "tsc", "cmd", "powershell", "reg"];
const REAL_ERROR_HEAD = new RegExp(
  "^(?:\\s*)(?:" + CMD_PREFIX.join("|") + "):\\s*(?:cannot|cannot|No such|not (?:found|a|recognized)|is not|denied|无效|不是|找不到|拒绝)|" +
    "^(?:\\s*)(?:enoent|eacces|ebusy|eperm|einval|enotdir|error|failed|fatal|traceback|exception|permissionerror|filenotfounderror|timeouterror|path not found|错误[:\\s]|无法|失败|zsh:|bash:|command not found|未找到命令|不是内部或外部命令|npm err|npm error|mcp error|node:internal|internal\\/modules|cannot find module|cannot access|access is denied|invalid|denied|timeout|too (?:long|large)|argument list too long|\\(\\s*exit code)",
  "i",
);
export function looksLikeRealError(text: string): boolean {
  const head = (text || "").slice(0, 260);
  if (/^(?:\s*)(?:#+|\/\/+|\/\*+|<!--|\{|\||-{3,})/.test(head)) return false; // 文档/数据开头
  return REAL_ERROR_HEAD.test(head);
}
