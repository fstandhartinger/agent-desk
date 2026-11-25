#!/usr/bin/env python3
"""desk-source-registry — the Agent Desk "Wissenslandkarte" (job agent-desk-research-upgrade-20261125).

Builds ~/desk-knowledge/sources/ on Sandy and mirrors it to LeChonk:
  registry.json   topic -> authoritative sources (path/URL/MCP tool + how to use it), read by the desk research agent
  REGISTRY.md     the same as Markdown (for people and agents)
  live/*.md       snapshots of the PUBLIC REAX MCP docs (training rules every clause, FAQ, schedule, status, inference rules)
  copies/*.md     files the desk bridge may not read in place (DECISIONS-DIGEST, KNOWLEDGE-INDEX)
  decisions-recent.md  DECISIONS headings of the last 21 days with line numbers and keys

Run by the systemd user timer desk-source-registry.timer (every 30 min). Safe to run by hand. No secrets are read.
Curated topics live in CURATED below: change a line when the source of truth moves.
"""
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

HOME = Path('/home/flori')
OUT = HOME / 'desk-knowledge' / 'sources'
JOBS = HOME / 'jobs'
MCP = 'https://mcp.reax.co/mcp'
NOW = dt.datetime.now(dt.timezone.utc)
STAMP = NOW.strftime('%Y-%m-%dT%H:%MZ')
SECRETISH = re.compile(r'(api[_-]?key|secret|token|passw|iban|bic\b|sk-[A-Za-z0-9]{8}|bearer |private key|seed phrase|mnemonic)', re.I)

