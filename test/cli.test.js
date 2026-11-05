'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'dsh-session.js');
const PROJECT = '--Users-test-project--';

const ID = {
  parent: 'session-aaaaaaaa-1111-4111-8111-111111111111',
  child: 'session-bbbbbbbb-2222-4222-8222-222222222222',
  other: 'session-cccccccc-3333-4333-8333-333333333333',
};

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function makeEmptyPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-empty-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, home, env) {
  const argv = home ? [...args, '--root', home] : args;
  return spawnSync(process.execPath, [CLI, ...argv], {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function writeSession(
  home,
  { id, createdAt, parentSession, title, lock = false, project = PROJECT },
) {
  const dir = path.join(home, 'sessions', project, id);
  fs.mkdirSync(dir, { recursive: true });

  const header = {
    id,
    cwd: '/Users/test/project',
    createdAt,
    origin: parentSession ? 'subagent' : 'cli',
  };
  if (parentSession) header.parentSession = parentSession;

  const lines = [
    JSON.stringify(header),
    JSON.stringify({ type: 'message', role: 'user', text: 'hello' }),
    JSON.stringify({ type: 'message', role: 'assistant', text: 'hi' }),
  ];
  fs.writeFileSync(path.join(dir, 'session.v2.jsonl'), `${lines.join('\n')}\n`);
  if (lock) fs.writeFileSync(path.join(dir, 'session.lock'), '');

  if (title) {
    const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, `${id}.json`),
      JSON.stringify({ record: { rows: { title: { val: title } } } }),
    );
  }

  return dir;
}

function seed(t) {
  const home = makeHome(t);
  const dirs = {
    parent: writeSession(home, {
      id: ID.parent,
      createdAt: 3000,
      title: '父会话标题',
    }),
    child: writeSession(home, {
      id: ID.child,
      createdAt: 2000,
      title: '子任务标题',
      parentSession: ID.parent,
    }),
    other: writeSession(home, {
      id: ID.other,
      createdAt: 1000,
      title: '另一个会话',
    }),
  };
  return { home, dirs };
}

test('list --json reports titles, sizes and parent links', (t) => {
  const { home } = seed(t);
  const r = run(['list', '--json'], home);

  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((x) => x.id),
    [ID.parent, ID.child, ID.other],
  );
  assert.equal(rows[0].title, '父会话标题');
  assert.equal(rows[1].parentSession, ID.parent);
  assert.equal(rows[0].active, false);
  assert.equal(rows[0].readable, true);
  assert.equal(rows[0].logFile, 'session.v2.jsonl');
  assert.ok(rows[0].sizeBytes > 0);
});

test('show resolves an id prefix and prints details', (t) => {
  const { home } = seed(t);
  const r = run(['show', 'bbbbbbbb'], home);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(ID.child));
  assert.match(r.stdout, /子任务标题/);
  assert.match(r.stdout, /父会话:/);
});

test('delete --dry-run changes nothing', (t) => {
  const { home, dirs } = seed(t);
  const r = run(['delete', 'aaaaaaaa', '--dry-run'], home);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[dry-run\] 将删除 2 个会话/);
  assert.ok(fs.existsSync(dirs.parent));
  assert.ok(fs.existsSync(dirs.child));
});

test('delete --trash cascades to subagent children and writes a manifest', (t) => {
  const { home, dirs } = seed(t);
  const r = run(['delete', 'aaaaaaaa', '--trash', '-y'], home);

  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(dirs.parent));
  assert.ok(!fs.existsSync(dirs.child));
  assert.ok(fs.existsSync(dirs.other));

  const stamp = fs.readdirSync(path.join(home, 'trash', 'sessions'))[0];
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(home, 'trash', 'sessions', stamp, 'manifest.json'),
      'utf8',
    ),
  );
  assert.equal(manifest.entries.length, 2);
  assert.deepEqual(
    manifest.entries.map((e) => e.id).sort(),
    [ID.parent, ID.child].sort(),
  );

  const cache = path.join(home, 'storages', 'session_projcache', 'sessions');
  assert.ok(!fs.existsSync(path.join(cache, `${ID.parent}.json`)));
  assert.ok(!fs.existsSync(path.join(cache, `${ID.child}.json`)));
  assert.ok(fs.existsSync(path.join(cache, `${ID.other}.json`)));
});

test('delete --no-cascade keeps subagent children', (t) => {
  const { home, dirs } = seed(t);
  const r = run(['delete', 'aaaaaaaa', '--no-cascade', '--trash', '-y'], home);

  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(dirs.parent));
  assert.ok(fs.existsSync(dirs.child));
});

test('delete without --yes refuses in a non-interactive shell', (t) => {
  const { home, dirs } = seed(t);
  const r = run(['delete', 'aaaaaaaa'], home);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /非交互环境请加 --yes/);
  assert.ok(fs.existsSync(dirs.parent));
});

test('delete rejects unknown ids', (t) => {
  const { home } = seed(t);
  const r = run(['delete', 'zzzzzzzz', '--dry-run'], home);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /找不到会话/);
});

test('ambiguous prefixes are rejected with candidates', (t) => {
  const home = makeHome(t);
  writeSession(home, {
    id: 'session-dup11111-0000-4000-8000-000000000000',
    createdAt: 1,
  });
  writeSession(home, {
    id: 'session-dup22222-0000-4000-8000-000000000000',
    createdAt: 2,
  });

  const r = run(['delete', 'dup', '--dry-run'], home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /不唯一/);
});

test('list on an empty DSH_HOME is not an error', (t) => {
  const home = makeHome(t);
  const r = run(['list'], home);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /没有会话/);
});

test('list degrades to unknown liveness when lsof is missing', (t) => {
  const home = makeHome(t);
  writeSession(home, { id: ID.other, createdAt: 1, lock: true });

  const r = run(['list'], home, { PATH: makeEmptyPath(t) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /未找到 lsof/);
  assert.match(r.stdout, /活跃状态未知/);
  assert.match(r.stdout, /未知/);
});

test('delete without --force refuses when lsof is missing', (t) => {
  const home = makeHome(t);
  const dir = writeSession(home, { id: ID.other, createdAt: 1, lock: true });

  const r = run(['delete', 'cccccccc', '-y'], home, { PATH: makeEmptyPath(t) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /请改用 --force/);
  assert.ok(fs.existsSync(dir));
});

test('delete --force still works when lsof is missing', (t) => {
  const home = makeHome(t);
  const dir = writeSession(home, { id: ID.other, createdAt: 1, lock: true });

  const r = run(['delete', 'cccccccc', '--force', '-y'], home, {
    PATH: makeEmptyPath(t),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(dir));
});
