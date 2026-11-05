#!/usr/bin/env node
'use strict';

/**
 * dsh-session — list / inspect / delete DeepSeek Harness sessions by id.
 *
 * dsh's persistence layer has no delete API (create/open/stat/list only), and
 * the shipped bundle is replaced on every npm upgrade, so this tool works
 * directly on the documented on-disk layout under $DSH_HOME:
 *
 *   sessions/<project>/<session-dir>/session.vN.jsonl[.zstd]   authoritative log
 *   sessions/<project>/<session-dir>/session.lock              kernel write lock
 *   storages/session_projcache/sessions/<id>.json              derived cache (safe to drop)
 *
 * Safety rules:
 *   - only paths inside $DSH_HOME/sessions are ever removed;
 *   - a session whose writer still holds session.lock is refused unless --force;
 *   - subagent children (header.parentSession) cascade by default;
 *   - delete is permanent unless --trash is given.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const readline = require('node:readline/promises');

const VERSION = '1.0.0';
const LOG_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/;

function resolveDshHome(cliRoot) {
  if (cliRoot) return path.resolve(cliRoot);
  const env = (process.env.DSH_HOME || '').trim();
  return env ? path.resolve(env) : path.join(os.homedir(), '.dsh');
}

function pathsFor(dshHome) {
  const sessionsRoot = path.join(dshHome, 'sessions');
  return {
    dshHome,
    sessionsRoot,
    storagesRoot: path.join(dshHome, 'storages'),
    projcacheDir: path.join(dshHome, 'storages', 'session_projcache', 'sessions'),
    trashRoot: path.join(dshHome, 'trash', 'sessions'),
  };
}

/* ------------------------------------------------------------------ */
/* encoding (mirrors @deepseek-ai/dsh-session-persistence-jsonl)       */
/* ------------------------------------------------------------------ */

