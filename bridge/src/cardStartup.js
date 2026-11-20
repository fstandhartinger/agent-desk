import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { cardRead } from './notify.js';
import { HOME, isDenied, jobsRoot, resolveAllowed } from './paths.js';
import { redact } from './redact.js';

// Reuse the board's open-ack and address resolution rules in its read-only mode.
const CONTEXT = `
import json, pathlib, re, runpy, sqlite3, sys
home, jobs, card, aid, source = sys.argv[1:]
home, jobs = pathlib.Path(home), pathlib.Path(jobs).resolve()
out = {}
registered = None
try:
    with sqlite3.connect((home / '.notify/reply-actions.sqlite3').as_uri() + '?mode=ro', uri=True, timeout=.25) as c:
        row = c.execute('SELECT job_dir, status, substr(reply_text,1,600), reply_kind, done_at FROM actions WHERE ask_id=? AND channel IN (?,?)', (card, 'telegram', 'tg')).fetchone()
    if row:
        registered, status, reply, kind, done = row
        out['reply'] = dict(status=status, text=reply, kind=kind, done=bool(done))
except sqlite3.Error:
    pass
name = pathlib.Path(registered).name if registered else source.rsplit(':',1)[-1].strip()
owner = None
if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,119}', name) and '..' not in name:
    d = jobs / name
    if d.resolve() == d and d.is_dir() and (not registered or pathlib.Path(registered).resolve() == d):
        owner = d
        out['job'] = {'name': name}
try:
    m = runpy.run_path(str(home / 'bin/agent-board'))
    board = m['Board'](read_only=True)
    entries = []
    with board.reading() as conn:
        groups = board._groups(conn)
        aliases = {name, m['strip_date'](name)} if owner else set()
        for row in conn.execute('SELECT agent FROM agents WHERE jobdir=?', (str(owner),)) if owner else ():
            aliases.update(m['agent_aliases'](row['agent'], str(owner)))
        placeholders = ','.join('?' for _ in aliases) or 'NULL'
        candidates = conn.execute(
            'SELECT e.* FROM entries e WHERE ack_required=1 AND (artifact_ids LIKE ? OR body LIKE ? '
            'OR id IN (SELECT entry_id FROM entry_addresses WHERE address IN (' + placeholders + '))) ORDER BY e.id DESC LIMIT 40',
            ('%"' + aid + '"%' if aid else '', '%' + card + '%', *aliases)).fetchall()
        for item in candidates:
            artifact_ids = json.loads(item['artifact_ids'] or '[]')
            body = item['body']
            ack = board._ack_status(conn, item, groups)
            if ack['state'] == 'open' and ((aid and aid in artifact_ids)
                or re.search(r'(?i)\\b(?:karte\\s+|card[ :]+)' + card + r'\\b', body)
                or aliases.intersection(ack['missing'])
            ):
                entries.append(dict(id=item['id'], text=body[:400]))
                if len(entries) == 3:
                    break
    out['board'] = entries
except (OSError, sqlite3.Error, ValueError, KeyError):
    pass
print(json.dumps(out))
`;
const exec = promisify(execFile);

export async function cardStartup({ id, aid } = {}) {
  const card = await cardRead({ id, includeState: true });
  if (aid !== undefined && (!/^[0-9a-f]{6}$/.test(aid) || card.aid !== aid)) return null;
  let related = {};
  try {
    const { stdout } = await exec('python3', ['-I', '-c', CONTEXT, HOME, jobsRoot(), id, card.aid ?? '', card.source], {
      timeout: 1000, maxBuffer: 32 * 1024,
    });
    related = JSON.parse(stdout);
  } catch { /* A slow or missing auxiliary store must not block a voice session. */ }
  if (related.job && isDenied(related.job.name)) delete related.job;
  if (related.job) {
    const root = jobsRoot();
    await Promise.all([['state', 'STATE.md', 2000, true], ['result', 'RESULT.md', 1200, false]].map(async ([key, name, size, tail]) => {
      try {
        const file = resolveAllowed(path.join(root, related.job.name, name));
        const fd = await fs.open(file, 'r');
        try {
          const st = await fd.stat();
          if (!st.isFile()) return;
          const bytes = Buffer.alloc(size);
          const { bytesRead } = await fd.read(bytes, 0, size, tail ? Math.max(0, st.size - size) : 0);
          related.job[key] = redact(bytes.toString('utf8', 0, bytesRead));
        } finally { await fd.close(); }
      } catch { /* The file may be missing or outside the Desk read scope. */ }
    }));
  }
  if (related.reply?.text) related.reply.text = redact(related.reply.text);
  for (const entry of related.board ?? []) entry.text = redact(entry.text);
  return { ...card, ...related };
}
