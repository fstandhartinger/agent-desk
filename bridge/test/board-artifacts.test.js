import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { entry } from '../src/board.js';

test('entry includes normalized artifact_ids; old schemas still resolve', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-artifacts-'));
  const original = process.env.AGENT_BOARD_DB;
  t.after(() => {
    if (original === undefined) delete process.env.AGENT_BOARD_DB;
    else process.env.AGENT_BOARD_DB = original;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const db = path.join(dir, 'board#test.db');
  process.env.AGENT_BOARD_DB = db;
  execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.executescript("CREATE TABLE threads(id INTEGER,title TEXT); CREATE TABLE entries(id INTEGER,thread_id INTEGER,author TEXT,kind TEXT,created_at TEXT,body TEXT); INSERT INTO threads VALUES(1,'Example'); INSERT INTO entries VALUES(2,1,'codex:test','note','2026-10-31','Plain text')")
c.commit()`, db]);
  const before = fs.readFileSync(db);
  assert.deepEqual((await entry({ id: 2 })).artifact_ids, []);
  assert.deepEqual(fs.readFileSync(db), before);
  execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("ALTER TABLE entries ADD COLUMN artifact_ids TEXT NOT NULL DEFAULT '[]'")
c.execute('UPDATE entries SET artifact_ids=?', ('["B8C3FF","00ff12","B8C3FF","invalid"]',))
c.commit()`, db]);
  const row = await entry({ id: 2 });
  assert.deepEqual(row.artifact_ids, ['b8c3ff', '00ff12']);
  assert.equal(row.text, 'Plain text');
  assert.equal(row.thread, 'Example');
  await assert.rejects(entry({ id: 999 }), /not found/);
  execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute("UPDATE entries SET artifact_ids='broken'"); c.commit()`, db]);
  assert.deepEqual((await entry({ id: 2 })).artifact_ids, []);
});
