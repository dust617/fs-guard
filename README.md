# fs-guard

pi Coding Agent 的工具运行时防护扩展（**Tool Runtime Guard**）：自动拦截读写/执行错误、做错误分类、注入自愈提示，附带破坏性命令与 git 仓库边界防护。核心逻辑为纯函数，可复用为 CLI 或接入其它 agent harness。

> 目标：让 agent「读写少出错、报错不瞎试」。不是给模型的提示词约束，而是**运行时自动防护**——agent 无需记得任何规则。

## 四层防护

| 层 | 机制 | 对应错误 |
|---|---|---|
| ① 参数校验 | `tool_call` 钩子：`read` 目标不存在/为目录时直接 block，附带同级目录相似文件名候选 | ENOENT/路径类（本机实测最大类，占 36%） |
| ② 自动修复 | `bash` 命令以 `python` 开头时自动注入 `-X utf8` | GBK/Unicode 编码类（实测 10+ 次） |
| ③ 错误分类 | `tool_result` 钩子：真实报错时追加一行结构化单行 `kind / retryable / fixable / suggestion` | 全部类别的「报错后瞎换工具」 |
| ④ 防空转 | 同一工具同一目标连续失败 ≥2 次 → 追加「先定位根因，勿盲目重试/换工具」 | 无效重试循环 |

### 附加防护（tool_call 钩子）

- **破坏性命令拦截**：`rm -rf` / `rm -fr` / `del /s` / `rmdir /s` / `Remove-Item -Recurse/-Force` / `format` / `taskkill /f` / `git clean -f` / `git reset --hard` / Windows 设备名删除（`nul`/`con`/…）等。确认执行需在命令末尾加 `#fsguard-allow`。
- **git 仓库边界**：`git` 命令（clone/init/config --global 除外）若当前目录不是 git 仓库 → block 并提示，支持 `git -C <repo>` 检测。

## 安装（pi 扩展）

```bash
# 方式一：直接复制到全局扩展目录（所有项目 / 所有 agent 生效）
cp -r . C:/Users/<user>/.pi/agent/extensions/fs-guard
# 方式二：settings.json 的 extensions 里指向本目录
```

然后在 pi 内执行 `/reload` 热加载。

验证：`/fs-guard` 命令可查看统计与开关；或故意 `read` 一个不存在的文件、运行 `python -c "print('✓')"` 观察拦截/改写。

### 开关配置

统计文件 `~/.pi/agent/fs-guard-stats.json` 中的 `guards` 对象可逐项关闭：

```json
"guards": {
  "readBlock": true,      // ① read 不存在/为目录拦截
  "pythonUtf8": true,     // ② python -X utf8 自动注入
  "gitRepo": true,        // 附加：git 仓库边界
  "destructive": true,    // 附加：破坏性命令拦截
  "classify": true,       // ③ 错误分类注入
  "antiSpin": true        // ④ 防空转提醒
}
```

单个命令显式放行：命令末尾加 `#fsguard-allow`。

## 主动诊断工具 `fs_guard`

LLM 可主动调用（参数 action）：

- `check {path}` — 存在性/类型/大小/编码探测（BOM/utf8/gbk/binary）/是否被锁/mtime；不存在时返回同级候选
- `find {fragment}` — 项目内按文件名片段查找（跳过 node_modules/.git/dist/build/archive 等）
- `classify {text}` — 错误文本分类 → `{kind, retryable, modelFixable, suggestion}`
- `python {code}` — 以 UTF-8 模式执行 Python 源码（argv 数组调用，无 shell 转义问题）

## 统计

`tool_result` 钩子自动记录 `工具×错误类别` 计数到 `~/.pi/agent/fs-guard-stats.json`；`/fs-guard` 命令查看 Top 列表，`/fs-guard reset` 清空。可用于追踪哪类错误最频繁，指导后续优化。

## CLI 接口（预留，v0.2）

核心逻辑已在 `src/core.ts` 纯函数化，后续 CLI 直接复用。规划中的接口约定：

```text
fs-guard check <path>      → JSON {exists, isFile, isDir, size, encoding, locked, mtimeMs, suggestions?}
fs-guard find <fragment>   → JSON {hits[], count}
fs-guard classify <text>   → JSON {kind, retryable, modelFixable, suggestion}
fs-guard python <code>     → 以 UTF-8 模式执行 Python 代码（stdout/stderr/exitCode）
fs-guard guard <command>   → 对命令做防护判定（破坏性/git 边界/python 改写预览）
```

CLI 无 pi 依赖，可被 Claude Code、Cursor 等其它 agent 直接调用。

## 设计依据

- **Tool Runtime Guard 方案**（schema 校验 + 错误分类 + 安全重试 + SafeFile），关键原则：guard 异常与工具异常隔离、非幂等操作绝不自动重试、结构化错误 `{kind, retryable, model_fixable, suggestion}` 优于动态提示词。见 `docs/design.md`。
- **本机实测数据**：扫描 8 月以来会话转录，188 次真实工具失败；路径类 36%（read ENOENT 为主，其中 31 次是读不存在的 plan.md）、Python traceback 16%、npm 依赖 8%、编码 GBK 5%、git 5%、mcp 用错 5%。防护优先级即按此排序。

## 开发

```bash
npm install
npm run verify    # typecheck + 单测
npm test          # node --test tests/core.test.ts
```

## 许可

MIT