# ---------------------------------------------------------------- curated map (edit here when a source of truth moves)
# kind: live (MCP snapshot file), mcp (call reax_docs), file, dir, cmd (topic-status), decision (DECISIONS key/grep), board, code
CURATED = [
    {
        'key': 'reax-training-rules', 'title': 'SN92 Trainings-Wettbewerb (Generalist, Runde 2): Regeln, Podium, Holder, Auszahlung, Lineage, Fenster',
        'keywords': ['regel', 'rules', 'podium', 'podiumsplatz', 'platz 2', 'platz 3', 'champion', 'krone', 'crown', 'holder', 'halter', 'entwickler',
                     'uid', 'coldkey', 'hotkey', 'lineage', 'parent', 'eltern', 'bar', 'marge', 'margin', 'fenster', 'window', 'draw', 'ziehung',
                     'runde 2', 'round 2', 'generalist', 'wettbewerb', 'competition', 'miner', 'mining', 'auszahlung', 'payout', 'share', 'anteil',
                     'burn', 'verbrannt', 'copy', 'kopie', 'reveal', 'commit', 'intake', 'faq', 'held-out', 'preview', 'dethroned', 'entthront', 'sn92', 'reax'],
        'playbook': 'Regelfrage: ZUERST reax_docs (training_get_rules mit query, oder reax_search_docs) bzw. live/training-rules.md lesen und die Klausel-Nummer zitieren. Die Live-Regeln schlagen Erklärseiten, Entwürfe und frozen/-Kopien. Danach DECISIONS für Florians spätere Entscheidungen (neuer datierter Eintrag schlägt Regeltext nur, wenn er die Regel ausdrücklich ändert).',
        'sources': [
            {'label': 'Live-Regeln (MCP training_get_rules, jede Klausel)', 'kind': 'live', 'ref': str(OUT / 'live' / 'training-rules.md'), 'how': 'read_file + Klausel suchen (z. B. "One podium place per holder", "2.9 Holder") oder reax_docs training_get_rules query'},
            {'label': 'Live-FAQ (MCP reax_get_faq)', 'kind': 'live', 'ref': str(OUT / 'live' / 'faq.md'), 'how': 'read_file; Status LIVE ist verbindlich, PENDING nicht'},
            {'label': 'Zeitplan / Status der Runde (MCP)', 'kind': 'live', 'ref': str(OUT / 'live' / 'training-schedule.md'), 'how': 'Termine in UTC'},
            {'label': 'MCP direkt', 'kind': 'mcp', 'ref': 'reax_docs: training_get_rules, training_get_rules_changes, training_list_rule_versions, reax_search_docs, reax_get_faq, training_get_schedule, training_get_status, training_get_leaderboard, training_get_results', 'how': 'öffentlich, nur lesen'},
            {'label': 'Status Runde 2 (stündlich)', 'kind': 'file', 'ref': str(JOBS / 'topic-status' / 'topics' / 'round2.md'), 'how': 'Stand, Zahlen, Belege'},
            {'label': 'Build-Job Runde 2 (Regel-Entwürfe, Kit, MCP)', 'kind': 'dir', 'ref': str(JOBS / 'generalist-round2-build-20261113'), 'how': 'STATE.md (neueste Zeilen unten), RULES-DIFF*.md; frozen/ = alte Stände, NICHT aktuell'},
            {'label': 'Competition Manager', 'kind': 'dir', 'ref': str(JOBS / 'sn92-competition-manager'), 'how': 'STATE.md, Entscheidungen zu Podium und Goodwill'},
            {'label': 'Release-Owner (Regeln/FAQ/Posts)', 'kind': 'dir', 'ref': str(JOBS / 'sn92-fast-launch-20261015'), 'how': 'STATE.md, posts/'},
            {'label': 'Code: Fenster-Kit Runde 2 (Podium, Award, Bar)', 'kind': 'code', 'ref': str(JOBS / 'gr2-window-2026-11-26' / 'kit' / 'window' / 'windowkit'), 'how': 'podium.py (Podium-Vergabe, ein Platz pro Holder), award.py; shell rg -n "holder" oder read_file'},
            {'label': 'Board #22 System1 Models + REAX', 'kind': 'board', 'ref': 'board 22', 'how': 'search source "board" oder board_read 22'},
        ],
    },
    {
        'key': 'reax-inference-mining', 'title': 'SN92 Inference Mining v2 (Portfolio, Regeln, Auszahlung an Inference-Miner)',
        'keywords': ['inference', 'inferenz', 'portfolio', 'serving', 'pot', 'inference miner', 'inference mining', 'tokens', 'durchsatz'],
        'playbook': 'Regelfrage Inference: reax_docs inference_get_rules / live/inference-rules.md zuerst; Status: topic-status inference.',
        'sources': [
            {'label': 'Live-Regeln Inference (MCP inference_get_rules)', 'kind': 'live', 'ref': str(OUT / 'live' / 'inference-rules.md'), 'how': 'read_file'},
            {'label': 'MCP direkt', 'kind': 'mcp', 'ref': 'reax_docs: inference_get_rules, inference_get_portfolio, inference_list_portfolio_changes', 'how': 'öffentlich, nur lesen'},
            {'label': 'Status Inference-Track', 'kind': 'file', 'ref': str(JOBS / 'topic-status' / 'topics' / 'inference.md'), 'how': 'Stand und Belege'},
        ],
    },
    {
        'key': 'payouts-goodwill-emissions', 'title': 'Auszahlungen, Goodwill/Kulanz, Keep-alive, Emissionen an Miner',
        'keywords': ['goodwill', 'kulanz', 'keep-alive', 'keepalive', 'auszahlung', 'payout', 'emission', 'alpha', 'award', 'belohnung', 'reward',
                     'make-good', 'nachzahlung', 'pool', 'burn', 'uid 0', 'geldkarte', 'money card'],
        'playbook': 'Was gilt: DECISIONS (neueste zuerst, Key grep) + Live-Regeln (Unfilled places / Pool). "leaning yes, NOT yet approved" ist KEIN Beschluss.',
        'sources': [
            {'label': 'DECISIONS (neueste zuerst)', 'kind': 'decision', 'ref': str(HOME / 'DECISIONS.md'), 'how': 'search source "entscheidungen" mit goodwill/podium/keep-alive; Abschnitt lesen'},
            {'label': 'Standing decisions nach Thema', 'kind': 'file', 'ref': str(OUT / 'copies' / 'DECISIONS-DIGEST.md'), 'how': 'read_file'},
            {'label': 'Live-Regeln: Unfilled places, split per entry', 'kind': 'live', 'ref': str(OUT / 'live' / 'training-rules.md'), 'how': 'Klauseln zu "Unfilled places", "The split is per entry"'},
            {'label': 'Goodwill-Pool-Worker', 'kind': 'dir', 'ref': str(JOBS / 'generalist-round2-build-20261113' / 'workers' / 'gr2-goodwill-pool-1124'), 'how': 'RESULT.md'},
            {'label': 'Status Runde 2', 'kind': 'file', 'ref': str(JOBS / 'topic-status' / 'topics' / 'round2.md'), 'how': 'Goodwill-Stand'},
        ],
    },
    {
        'key': 'gpu-tee-providers', 'title': 'GPUs, TEE, Anbieter-Regeln, GPU-Kosten',
        'keywords': ['gpu', 'tee', 'lium', 'runpod', 'shadeform', 'verda', 'upcloud', 'lambda', 'nebius', 'pod', 'broker', 'gpu-lease', 'sealed', 'vertraulich', 'h100', 'b200', 'gpu-kosten'],
        'playbook': 'Anbieter-Regel: AGENTS.md Abschnitt 3 "GPUs" + Skill gpu-pod-management; Kosten: desk-knowledge/exports/gpu-ledger.md.',
        'sources': [
            {'label': 'AGENTS.md Abschnitt 3 GPUs', 'kind': 'file', 'ref': str(HOME / 'AGENTS.md'), 'how': 'read_core_doc AGENTS, Absatz "**GPUs:**"'},
            {'label': 'Skill gpu-pod-management', 'kind': 'file', 'ref': str(HOME / '.agents' / 'skills' / 'gpu-pod-management' / 'SKILL.md'), 'how': 'skill_read gpu-pod-management'},
            {'label': 'GPU-Ledger (stündlich)', 'kind': 'file', 'ref': str(HOME / 'desk-knowledge' / 'exports' / 'gpu-ledger.md'), 'how': 'read_file (LeChonk)'},
        ],
    },
    {
        'key': 'finance-tax', 'title': 'Finanzen, const, Owner-Emissionen, Steuer (nur freigegebene Fakten)',
        'keywords': ['steuer', 'steuerprotokoll', 'steuerledger', 'rücklage', 'geldbewegung', 'tax', 'finanz', 'finance', 'const', 'owner', 'tranche', 'unstake', 'wallet', 'einkommen', 'umsatz', 'revenue', 'kosten', 'ledger', 'tao', 'kraken'],
        'playbook': 'Nur Fakten aus Status/Entscheidungen/Ledger nennen, nie schätzen; Geldbewegungen: ledger_spend. Keine Kontodaten.',
        'sources': [
            {'label': 'Status Finanzen und const', 'kind': 'file', 'ref': str(JOBS / 'topic-status' / 'topics' / 'finance.md'), 'how': 'read_file'},
            {'label': 'Desk-Wissen Owner-Emissionen/Steuer', 'kind': 'file', 'ref': str(HOME / 'desk-knowledge' / 'topics' / 'owner-emissions-tax.md'), 'how': 'knowledge_read "Steuer"'},
            {'label': 'Ledger', 'kind': 'mcp', 'ref': 'ledger_spend', 'how': 'Zeitraum + groupBy'},
            {'label': 'Standing decisions', 'kind': 'file', 'ref': str(OUT / 'copies' / 'DECISIONS-DIGEST.md'), 'how': 'Abschnitt Geld/Owner'},
        ],
    },
    {
        'key': 'servers-infra', 'title': 'Server (Sandy, LeChonk, sandy-prod), Coolify, Deploys',
        'keywords': ['server', 'sandy', 'lechonk', 'sandy-prod', 'coolify', 'deploy', 'hetzner', 'disk', 'ram', 'wireguard', 'postgres', 'infra'],
        'playbook': 'Rollen: AGENTS.md Abschnitt 0; Live-Zustand: run_readonly disk/jobs_running; Status infra.',
        'sources': [
            {'label': 'AGENTS.md Abschnitt 0 Server', 'kind': 'file', 'ref': str(HOME / 'AGENTS.md'), 'how': 'read_core_doc AGENTS'},
            {'label': 'Status Server und Infrastruktur', 'kind': 'file', 'ref': str(JOBS / 'topic-status' / 'topics' / 'infra.md'), 'how': 'read_file'},
            {'label': 'Wo ist was', 'kind': 'file', 'ref': str(OUT / 'copies' / 'KNOWLEDGE-INDEX.md'), 'how': 'read_file'},
        ],
    },
    {
        'key': 'agent-desk', 'title': 'Agent Desk, Screen Agent, Sprachassistent (Code, Sitzungen)',
        'keywords': ['desk', 'agent desk', 'screen agent', 'voice', 'sprachassistent', 'recherche', 'gateway', 'bridge', 'gpt-live', 'gemini live', 'grok'],
        'playbook': 'Live-Zustand: desk_status, session_trace; Code: /home/flori/work/agent-desk (gateway/src, bridge/src).',
        'sources': [
            {'label': 'Code Agent Desk', 'kind': 'code', 'ref': str(HOME / 'work' / 'agent-desk'), 'how': 'code_outline gateway/src; read_file'},
            {'label': 'Status Agent Desk', 'kind': 'file', 'ref': str(JOBS / 'topic-status' / 'topics' / 'desk.md'), 'how': 'read_file'},
        ],
    },
    {
        'key': 'jobs-status', 'title': 'Laufende Jobs und Themenstände (was läuft, wie steht es)',
        'keywords': ['job', 'jobs', 'status', 'stand', 'läuft', 'fertig', 'ergebnis', 'result', 'state', 'wie steht'],
        'playbook': 'Themenstand: topic-status-Datei des Themas; einzelner Job: job_status(name) oder STATE.md/RESULT.md lesen.',
        'sources': [
            {'label': 'Themenstände (stündlich)', 'kind': 'dir', 'ref': str(JOBS / 'topic-status' / 'topics'), 'how': '<thema>.md: round2, hfdi-reax14, surrogate, training-lab, jevbench, inference, growth, customers, infra, finance, desk, other'},
            {'label': 'Jobs', 'kind': 'cmd', 'ref': 'job_status / list_jobs', 'how': 'Name oder Teil des Namens'},
        ],
    },
]

