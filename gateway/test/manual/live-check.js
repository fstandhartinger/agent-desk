// Manual end-to-end check against the real OpenRouter and the real explainer origin, with a fake bridge.
// Usage: OPENROUTER_API_KEY=... node test/manual/live-check.js "question"
import { readFileSync } from 'node:fs';
import { CODE, connectFakeBridge, login, setEnv, startGateway } from '../helpers/env.js';

const question = process.argv[2] || 'Was steht in AGENTS.md über LeChonk?';
setEnv({ OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, DESK_VIZ_GRACE_MS: '0' });
delete process.env.EXPLAINER_ORIGIN;

const gw = await startGateway();
const { cookie } = await login(gw.base);
const bridge = await connectFakeBridge(gw.port, {
  'ctx.core': ({ name }) => readFileSync(`/home/flori/${name}.md`, 'utf8').slice(0, 40_000),
  'ctx.search': () => [],
});

const proxied = await fetch(`${gw.base}/api/explainer/engine-crowning-rxpjnm2ehx/points.json`, { headers: { cookie } });
const points = await proxied.json();
console.log('explainer points.json:', proxied.status, `${Object.keys(points.points).length} points,`, `title "${points.page.title}"`);

const started = performance.now();
const res = await fetch(`${gw.base}/api/chat`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ conversationId: 'live', messages: [{ role: 'user', content: question }] }),
});
let buffer = '';
let text = '';
for await (const chunk of res.body) {
  buffer += Buffer.from(chunk).toString();
  let idx;
  while ((idx = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const data = block.split('\n').find((l) => l.startsWith('data:'));
    if (!data) continue;
    const ev = JSON.parse(data.slice(5));
    const t = `${Math.round(performance.now() - started)} ms`;
    if (ev.type === 'delta') {
      if (!text) console.log(`first token @ ${t}`);
      text += ev.text;
    } else console.log(t, JSON.stringify(ev).slice(0, 300));
  }
}
console.log('--- answer ---\n' + text);
bridge.ws.close();
gw.close();
setTimeout(() => process.exit(0), 100);
