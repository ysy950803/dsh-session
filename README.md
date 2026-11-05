# dsh-session

[![CI](https://github.com/ysy950803/dsh-session/actions/workflows/ci.yml/badge.svg)](https://github.com/ysy950803/dsh-session/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

> 在终端里列出、查看、删除 **DeepSeek Harness（`dsh`）** 的会话。
> 零依赖，一个可执行文件，直接管理 `$DSH_HOME` 下的会话目录。

```
$ dsh-session list

3 个会话（活跃 1，共 4.2 MB）

ID                                            创建时间           大小      状态    标题
session-7d6ce8a5-eb04-45c9-b67e-6e87461057f1  2026-10-31 20:37   1.5 MB    空闲    重构登录流程
session-1c3d55a6-a615-420e-bf70-804d32132d38  2026-10-30 16:55   292 KB    空闲    调研竞品方案
session-3db4fe78-dc1b-4d69-8e62-efbee7376ab5  2026-10-29 15:37   59 KB     活跃    整理会议纪要
```

## 为什么需要它

`dsh` 的持久化层只暴露 create / open / stat / list，**没有删除接口**，界面上通常也只能归档。
会话越积越多，手动去 `~/.dsh` 里翻目录又很容易删错：

- 目录名是转义过的，和界面里的会话对不上；
- 子 agent（subagent）会话单独成目录，只删父会话会留下孤儿；
- 正在使用的会话被进程锁着，硬删可能损坏数据；
- 删完目录还要清理 `storages` 里的派生缓存。

`dsh-session` 把这些步骤收成三条命令，并且把安全边界写死在代码里。

它不修改 `dsh` 本体，也不依赖任何 npm 包。`dsh` 每次升级会替换自己的 bundle，
对这个工具没有影响。

## 功能

- `list`：列出全部会话，显示 ID、创建时间、大小、活跃状态和标题
- `show`：查看单个会话的详情（路径、cwd、父会话、日志文件……）
- `delete`：按 ID 删除，支持 ID 前缀、唯一子串、批量删除
- `--dry-run`：先看会删什么，再决定
- `--trash`：移入 `<DSH_HOME>/trash/sessions/<时间戳>/`，并生成 `manifest.json`
- 自动级联删除 subagent 子会话（可用 `--no-cascade` 关闭）
- 通过 `session.lock` 检测会话是否仍被 `dsh` 进程占用
- `--json`：给脚本用的机器可读输出
- 只删除 `$DSH_HOME/sessions` 内的路径，并同步清理派生缓存

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | >= 18 |
| 系统 | macOS / Linux（依赖 `lsof` 与 `ps`） |
| `dsh` | 已安装，`$DSH_HOME` 默认为 `~/.dsh` |
| 读取 `.zstd` 日志 | Node >= 22.15 自带 zstd；旧版本需要系统安装 `zstd` |

> Windows 未做完整验证：没有 `lsof` 时，`list` / `show` 会把状态显示为“未知”，
> `delete` 需要加 `--force` 跳过占用检测。

## 安装

从源码安装（推荐）：

```bash
git clone https://github.com/ysy950803/dsh-session.git
cd dsh-session
npm link
```

`npm link` 会在全局 bin 目录创建 `dsh-session` 软链。如果不想动全局环境，也可以直接把
脚本放进 `PATH`：

```bash
install -m 755 bin/dsh-session.js ~/.local/bin/dsh-session
```

或者完全不安装，直接运行：

```bash
node /path/to/dsh-session/bin/dsh-session.js list
```

验证：

```bash
dsh-session --version
# 1.0.0
```

## 快速开始

```bash
# 1. 看看有哪些会话
dsh-session list

# 2. 查看某个会话的详情（ID 写前缀即可）
dsh-session show 7d6ce8a5

# 3. 先演练，确认要删的内容
dsh-session delete 7d6ce8a5 --dry-run

# 4. 移入回收站（可手动恢复），而不是永久删除
dsh-session delete 7d6ce8a5 --trash
```

删除前建议先退出 `dsh`。如果目标会话正被 `dsh` 持有写锁，工具会拒绝删除。

## 命令说明

### `dsh-session list`

```bash
dsh-session list
dsh-session list --json
```

| 选项 | 说明 |
| --- | --- |
| `--json` | 输出机器可读 JSON，包含完整 ID、磁盘路径、活跃 PID、父会话等 |
| `--root <dir>` | 指定 `DSH_HOME`（默认 `$DSH_HOME`，再回退到 `~/.dsh`） |

状态列的含义：

- **活跃**：有进程持有该会话的 `session.lock`，此时默认不能删除；
- **空闲**：没有进程写入，可以直接删除；
- **未知**：系统找不到 `lsof`，无法判断（仅在缺少 `lsof` 时出现）。

`--json` 的每一行大致如下：

```json
{
  "id": "session-7d6ce8a5-eb04-45c9-b67e-6e87461057f1",
  "title": "重构登录流程",
  "cwd": "/Users/you/project",
  "createdAt": 1761914231000,
  "createdAtIso": "2026-10-31T12:37:11.000Z",
  "sizeBytes": 1572864,
  "active": false,
  "holderPids": [],
  "parentSession": null,
  "origin": "cli",
  "dir": "/Users/you/.dsh/sessions/--Users-you-project--/session-7d6ce8a5-...",
  "logFile": "session.v4.jsonl.zstd",
  "readable": true
}
```

### `dsh-session show <id>`

```bash
dsh-session show 7d6ce8a5
```

输出示例：

```
ID:        session-7d6ce8a5-eb04-45c9-b67e-6e87461057f1
标题:      重构登录流程
目录:      /Users/you/.dsh/sessions/--Users-you-project--/session-7d6ce8a5-...
项目 cwd:  /Users/you/project
创建时间:  2026-10-31 20:37
大小:      1.5 MB
状态:      空闲
日志文件:  session.v4.jsonl.zstd
```

### `dsh-session delete <id...>`

```bash
dsh-session delete <id...> [选项]
```

| 选项 | 说明 |
| --- | --- |
| `-n`, `--dry-run` | 只显示将删除的内容，不执行 |
| `-y`, `--yes` | 跳过交互确认；脚本、管道等非交互环境必须加 |
| `-f`, `--force` | 即使会话仍被写锁占用也删除（不推荐） |
| `--trash` | 不永久删除，改为移入 `<DSH_HOME>/trash/sessions/<时间戳>/` |
| `--no-cascade` | 不级联删除该会话的 subagent 子会话 |
| `--root <dir>` | 指定 `DSH_HOME` |

示例：

```bash
# 先演练
dsh-session delete 7d6ce8a5 --dry-run

# 移入回收站
dsh-session delete 7d6ce8a5 --trash

# 批量永久删除（脚本里）
dsh-session delete 7d6ce8a5 1c3d55a6 3db4fe78 -y

# 只删父会话，保留 subagent 子会话
dsh-session delete 7d6ce8a5 --no-cascade --trash -y
```

默认行为：

- **永久删除**。想留后路请加 `--trash`；
- 会把 `parentSession` 指向该会话的 subagent 子会话一起删除；
- 会同步删除 `storages/session_projcache` 里对应的标题缓存；
- 不会修改 `workspace.json`，其中残留的 ID 会被 `dsh` 自动过滤。

### ID 匹配规则

每次输入至少 2 个字符，按以下顺序匹配：

1. 完整 ID；
2. ID 前缀；
3. 去掉 `session-` 后的前缀；
4. 唯一子串（只有前三步都没有结果时才会用到）。

命中多个会话时会报错并列出候选，不会“猜”你要删哪个：

```
错误：会话 id 不唯一：7d6
  session-7d6ce8a5-...  重构登录流程
  session-7d6d01bb-...  调研竞品方案
```

## 安全模型

删除是不可逆操作，所以工具刻意做得保守：

1. **路径边界**：只会删除 `$DSH_HOME/sessions` 内部的路径。删除前对根目录和目标目录做
   `realpath` 校验，防止软链或解析差异把删除操作带出边界。
2. **写锁检测**：通过 `lsof` 检查是否有进程持有 `session.lock`。被占用的会话默认拒绝删除。
3. **执行前复查**：在真正删除每个会话之前再检查一次写锁，避免规划与执行之间 `dsh`
   重新打开了会话。
4. **级联可控**：只级联 `header.parentSession` 明确指向目标的子会话，可用 `--no-cascade` 关闭。
5. **回收站清单**：`--trash` 模式下，每个批次生成 `manifest.json`，记录原始路径、标题、
   新路径和被清理的缓存文件。

不会碰的东西：

- `~/.dsh/credentials.yaml`、`profiles/`、`attachments/`、`llm-*/`；
- `workspace.json`；
- 任何不在 `$DSH_HOME/sessions` 下的文件。

## 它是怎么工作的

`dsh-session` 直接读取 `dsh` 的磁盘布局：

```
$DSH_HOME/                            # 默认 ~/.dsh
├── sessions/
│   └── <project>/                    # cwd 转义后的项目目录
│       └── <session-dir>/            # 会话 ID 转义后的目录
│           ├── session.vN.jsonl      # 权威会话日志（可能带 .zstd）
│           └── session.lock          # 活跃写入者持有的文件锁
├── storages/
│   └── session_projcache/
│       └── sessions/<id>.json        # 派生标题缓存，可安全重建
└── trash/
    └── sessions/<timestamp>/         # 本工具的 --trash 目标
        └── manifest.json
```

具体做法：

- 扫描 `sessions/<project>/<session-dir>`，选择版本号最高的
  `session.vN.jsonl[.zstd]`；
- 读取日志第一行的 header，拿到会话 ID、cwd、创建时间、`parentSession`；
- 标题优先取 `projcache`，缓存缺失时退化为首条输入的前 80 个字符；
- 用 `lsof` 查 `session.lock` 的持有者，判断会话是否活跃；
- 删除时按“路径校验 → 复查锁 → 移动/删除目录 → 清理缓存 → 清理空项目目录”的顺序执行。

## 常见问题

**Q：提示“正被 dsh 进程占用写锁，拒绝删除”？**

先在 `dsh` 里关闭该会话，或者直接退出 `dsh`，然后重试。确实需要强删时加 `--force`，
但不推荐——写入中的日志可能损坏。

**Q：删除后 `dsh` 界面里还能看到？**

`dsh` 可能已经把会话列表加载进内存了。重启 `dsh` 后就会消失。

**Q：提示“未找到 lsof”？**

安装 `lsof`（macOS 自带；Debian/Ubuntu 可 `sudo apt install lsof`），或者接受状态未知：
`delete` 时加 `--force` 跳过占用检测。

**Q：`.zstd` 日志读不出来？**

升级到 Node.js 22.15+（内置 zstd 解压），或安装系统 `zstd` 命令作为回退：

```bash
brew install zstd        # macOS
sudo apt install zstd    # Debian / Ubuntu
```

**Q：`--trash` 后怎么恢复？**

打开 `<DSH_HOME>/trash/sessions/<时间戳>/manifest.json`，把 `entries[].to` 目录移回
`entries[].from` 即可。缓存文件不会自动恢复，但 `dsh` 会重新生成。

**Q：会删除模型配置或登录凭据吗？**

不会。工具只处理 `sessions/` 和 `storages/session_projcache/`。

## 开发

仓库只有一个可执行文件，没有运行时依赖，测试使用 Node 内置的 `node:test`：

```bash
npm test
```

测试会在临时目录里构造伪造的 `DSH_HOME`，不会读写真实的 `~/.dsh`。

## English

A zero-dependency CLI to **list, inspect and delete DeepSeek Harness (`dsh`) sessions**.

`dsh` has no delete API and its UI only archives sessions. This tool operates directly on the
on-disk layout under `$DSH_HOME` (default `~/.dsh`), which survives `dsh` upgrades.

```bash
git clone https://github.com/ysy950803/dsh-session.git
cd dsh-session && npm link

dsh-session list
dsh-session show <id-prefix>
dsh-session delete <id-prefix> --dry-run
dsh-session delete <id-prefix> --trash
```

Highlights: prefix / substring ID matching, subagent cascade, `session.lock` liveness checks via
`lsof`, dry-run, trash with a restore manifest, and JSON output. Requires Node.js >= 18 on
macOS/Linux.

## License

[MIT](LICENSE)