TOPIC_STATUS_KEYWORDS = {
    'round2': ['runde 2', 'round 2', 'generalist', 'draw', 'ziehung', 'zweite ziehung', 'bestätigungsrunde', 'bestaetigungsrunde', 'bestätigt', 'spitze', 'sieve', 'backstop', 'podium', 'w1', 'window', 'fenster 1', 'marge', 'draw-2', 'danyloooah'],
    'hfdi-reax14': ['hf di', 'hfdi', 'decision index', 'reax 1.4', 'reax14', 'huggingface', 'karpo', '0.3-lauf', '0.3 lauf', 'duo', 'd3-ultra', 'surrogat', 'kendall'],
    'surrogate': ['surrogat', 'surrogate', 'benchmark-lauf', 'rk-hard', 'kendall', 'v4', 'leave-one'],
    'training-lab': ['trainings-lab', 'training lab', 'training', 'lab'],
    'jevbench': ['jevbench', 'benchmark heaven', 'benchmarkheaven', 'leaderboard'],
    'inference': ['inference', 'inferenz'],
    'growth': ['growth', 'seo', 'marketing', 'x.com', 'tweet'],
    'customers': ['kunde', 'kunden', 'customer', 'system1', 'decisionmodels'],
    'infra': ['server', 'infra'],
    'finance': ['finanz', 'const', 'geld'],
    'desk': ['desk', 'screen agent'],
    'other': [],
}


