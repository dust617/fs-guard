# fs-guard 设计文档

## 1. 背景与目标

用户在使用 pi（Windows 桌面版）时频繁遇到：
- 各种读写错误（文件不存在、编码、权限、文件被占用）
- 「沙箱问题」后换工具重试（bash → ctx_execute → python），每换一次重踩同样环境坑
- 模型层面对错误的无效重试循环

目标：**让读写少出错**，通过运行时自动防护而非提示词约束，并把方案沉淀为可复用的工具（pi 扩展 + 未来 CLI）。

## 2. 实测数据（本机 2026-08 会话转录扫描）

104 个会话文件，严格判定（结果文本开头即错误特征）188 次真实工具失败：

| 类别 | 次数 | 占比 | 根因 |
|---|---|---|---|
| 路径不存在 / ENOENT | 67 | 36% | read 不存在的文件为主（31 次读 `plan.md`，其余为迁移/改名后的旧路径） |
| Python traceback | 31 | 16% | 内嵌 python 一行代码语法/正则错误；项目脚本崩溃 |
| npm/依赖 | 15 | 8% | `Cannot find module 'ws'`、npm error |
| 编码 GBK/Unicode | 10 | 5% | `UnicodeEncodeError: 'gbk' codec`（python stdout 默认 GBK） |
| git | 10 | 5% | 非仓库目录跑 git、对仓库外路径操作 |
| mcp 用错 | 10 | 5% | 缺必填参数、查不存在的资源（404） |
| 其它（超时/权限/网络/沙箱） | 25 | 13% | 沙箱类仅 1 次——沙箱本身健康 |

结论：问题在「调用方式」不在沙箱。三类最高优先：路径类（read 前置校验）、编码类（python 自动 UTF-8）、防空转（报错后不瞎试）。

## 3. 与 Tool Runtime Guard 方案的对齐

参考来源：ChatGPT 共享对话《减少 agent harness 工具读写文件出错》。

### 采纳的原则

1. **Guard 异常与工具异常隔离**（最重要的教训）
   原方案 `except → 二次执行 original_tool_func` 会重复执行非幂等操作。本实现：hook 内全部 try/catch，guard 自身失败**原样放行**，绝不 block、绝不二次执行工具。
2. **结构化错误优于动态提示词**
   不返回 `Error: file not found`，而注入 `[fs-guard] kind=FILE_NOT_FOUND retryable=false fixable=true → 先列出父目录确认真实路径`。模型一眼可读，无需 320-token recovery skill。
3. **错误分类决定「谁处理、是否重试」**
   分类表（对齐方案第 5 节）：文件不存在→LLM 重判断路径（不重试）；编码→LLM 改执行方式；权限→不自动重试；EBUSY→代码层短暂重试（本实现由模型重试一次）；429/5xx→退避；unknown→先看根因。
4. **非幂等工具绝不自动重试**
   本实现不自动重试任何工具；防空转层只**提醒**，把决策权留给模型。
5. **路径统一正斜杠、不运行时改 `\`→`\\`**
   `analyzePath` 返回 `C:/...` 形式；不触碰序列化层。
6. **保留原编码原则**
   编码探测只读不改；提示「已有文件保留原编码/BOM/换行，勿强制转码」。
7. **文件 hash / stale edit 防护（预留）**
   STALE_EDIT 分类已实现（patch mismatch → 重读文件再编辑）；原子写/hash 校验留给 SafeFile 层 v0.2（CLI 阶段）。

### 未采纳/延后

- 全量 SafeFile 层（atomic write / hash 校验 / apply_patch）：pi 内置 write/edit 已具备基本语义，v0.2 CLI 再做。
- argv 数组 shell 接口：pi 的 bash 工具是字符串命令；已通过 `fs_guard python` 工具提供 argv 式无 shell 执行路径。
- 动态注入 recovery skill：由 ③ 分类行替代，零 token 常驻开销。

## 4. 实现结构

```
src/
├── core.ts     # 纯逻辑：classifyError / analyzePath / probeEncoding / buildSuggestion /
│               # rewritePythonCommand / isGitRepo / detectDestructive / looksLikeRealError
└── index.ts    # pi 扩展接线：tool_call / tool_result 钩子 + fs_guard 工具 + /fs-guard 命令 + 统计
tests/
└── core.test.ts  # node --test（Node 24 原生 TS），26 用例
```

- `core.ts` 零 pi 依赖 → CLI 复用路径。
- 统计持久化 `~/.pi/agent/fs-guard-stats.json`（withFileMutationQueue 防并发写坏）。

## 5. 开源方案参考

| 方案 | 借鉴点 | 未采用原因 |
|---|---|---|
| OpenAI Agents SDK (Function Tools) | Schema 驱动校验、结构化工具错误 | 与 pi 集成成本高 |
| LangGraph ToolNode / retry policy | 按异常类型决定重试、timeout、error handler | 为读写容错引入偏重 |
| MCP (inputSchema/isError/structuredContent) | 错误协议标准化、idempotentHint | pi 工具非 MCP 模型；错误分类思路已并入 ③ |
| Aider (whole / diff edit formats) | 小文件 whole、大文件 diff、失败重读再编辑 | 编辑层改动大，留 v0.2 |
| pi 官方扩展示例 (dirty-repo-guard / protected-paths / confirm-destructive / tool-override) | 破坏性命令/路径防护的模式与 hook 用法 | 直接采用其 hook 写法 |

## 6. 风险与边界

- **误拦风险**：破坏性命令检测为启发式，`#fsguard-allow` 显式放行兜底；read 拦截仅针对不存在/为目录，不影响正常读。
- **上下文开销**：仅真实错误时追加一行（~100 token），成功路径零注入。
- **并行工具模式**：hook 按事件独立处理，无共享状态竞争；防空转计数为会话级内存态。
- **版本依赖**：@earendil-works/pi-coding-agent 0.84.3（与运行中 app 一致）。