/** Encode an arbitrary session id as one safe path segment. */
function encodeSegment(raw) {
  if (!raw) throw new Error('empty session id');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** Decode a session directory name back to the raw id (best effort). */
function decodeSegment(encoded) {
  return encoded.replace(/~([0-9A-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/* ------------------------------------------------------------------ */
/* reading session logs                                                */
/* ------------------------------------------------------------------ */

function readLogText(file) {
  const buf = fs.readFileSync(file);
  if (!file.endsWith('.zstd')) return buf.toString('utf8');
  if (typeof zlib.zstdDecompressSync === 'function') {
    return zlib.zstdDecompressSync(buf).toString('utf8');
  }
  // Older Node without zstd support: fall back to the system zstd binary.
  return execFileSync('zstd', ['-dc', file], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function pickLogFile(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const m = LOG_RE.exec(ent.name);
    if (!m) continue;
    candidates.push({ name: ent.name, version: m[1] ? Number(m[1]) : 0 });
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.version - a.version || a.name.localeCompare(b.name));
  return candidates[0].name;
}

function readHeader(dir, logFile) {
  const text = readLogText(path.join(dir, logFile));
  const line = text.split('\n', 1)[0];
  return JSON.parse(line);
}

function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isFile()) total += fs.statSync(full).size;
      else if (ent.isDirectory()) total += dirSize(full);
    } catch {
      /* ignore vanished files */
    }
  }
  return total;
}

function readTitle(projcacheDir, id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return '';
  try {
    const doc = JSON.parse(
      fs.readFileSync(path.join(projcacheDir, `${id}.json`), 'utf8'),
    );
    const rows = doc && doc.record && doc.record.rows;
    if (!rows) return '';
    if (rows.title && typeof rows.title.val === 'string' && rows.title.val.trim()) {
      return rows.title.val.trim();
    }
    const first =
      rows.titleInput &&
      rows.titleInput.val &&
      rows.titleInput.val.first &&
      rows.titleInput.val.first.text;
    if (typeof first === 'string' && first.trim()) {
      return first.trim().split('\n')[0].slice(0, 80);
    }
  } catch {
    /* cache is optional */
  }
  return '';
}

function scanSessions(p) {
  const sessions = [];
  if (!fs.existsSync(p.sessionsRoot)) return sessions;

  for (const projEnt of fs.readdirSync(p.sessionsRoot, { withFileTypes: true })) {
    if (!projEnt.isDirectory()) continue;
    const projDir = path.join(p.sessionsRoot, projEnt.name);
    for (const ent of fs.readdirSync(projDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(projDir, ent.name);
      const logFile = pickLogFile(dir);
      const fallbackId = decodeSegment(ent.name);
      const record = {
        id: fallbackId,
        dir,
        projectDir: projDir,
        projectName: projEnt.name,
        logFile,
        title: '',
        header: null,
        sizeBytes: dirSize(dir),
        lockPath: path.join(dir, 'session.lock'),
        active: false,
        holders: [],
        readable: false,
      };
      if (logFile) {
        try {
          record.header = readHeader(dir, logFile);
          if (record.header && typeof record.header.id === 'string') {
            record.id = record.header.id;
          }
          record.readable = true;
        } catch (err) {
          record.readError = err && err.message ? err.message : String(err);
        }
      }
      record.title = readTitle(p.projcacheDir, record.id);
      sessions.push(record);
    }
  }

  sessions.sort((a, b) => {
    const ca = a.header ? a.header.createdAt : 0;
    const cb = b.header ? b.header.createdAt : 0;
    return cb - ca || a.id.localeCompare(b.id);
  });
  return sessions;
}

/* ------------------------------------------------------------------ */
/* liveness: session.lock is held open by the owning writer            */
/* ------------------------------------------------------------------ */

function fileKey(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function findLockHolders(lockPaths, { ignoreMissing = false } = {}) {
  const holders = new Map();
  const existing = lockPaths.filter((f) => fs.existsSync(f));
  if (existing.length === 0) return holders;

  let out = '';
  try {
    out = execFileSync('lsof', ['-F', 'pcn', '--', ...existing], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // --force means "delete anyway", so a missing lsof must not block it.
      if (ignoreMissing) return holders;
      const missing = new Error('未找到 lsof，无法检测活跃会话（请改用 --force）');
      missing.code = 'NO_LSOF';
      throw missing;
    }
    out = err && err.stdout ? String(err.stdout) : '';
  }

  const byPath = new Map();
  let pid = null;
  let command = '';
  for (const line of out.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') pid = value;
    else if (tag === 'c') command = value;
    else if (tag === 'n') {
      const key = value;
      if (!byPath.has(key)) byPath.set(key, []);
      byPath.get(key).push({ pid, command });
    }
  }

  for (const [reported, list] of byPath) {
    const key = fileKey(reported);
    const merged = holders.get(key) || [];
    for (const item of list) {
      if (!merged.some((x) => x.pid === item.pid)) merged.push(item);
    }
    holders.set(key, merged);
  }
  return holders;
}

function runningDsh() {
  let out = '';
  try {
    out = execFileSync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const me = String(process.pid);
  const found = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || m[1] === me) continue;
    const cmd = m[2];
    if (cmd.includes('dsh-session')) continue;
    if (/(?:^|\s|\/)(?:bin\/)?dsh(?:\.js)?(?:\s|$)/.test(cmd)) {
      found.push({ pid: Number(m[1]), command: cmd });
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

function pad(value, width) {
  const s = String(value);
  // count wide CJK chars as 2 columns for alignment
  const w = [...s].reduce(
    (n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1),
    0,
  );
  return s + ' '.repeat(Math.max(0, width - w));
}

function truncate(value, width) {
  const s = String(value);
  if ([...s].length <= width) return s;
  return [...s].slice(0, Math.max(0, width - 1)).join('') + '…';
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function shortProject(name) {
  // --Users-alice-Documents-Work-- -> ~/Documents/Work (best effort)
  if (name === '_no-cwd') return '(no cwd)';
  const inner = name.replace(/^--/, '').replace(/--$/, '');
  return '~/' + inner.replace(/^Users-[^-]+-/, '').replace(/-/g, '/');
}

/* ------------------------------------------------------------------ */
/* matching                                                            */
/* ------------------------------------------------------------------ */

function resolveOne(sessions, input) {
  if (!input || input.length < 2) {
    throw new Error('会话 id 过短（至少 2 个字符）');
  }
  // 先按“id 开头 / UUID 开头”精确匹配，只有没有结果时才退化为子串匹配。
  const prefixMatches = sessions.filter(
    (s) =>
      s.id === input ||
      s.id.startsWith(input) ||
      s.id.replace(/^session-/, '').startsWith(input),
  );
  const matches =
    prefixMatches.length > 0
      ? prefixMatches
      : sessions.filter((s) => s.id.includes(input));
  if (matches.length === 0) {
    throw new Error(`找不到会话：${input}`);
  }
  if (matches.length > 1) {
    const list = matches
      .map((s) => `  ${s.id}  ${s.title || '(无标题)'}`)
      .join('\n');
    throw new Error(`会话 id 不唯一：${input}\n${list}`);
  }
  return matches[0];
}

function cascadeTargets(sessions, seed) {
  const targets = new Map();
  for (const s of seed) targets.set(s.id, s);
  let added = true;
  while (added) {
    added = false;
    for (const s of sessions) {
      const parent = s.header && s.header.parentSession;
      if (parent && targets.has(parent) && !targets.has(s.id)) {
        targets.set(s.id, s);
        added = true;
      }
    }
  }
  return [...targets.values()];
}

/* ------------------------------------------------------------------ */
/* mutation                                                            */
/* ------------------------------------------------------------------ */

function assertInside(root, candidate) {
  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + path.sep)) {
    throw new Error(`拒绝删除 ${candidate}：它不在 ${root} 内`);
  }
  return realCandidate;
}

function removeProjcache(p, id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return [];
  const removed = [];
  const exact = path.join(p.projcacheDir, `${id}.json`);
  if (fs.existsSync(exact)) {
    fs.rmSync(exact, { force: true });
    removed.push(exact);
  }
  let names = [];
  try {
    names = fs.readdirSync(p.projcacheDir);
  } catch {
    return removed;
  }
  const prefix = `${id}.json.bak.`;
  for (const name of names) {
    if (name.startsWith(prefix)) {
      const full = path.join(p.projcacheDir, name);
      fs.rmSync(full, { force: true });
      removed.push(full);
    }
  }
  return removed;
}

function moveToTrash(p, record, stamp, manifest) {
  const destDir = path.join(p.trashRoot, stamp, record.projectName);
  fs.mkdirSync(destDir, { recursive: true });
  let dest = path.join(destDir, path.basename(record.dir));
  let n = 1;
  while (fs.existsSync(dest)) dest = `${path.join(destDir, path.basename(record.dir))}-${n++}`;
  fs.renameSync(record.dir, dest);
  manifest.push({
    id: record.id,
    title: record.title,
    from: record.dir,
    to: dest,
    projcache: [],
  });
}

function removeEmptyProjectDir(projectDir, sessionsRoot) {
  if (path.resolve(projectDir) === path.resolve(sessionsRoot)) return;
  try {
    if (fs.readdirSync(projectDir).length === 0) fs.rmdirSync(projectDir);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

function printUsage(topic) {
  const t = topic && topic.toLowerCase();

  if (t === 'delete' || t === 'rm' || t === 'remove') {
    console.log(`dsh-session delete — 按 session id 删除会话

用法:
  dsh-session delete <id...> [选项]

id 可以是完整 id、session- 前缀之后的开头，或唯一子串：
  dsh-session delete 7d6ce8a5
  dsh-session delete session-7d6ce8a5-eb04-45c9-b67e-6e87461057f1
  dsh-session delete 7d6ce8a5 --dry-run     # 先看会删什么

选项:
  -n, --dry-run       只显示将删除的内容，不执行
  -y, --yes           跳过交互确认（脚本/管道环境必须加）
  -f, --force         即使会话正被 dsh 进程写锁占用也删除（不推荐）
      --trash         不永久删除，移动到 <DSH_HOME>/trash/sessions/<时间戳>/
      --no-cascade    不级联删除该会话的 subagent 子会话
      --root <dir>    使用指定的 DSH_HOME（默认 $DSH_HOME 或 ~/.dsh）

行为说明:
  - 默认永久删除；加 --trash 可恢复（回收站里带 manifest.json）
  - 默认会把 parentSession 指向该会话的 subagent 子会话一起删除
  - 会话正被 dsh 写锁占用时默认拒绝；退出 dsh 或加 --force
  - 同时清理 storages/session_projcache 里的派生缓存
  - 不改 workspace.json（残留 id 会被 dsh 自动过滤）

示例:
  dsh-session delete 7d6ce8a5 --dry-run
  dsh-session delete 7d6ce8a5 --trash
  dsh-session delete 7d6ce8a5 -y
  dsh-session delete 7d6ce8a5 --no-cascade --trash -y
`);
    return;
  }

  if (t === 'list' || t === 'ls') {
    console.log(`dsh-session list — 列出会话

用法:
  dsh-session list [--json] [--root <DSH_HOME>]

选项:
      --json          输出机器可读 JSON（含完整 id、路径、活跃 pid）
      --root <dir>    使用指定的 DSH_HOME（默认 $DSH_HOME 或 ~/.dsh）

状态列:
  活跃 = 有 dsh 进程持有该会话的 session.lock（删除前需要退出 dsh）
  空闲 = 当前没有进程写入，可以直接删除
`);
    return;
  }

  if (t === 'show' || t === 'inspect') {
    console.log(`dsh-session show — 查看单个会话详情

用法:
  dsh-session show <id> [--root <DSH_HOME>]

id 规则与 delete 相同：完整 id、session- 前缀之后的开头，或唯一子串。
`);
    return;
  }

  console.log(`dsh-session ${VERSION} — 列出 / 查看 / 删除 DeepSeek Harness 会话

用法:
  dsh-session list [--json] [--root <DSH_HOME>]        列出全部会话
  dsh-session show <id> [--root <DSH_HOME>]            查看单个会话详情
  dsh-session delete <id...> [选项]                    删除会话（支持 id 前缀）

按命令查看详细帮助:
  dsh-session help delete     删除选项、行为说明与示例
  dsh-session help list       列表选项
  dsh-session help show       查看选项
  dsh-session delete --help   同上（任意命令后加 -h / --help 均可）

常用删除选项（完整说明见 dsh-session help delete）:
  -n, --dry-run       只显示将删除的内容，不执行
  -y, --yes           跳过交互确认（非交互环境必须加）
  -f, --force         会话被 dsh 写锁占用时也强删（不推荐）
      --trash         永久删除改为移入 <DSH_HOME>/trash/sessions/
      --no-cascade    不级联删除 subagent 子会话
      --root <dir>    指定 DSH_HOME（默认 $DSH_HOME 或 ~/.dsh）

示例:
  dsh-session list
  dsh-session delete 7d6ce8a5 --dry-run
  dsh-session delete 7d6ce8a5 --trash
`);
}

/** Fill holders/active on each session. Returns false when lsof is unavailable. */
function markLiveness(sessions, { quiet = false } = {}) {
  try {
    const holders = findLockHolders(sessions.map((s) => s.lockPath));
    for (const s of sessions) {
      s.holders = holders.get(fileKey(s.lockPath)) || [];
      s.active = s.holders.length > 0;
    }
    return true;
  } catch (err) {
    if (!err || err.code !== 'NO_LSOF') throw err;
    if (!quiet) {
      console.error(
        '提示：未找到 lsof，无法判断会话是否活跃；删除前请先退出 dsh，或加 --force。',
      );
    }
    for (const s of sessions) {
      s.holders = [];
      s.active = false;
      s.livenessKnown = false;
    }
    return false;
  }
}

function cmdList(p, opts) {
  const sessions = scanSessions(p);
  const livenessKnown = markLiveness(sessions);

  if (opts.json) {
    console.log(
      JSON.stringify(
        sessions.map((s) => ({
          id: s.id,
          title: s.title,
          cwd: s.header ? s.header.cwd : undefined,
          createdAt: s.header ? s.header.createdAt : undefined,
          createdAtIso: s.header ? new Date(s.header.createdAt).toISOString() : undefined,
          sizeBytes: s.sizeBytes,
          active: s.active,
          activeUnknown: livenessKnown ? undefined : true,
          holderPids: s.holders.map((h) => h.pid),
          parentSession: s.header ? s.header.parentSession : undefined,
          origin: s.header ? s.header.origin : undefined,
          dir: s.dir,
          logFile: s.logFile,
          readable: s.readable,
          readError: s.readError,
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (sessions.length === 0) {
    console.log(`没有会话（${p.sessionsRoot} 为空）`);
    return;
  }

  const activeCount = sessions.filter((s) => s.active).length;
  const totalSize = sessions.reduce((n, s) => n + s.sizeBytes, 0);
  const activeLabel = livenessKnown ? `活跃 ${activeCount}` : '活跃状态未知';
  console.log(
    `${sessions.length} 个会话（${activeLabel}，共 ${fmtBytes(totalSize)}）\n`,
  );
  console.log(
    `${pad('ID', 46)}${pad('创建时间', 19)}${pad('大小', 10)}${pad('状态', 8)}标题`,
  );

  const cols = process.stdout.columns || 120;
  for (const s of sessions) {
    const titleWidth = Math.max(10, cols - 46 - 19 - 10 - 8);
    const status = s.active ? '活跃' : livenessKnown ? '空闲' : '未知';
    const suffix = s.readable ? '' : ' [日志不可读]';
    console.log(
      `${pad(s.id, 46)}${pad(fmtTime(s.header && s.header.createdAt), 19)}${pad(fmtBytes(s.sizeBytes), 10)}${pad(status, 8)}${truncate(s.title || '(无标题)', titleWidth)}${suffix}`,
    );
  }
}

function printRecord(s) {
  const h = s.header || {};
  console.log(`ID:        ${s.id}`);
  console.log(`标题:      ${s.title || '(无标题)'}`);
  console.log(`目录:      ${s.dir}`);
  console.log(`项目 cwd:  ${h.cwd || '-'}`);
  console.log(`创建时间:  ${fmtTime(h.createdAt)}`);
  console.log(`大小:      ${fmtBytes(s.sizeBytes)}`);
  const status = s.active
    ? `活跃（pid ${s.holders.map((x) => x.pid).join(', ')}）`
    : s.livenessKnown === false
      ? '未知（未找到 lsof）'
      : '空闲';
  console.log(`状态:      ${status}`);
  if (h.parentSession) console.log(`父会话:    ${h.parentSession}`);
  if (h.origin) console.log(`来源:      ${h.origin}`);
  if (h.delegationDepth !== undefined) console.log(`委派深度:  ${h.delegationDepth}`);
  console.log(`日志文件:  ${s.logFile || '(无)'}`);
  if (s.readError) console.log(`读取错误:  ${s.readError}`);
}

function cmdShow(p, id) {
  if (!id) throw new Error('用法：dsh-session show <id>');
  const sessions = scanSessions(p);
  const record = resolveOne(sessions, id);
  markLiveness([record]);
  printRecord(record);
}

async function cmdDelete(p, ids, opts) {
  if (ids.length === 0) throw new Error('用法：dsh-session delete <id...>');

  const sessions = scanSessions(p);
  const seed = [];
  for (const input of ids) seed.push(resolveOne(sessions, input));

  const cascade = !opts.noCascade;
  const targets = cascade ? cascadeTargets(sessions, seed) : seed;

  const holders = findLockHolders(targets.map((s) => s.lockPath), {
    ignoreMissing: opts.force,
  });
  for (const s of targets) {
    s.holders = holders.get(fileKey(s.lockPath)) || [];
    s.active = s.holders.length > 0;
  }

  const active = targets.filter((s) => s.active);
  if (active.length > 0 && !opts.force) {
    console.error('以下会话正被 dsh 进程占用写锁，拒绝删除：');
    for (const s of active) {
      console.error(
        `  ${s.id}  pid=${s.holders.map((x) => x.pid).join(',')}  ${s.title || ''}`,
      );
    }
    console.error(
      '\n请先在 dsh 中关闭该会话或退出 dsh 后重试；确实要强删请加 --force。',
    );
    process.exitCode = 2;
    return;
  }

  const dshProcs = runningDsh();
  if (dshProcs.length > 0) {
    console.error(
      `提示：检测到 dsh 正在运行（pid ${dshProcs.map((x) => x.pid).join(', ')}）。` +
        '已加载到它内存里的会话，可能需要重启 dsh 后才会从界面消失。',
    );
  }

  const totalSize = targets.reduce((n, s) => n + s.sizeBytes, 0);
  console.log(
    `${opts.dryRun ? '[dry-run] 将删除' : '将删除'} ${targets.length} 个会话（${fmtBytes(totalSize)}）：`,
  );
  const seeds = new Set(seed.map((s) => s.id));
  for (const s of targets) {
    const tag = seeds.has(s.id) ? '' : '  [subagent 级联]';
    const lock = s.active ? `  [活跃 pid ${s.holders.map((x) => x.pid).join(',')}]` : '';
    console.log(
      `  ${s.id}  ${fmtBytes(s.sizeBytes).padEnd(9)} ${s.title || '(无标题)'}${tag}${lock}`,
    );
    console.log(`    ${s.dir}`);
  }

  if (opts.dryRun) return;

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      throw new Error('非交互环境请加 --yes 以确认删除');
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await rl.question(
      `\n确认${opts.trash ? '移入回收站' : '永久删除'}？输入 y 继续：`,
    );
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('已取消。');
      return;
    }
  }

  const stamp = (() => {
    const d = new Date();
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  })();
  const manifest = [];

  let failures = 0;
  for (const s of targets) {
    try {
      assertInside(p.sessionsRoot, s.dir);
      // Re-check right before removal: dsh may have resumed the session
      // between the plan and this loop.
      if (!opts.force && fs.existsSync(s.lockPath)) {
        const now = findLockHolders([s.lockPath]).get(fileKey(s.lockPath)) || [];
        if (now.length > 0) {
          throw new Error(
            `执行前检测到会话被 pid ${now.map((x) => x.pid).join(',')} 占用，已跳过（可加 --force）`,
          );
        }
      }
      if (opts.trash) {
        moveToTrash(p, s, stamp, manifest);
      } else {
        fs.rmSync(s.dir, { recursive: true, force: false });
      }
      const removedCache = removeProjcache(p, s.id);
      if (opts.trash) manifest[manifest.length - 1].projcache = removedCache;
      removeEmptyProjectDir(s.projectDir, p.sessionsRoot);
      console.log(`✓ ${s.id}`);
    } catch (err) {
      failures++;
      console.error(`✗ ${s.id}: ${err && err.message ? err.message : err}`);
    }
  }

  if (opts.trash && manifest.length > 0) {
    const manifestPath = path.join(p.trashRoot, stamp, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ stamp, entries: manifest }, null, 2));
    console.log(`\n回收站清单位于 ${manifestPath}`);
  }
  if (failures > 0) {
    process.exitCode = 1;
    console.error(`\n${failures} 个会话删除失败。`);
  }
}

/* ------------------------------------------------------------------ */
/* entry                                                               */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    json: false,
    yes: false,
    dryRun: false,
    force: false,
    trash: false,
    noCascade: false,
    root: undefined,
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '-y' || a === '--yes') opts.yes = true;
    else if (a === '-n' || a === '--dry-run') opts.dryRun = true;
    else if (a === '-f' || a === '--force') opts.force = true;
    else if (a === '--trash') opts.trash = true;
    else if (a === '--no-cascade') opts.noCascade = true;
    else if (a === '--root') {
      opts.root = argv[++i];
      if (!opts.root) throw new Error('--root 需要一个目录参数');
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else if (a === '-V' || a === '--version') {
      console.log(VERSION);
      process.exit(0);
    } else if (a.startsWith('-')) {
      throw new Error(`未知选项：${a}`);
    } else positional.push(a);
  }
  return { opts, positional };
}

async function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  const dshHome = resolveDshHome(opts.root);
  const p = pathsFor(dshHome);

  let command = positional.shift();
  if (opts.help) {
    printUsage(command);
    return;
  }
  if (command === 'help') {
    printUsage(positional.shift());
    return;
  }
  command = command || 'list';
  const ids = positional;

  switch (command) {
    case 'list':
    case 'ls':
      cmdList(p, opts);
      break;
    case 'show':
    case 'inspect':
      cmdShow(p, ids[0]);
      break;
    case 'delete':
    case 'rm':
    case 'remove':
      await cmdDelete(p, ids, opts);
      break;
    default:
      throw new Error(`未知命令：${command}（可用：list / show / delete）`);
  }
}

main().catch((err) => {
  console.error(`错误：${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