def mcp_call(name, args=None, timeout=40):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': args or {}}}).encode()
    req = urllib.request.Request(MCP, data=body, headers={'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'user-agent': 'desk-source-registry/1'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode('utf-8', 'replace')
    lines = [l[5:].strip() if l.startswith('data:') else l.strip() for l in raw.splitlines() if l.strip()]
    for l in reversed(lines):
        if l.startswith('{'):
            d = json.loads(l)
            res = d.get('result') or {}
            if res.get('isError'):
                raise RuntimeError(f'{name}: error result')
            return res.get('structuredContent') or res
    raise RuntimeError(f'{name}: no JSON in reply')


def write_atomic(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.tmp-')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(text)
    os.chmod(tmp, 0o640)
    os.replace(tmp, path)


def live_snapshots(status):
    live = OUT / 'live'
    head = lambda title, meta: f'# {title}\nQuelle: {MCP} (öffentlich, live) · abgerufen {STAMP} · {meta}\nDiese Datei ist eine Kopie der LIVE-Quelle; bei Zweifel reax_docs aufrufen.\n\n'
    try:
        r = mcp_call('training_get_rules')
        meta = f"Version {r.get('version')} · gültig ab {r.get('effective_from_utc')} · sha256 {str(r.get('sha256'))[:12]}"
        body = '\n'.join(f"### [{s.get('id')}] {s.get('title', '')}\n{s.get('text', '')}\n" for s in r.get('sections', []))
        write_atomic(live / 'training-rules.md', head('SN92 Trainings-Wettbewerb: geltende Regeln (jede Klausel)', meta) + body)
        status['training_rules'] = r.get('version')
    except Exception as e:  # keep the old snapshot
        status['training_rules_error'] = str(e)[:200]
    try:
        r = mcp_call('reax_get_faq')
        items = r.get('items', [])
        body = '\n'.join(f"### {i.get('question', '')}  (#{i.get('anchor', '')}, Status {i.get('status', 'LIVE')})\n{i.get('answer', '')}\n" for i in items)
        write_atomic(live / 'faq.md', head('REAX Miner-FAQ', f"FAQ {r.get('faq_version')} · Regeln {r.get('rules_version')} · {len(items)} Einträge") + body)
        status['faq'] = r.get('faq_version')
    except Exception as e:
        status['faq_error'] = str(e)[:200]
    for name, title, fname in [('training_get_schedule', 'Zeitplan Trainings-Wettbewerb (UTC)', 'training-schedule.md'),
                               ('training_get_status', 'Status Trainings-Wettbewerb', 'training-status.md'),
                               ('training_list_rule_versions', 'Regel-Versionen', 'rule-versions.md'),
                               ('get_overview', 'REAX MCP Überblick', 'overview.md')]:
        try:
            r = mcp_call(name)
            write_atomic(live / fname, head(title, name) + '```json\n' + json.dumps(r, ensure_ascii=False, indent=1)[:60000] + '\n```\n')
        except Exception as e:
            status[f'{name}_error'] = str(e)[:200]
    try:
        r = mcp_call('inference_get_rules')
        body = '\n'.join(f"### [{s.get('id')}] {s.get('title', '')}\n{s.get('text', '')}\n" for s in r.get('sections', []))
        write_atomic(live / 'inference-rules.md', head('SN92 Inference Mining: Regeln', f"Version {r.get('rules_version')} · Stand {r.get('as_of')}") + body)
        status['inference_rules'] = r.get('rules_version')
    except Exception as e:
        status['inference_rules_error'] = str(e)[:200]


def copies():
    for src, name in [(HOME / 'DECISIONS-DIGEST.md', 'DECISIONS-DIGEST.md'), (HOME / 'AGENTS.d' / 'KNOWLEDGE-INDEX.md', 'KNOWLEDGE-INDEX.md')]:
        try:
            text = src.read_text(encoding='utf-8')
            text = '\n'.join(l for l in text.splitlines() if not SECRETISH.search(l))
            write_atomic(OUT / 'copies' / name, f'<!-- Kopie von {src}, {STAMP} -->\n' + text + '\n')
        except Exception:
            pass


def decisions_recent(days=10):
    out, n = [], 0
    cutoff = (NOW - dt.timedelta(days=days)).strftime('%Y-%m-%d')
    key_re = re.compile(r'^Key:\s*(\S+)')
    cur = None
    with open(HOME / 'DECISIONS.md', encoding='utf-8', errors='replace') as f:
        for i, line in enumerate(f):
            if line.startswith('## 20'):
                d = line[3:13]
                if d < cutoff:
                    break
                cur = {'line': i, 'head': line[3:].strip()[:200], 'key': ''}
                out.append(cur)
            elif cur and not cur['key']:
                m = key_re.match(line)
                if m:
                    cur['key'] = m.group(1)
    rows = [f"- L{d['line']}: {d['head']}" + (f" (Key {d['key']})" if d['key'] else '') for d in out]
    write_atomic(OUT / 'decisions-recent.md', f'# DECISIONS der letzten {days} Tage (neueste zuerst)\nQuelle: /home/flori/DECISIONS.md, Zeilennummern 0-basiert für read_file offset · {STAMP}\n\n' + '\n'.join(rows) + '\n')
    return out


def topic_status_entries():
    entries = []
    tdir = JOBS / 'topic-status' / 'topics'
    for f in sorted(tdir.glob('*.md')):
        key = f.stem
        try:
            text = f.read_text(encoding='utf-8')
        except Exception:
            continue
        title = (text.splitlines() or [''])[0].lstrip('# ').strip()
        jobs = sorted(set(re.findall(r'/home/flori/jobs/([A-Za-z0-9._-]+)', text)))[:12]
        board = sorted(set(re.findall(r'#(\d{5})', text)), reverse=True)[:6]
        srcs = [{'label': f'Themenstand {title}', 'kind': 'file', 'ref': str(f), 'how': 'read_file; "Belege bis" nennt die Quellen'}]
        srcs += [{'label': f'Job {j}', 'kind': 'dir', 'ref': str(JOBS / j), 'how': 'STATE.md / RESULT.md'} for j in jobs if (JOBS / j).exists()]
        if board:
            srcs.append({'label': 'Board-Einträge im Stand', 'kind': 'board', 'ref': ', '.join('#' + b for b in board), 'how': 'board_entry'})
        entries.append({'key': f'status-{key}', 'title': title, 'keywords': TOPIC_STATUS_KEYWORDS.get(key, []) + [key], 'playbook': 'Stand: diese Datei zuerst (stündlich); Zahlen an der genannten Quelle prüfen.', 'sources': srcs})
    return entries


def canonical_code():
    """'Canonical <thing> = <path>' lines in recent STATE.md files: where the current code of a job lives."""
    found = {}
    cutoff = NOW.timestamp() - 21 * 86400
    for st in JOBS.glob('*/STATE.md'):
        try:
            if st.stat().st_mtime < cutoff:
                continue
            text = st.read_text(encoding='utf-8', errors='replace')
        except Exception:
            continue
        for m in re.finditer(r'Canonical ([A-Za-z0-9 _-]{2,40}?) (?:tree )?(?:= ?)?`?((?:/home/flori/|workers/|kit/|for-)[A-Za-z0-9_./-]+)`?', text):
            what, rel = m.group(1).strip(), m.group(2).rstrip('.,;)')
            p = Path(rel) if rel.startswith('/') else st.parent / rel
            if p.exists():
                found[f'{st.parent.name}:{what}'] = {'label': f'Code: {what} ({st.parent.name}, letzter Stand)', 'kind': 'code', 'ref': str(p), 'how': 'code_outline / read_file / shell rg'}
    return list(found.values())


def explainer_entries():
    out = []
    cutoff = NOW.timestamp() - 10 * 86400
    for d in sorted(JOBS.glob('*explainer*'), key=lambda p: p.stat().st_mtime, reverse=True):
        if d.stat().st_mtime < cutoff:
            continue
        files = []
        for pat in ['page*/sources.json', 'page*/deepdive.md', 'FACTS.md', 'RESULT.md']:
            files += [p for p in d.glob(pat)]
        if not files:
            continue
        out.append({'label': f'Erklärvideo {d.name}', 'kind': 'dir', 'ref': str(d), 'how': 'Belege: ' + ', '.join(str(p.relative_to(d)) for p in files[:6])})
        if len(out) >= 25:
            break
    return out


def main():
    status = {'built': STAMP}
    OUT.mkdir(parents=True, exist_ok=True)
    live_snapshots(status)
    copies()
    dec = decisions_recent()
    topics = [dict(t) for t in CURATED]
    code = canonical_code()
    for t in topics:
        if t['key'] == 'reax-training-rules':
            t['sources'] = t['sources'] + [c for c in code if any(w in c['ref'] for w in ('generalist-round2', 'sn92', 'gr2', 'reax'))][:8]
    topics.append({'key': 'decisions', 'title': 'Florians Entscheidungen (neueste zuerst)', 'keywords': ['entschieden', 'entscheidung', 'decision', 'beschluss', 'beschlossen', 'freigabe', 'go'],
                   'playbook': 'decisions_recent für heute/gestern; sonst decisions-recent.md (Überschriften mit Zeile) und dann read_file DECISIONS.md ab der Zeile.',
                   'sources': [{'label': 'DECISIONS letzte 21 Tage (Überschriften + Zeile + Key)', 'kind': 'file', 'ref': str(OUT / 'decisions-recent.md'), 'how': 'read_file, dann DECISIONS.md offset=Zeile'},
                               {'label': 'DECISIONS.md', 'kind': 'decision', 'ref': str(HOME / 'DECISIONS.md'), 'how': 'read_file offset'},
                               {'label': 'Standing decisions nach Thema', 'kind': 'file', 'ref': str(OUT / 'copies' / 'DECISIONS-DIGEST.md'), 'how': 'read_file'}]})
    topics += topic_status_entries()
    ex = explainer_entries()
    if ex:
        topics.append({'key': 'explainers', 'title': 'Erklärvideos der letzten 10 Tage (Fakten, Belege, Nachrecherche)', 'keywords': ['erklärvideo', 'video', 'erklärseite', 'explainer'], 'playbook': 'sources.json einer Seite: Aussage -> Quelle; dig_deeper -> wo weiterlesen.', 'sources': ex})
    if code:
        topics.append({'key': 'code', 'title': 'Aktueller Code der Jobs (Validator, Scoring, Kit, MCP)', 'keywords': ['code', 'validator', 'scoring', 'kit', 'quellcode', 'implementierung', 'skript'], 'playbook': 'Pfad aus der Liste nehmen, dann shell rg / read_file. Ältere Kopien (frozen/, bak) sind nicht aktuell.', 'sources': code[:40]})
    reg = {'v': 1, 'built': STAMP, 'status': status, 'root': str(OUT), 'topics': topics,
           'rule': 'Sag nie "keine Quelle gefunden", bevor die Quellen des passenden Themas hier gelesen wurden. Live-Quellen (MCP) schlagen Erklärseiten, Entwürfe und frozen/-Kopien.'}
    write_atomic(OUT / 'registry.json', json.dumps(reg, ensure_ascii=False, indent=1) + '\n')
    md = [f'# Wissenslandkarte des Agent Desk (Stand {STAMP})', '', reg['rule'], '', 'Gebaut von ~/bin/desk-source-registry (Timer alle 30 min). Live-Snapshots: ' + json.dumps(status, ensure_ascii=False), '']
    for t in topics:
        md += [f"## {t['title']}  (`{t['key']}`)", f"Vorgehen: {t['playbook']}", 'Stichwörter: ' + ', '.join(t['keywords'][:20]), '']
        md += [f"- **{s['label']}** — `{s['ref']}` — {s['how']}" for s in t['sources']]
        md.append('')
    write_atomic(OUT / 'REGISTRY.md', '\n'.join(md))
    # mirror to LeChonk (the map index and LeChonk-routed reads see the same files)
    if '--no-sync' not in sys.argv:
        subprocess.run(['rsync', '-a', '--delete', '--timeout=60', str(OUT) + '/', 'lechonk:/home/flori/desk-knowledge/sources/'], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    print(f'desk-source-registry: {len(topics)} topics, {sum(len(t["sources"]) for t in topics)} sources, decisions {len(dec)}, status {json.dumps(status)}')


if __name__ == '__main__':
    main()
