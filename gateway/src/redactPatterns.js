// Shared secret scrubbing (docs/UPGRADES-1028.md §4). This file exists twice, byte-identical:
// gateway/src/redactPatterns.js and bridge/src/redactPatterns.js (the gateway image ships without bridge/).
// gateway/test/redact-sync.test.js fails when the two copies differ. Edit both together.

const R = '[REDACTED]';

// Secret-looking key words in lower, Capitalized and UPPER case (no /i flag, so camelCase boundaries stay visible:
// `privateKey`, `clientSecret` and `ABLITERATION_API_KEY` match, `keyboard`, `passengers` and `PASSED` do not).
// `key` has no plural form here: `keys` / `resolved-keys` are lists of names, not secrets (critic round 3, P1-3).
const KEY_WORDS = ['key', 'token', 'secret', 'password', 'passwd', 'pass', 'pwd', 'fingerprint', 'auth', 'credential', 'credentials', 'cookie', 'session', 'passphrase'];
// Weak words name modes, ids and results far more often than secrets (`auth: StaleRequest`, `sessionId`, `PASS: …`); plurals
// name counts (`max_tokens`). A key made only of weak words needs a value that clearly looks random.
const WEAK_WORDS = new Set(['pass', 'session', 'auth']);
const STRONG_WORDS = KEY_WORDS.filter((w) => !WEAK_WORDS.has(w));
const cased = (w) => {
  const pl = w === 'key' ? '' : 's?';
  return [`${w}${pl}(?![a-z])`, `${w[0].toUpperCase()}${w.slice(1)}${pl}(?![a-z])`, `${w.toUpperCase()}${pl.toUpperCase()}(?![A-Za-z])`];
};
const KEY_WORD = `(?:${[...KEY_WORDS].sort((a, b) => b.length - a.length).flatMap(cased).join('|')})`;
// Public keys (Bittensor hot/cold keys, pubkeys) are addresses, not secrets.
// Key names are bounded (80 chars): unbounded lazy scans made a 200 kB run of dashes cost minutes (critic round 4, ReDoS).
const NOT_PUBLIC = '(?![\\w.-]{0,80}?(?:[Hh]ot|[Cc]old|[Pp]ub|[Pp]ublic[_-]?)(?:key|Key)(?![a-z]))(?![\\w.-]{0,80}?(?:HOT|COLD|PUB|PUBLIC_?)KEY(?![A-Za-z]))';
// A whole key that contains one of the words: ABLITERATION_API_KEY, api_key, privateKey, x-auth-token (never ends in . or -)
const SECRET_KEY = `${NOT_PUBLIC}[\\w.-]{0,80}?${KEY_WORD}(?:[\\w.-]{0,80}\\w)?`;
// A bare "key" is a group-by / map field far more often than a secret ({"key": "LLM-APIs"}); vendor prefixes still catch keys there.
const NOT_BARE = `(?!(?:key|Key|KEY)s?(?![\\w.-]))`;

// Critic round 7, P2-1: the unquoted key rules started at every position after a non-word char, so a 200 kB run of "-" or
// "a.a.a…" ran NOT_PUBLIC and the 80-char key scan once per char. They now start at the beginning of a [\w.-] token only and
// may skip a prefix of the token that ends in "." or "-" ("hotkey.secret", "pubkey-api-token" keep their old matches; the
// prefix stays in the label, so the output is the same).
const KEY_START = '(?<![\\w.-])(?:[\\w.-]{0,160}?[.-])??';

/** Split a key into lowercase parts (snake, kebab, dots, camelCase). */
const keyParts = (key) => String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** True when the key names a secret only through weak words or plurals (sessionId, auth_mode, max_tokens, X_AUTH_HEADER). */
export function isWeakKey(key) {
  return !keyParts(key).some((p) => STRONG_WORDS.some((w) => p.endsWith(w)));
}

// Keys that name nothing but a secret (api_key, client_secret, db_password, aws_access_key): any real value is one.
const SPECIFIC_KEY = /secret|passw|pwd|credential|passphrase|api[_-]?key|access[_-]?key|private[_-]?key/i;
/** Value level for a key: 'any' (specific), 'weak' (weak words / plurals only) or 'lower' (token, key, cookie, ...). */
export const keyLevel = (key) => (SPECIFIC_KEY.test(key) ? 'any' : isWeakKey(key) ? 'weak' : 'lower');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Variable references, templates and doc placeholders are not values: $GITHUB_PAT_2, <token>, your-key-here, sk-...
const PLACEHOLDER = /^[$<{%]|^\*+$|your[-_ ]|[-_]here$|\.\.\.|^x{6,}$|^(?:changeme|example|placeholder|redacted|none|null|undefined|true|false)$/i;
// Critic round 4, P2-6: a whole value that is a doc placeholder or a variable reference, quoted or not: '<password>',
// "${DB_PASSWORD}", $GH_TOKEN, %API_KEY%, {{ secret }}. Such values are never redacted.
const WHOLE_PLACEHOLDER = /^["'`]?(?:<[^<>\s]{1,60}>|\$\{[^{}\s]{1,80}\}|\$\(?[A-Za-z_][A-Za-z0-9_]*\)?|%[A-Za-z_][A-Za-z0-9_]*%|\{\{[^{}]{1,60}\}\})["'`]?[,;.)\]]*$/;
export const isPlaceholder = (v) => WHOLE_PLACEHOLDER.test(String(v).trim());
/** Replacement for [label][value] matches (group 1 = label, the rest = value): keep placeholders, else drop the value. */
const keepPh = (m, label) => (isPlaceholder(m.slice(label.length)) ? m : `${label}${R}`);

// Critic round 4, P0-1 (b): a value on its own line under a label line ("Client secret\n<v>", "API key:\n\n<v>",
// "**Passwort**\n<v>"), also inside JSON-escaped text (\\n) and after a code fence line.
const NL = '(?:\\r?\\n|(?:\\\\r)?\\\\n)';
// Critic round 5, P0-1 (b): a label line may END in the word ("Meta App Secret", "Stripe Geheimcode") and German labels count.
const LABEL_LINE = new RegExp(
  `((?:^|\\\\n|(?<=["']))[ \\t]*(?:[-*#>|][ \\t]*)*(?:\\*\\*|__)?(?:[A-Za-zÄÖÜäöüß0-9][\\w.äöüß-]{0,30}[ \\t]+){0,4}((?:client[ _-]?|app[ _-]?|api[ _-]?|access[ _-]?)?secret(?:[ _-]?(?:access[ _-]?)?key)?|api[ _-]?(?:key|token)|(?:access|auth|bearer|bot|refresh|personal access)[ _-]?token|token|passwor[dt]|kennwort|passphrase|(?:api-?)?schlüssel|private[ _-]?key|(?:app-?)?geheim[a-zäöüß]*|zugangsdaten|pw)(?:\\*\\*|__)?(?:[ \\t]*:)?[ \\t]*${NL}(?:[ \\t]*${NL})*(?:[ \\t]*\`\`\`[\\w-]*[ \\t]*${NL})?[ \\t]*)(["'\`]?)([^\\s"'\`\\\\]{6,})\\3[ \\t]*(?=${NL}|$|\\\\*["'])`,
  'gim');
function labelLine(m, label, name, q, v) {
  if (isPlaceholder(v)) return m;
  const pw = /passw|kennwort|passphrase|geheim|zugang|^pw$/i.test(name);
  const ok = pw ? v.length >= 6 && /[\d!@#$%^&*?_+~]/.test(v) && !/^\d+$/.test(v) : v.length >= 16 && secretish(v, 'lower');
  return ok ? `${label}${q}${R}${q}` : m;
}

/**
 * Does a value next to a secret-looking key look like a secret? Levels: 'any' (UPPER env names: every real value),
 * 'lower' (lowercase keys: >= 12 chars with a digit or mixed classes, or 16+ unbroken letters), 'weak' (weak keys: random-looking only).
 */
export function secretish(raw, level = 'lower') {
  const v = String(raw).replace(/^["'`]+/, '').replace(/(?<!["'`,;.)\]}])["'`,;.)\]}]+$/, '');
  if (!v || PLACEHOLDER.test(v) || /[()]/.test(v)) return false;
  if (level === 'any') return true;
  if (v.length < 12 || /^\d+$/.test(v)) return false;
  const lower = /[a-z]/.test(v);
  const upper = /[A-Z]/.test(v);
  const digit = /\d/.test(v);
  if (level === 'weak') {
    if (UUID.test(v)) return false;
    const switches = (v.match(/[A-Za-z](?=\d)|\d(?=[A-Za-z])/g) || []).length;
    return (lower && upper && digit) || switches >= 4;
  }
  const other = /[^A-Za-z0-9_.-]/.test(v);
  // one unbroken run of 16+ letters is a token, not a word
  return digit || [lower, upper, other].filter(Boolean).length >= 2 || /^[A-Za-z+/=]{16,}$/.test(v);
}

// UPPER env names whose only secret part is weak (RENT_SESSION_START_UTC, DBUS_SESSION_BUS_ADDRESS, ROW_OUT_TOKENS).
const ENV_STRONG = /KEY(?!S(?![A-Z]))|TOKEN(?!S(?![A-Z]))|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|FINGERPRINT|COOKIE|PRIVATE|SEED|MNEMONIC|DSN|WEBHOOK|SALT|ACCESS_?CODE|AUTH_?CODE|PASSCODE|PASSPHRASE/;
const envLine = (m, label, name, rest) => {
  const first = rest.trim().split(/\s+/)[0];
  return secretish(first, ENV_STRONG.test(name) ? 'any' : 'weak') ? `${label}${R}` : m;
};

// Whole-match replacements: the matched text is a secret on its own.
const TOKENS = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])xai-[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g,
  /(?<![A-Za-z0-9])GOCSPX-[A-Za-z0-9_-]{20,}/g, // Google OAuth client secrets
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{30,}/g,
  /(?<![A-Za-z0-9])cpk_[A-Za-z0-9.]{20,}/g,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])(?:hf|rpa|npm|r8)_[A-Za-z0-9]{20,}/g, // Hugging Face, RunPod, npm, Replicate
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe secret / restricted keys
  /(?<![A-Za-z0-9])whsec_[A-Za-z0-9]{16,}/g, // Stripe webhook signing secrets
  // Critic round 5, P2-1: SendGrid keys, Google OAuth refresh / access tokens, Facebook (Meta) access tokens
  /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9/])1\/\/0[A-Za-z0-9_-]{30,}/g,
  /(?<![A-Za-z0-9])ya29\.[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])EAA(?=[A-Za-z]*\d)[A-Za-z0-9]{30,}/g,
  /(?:(?<=\/bot)|(?<![A-Za-z0-9]))\d{8,10}:AA[\w-]{30,}/g, // Telegram bot tokens (also in api.telegram.org/bot<token>/…)
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT (critic r7: no start inside a token run)
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /(?<![A-Za-z0-9])G-\d{6}(?!\d)/g, // Google sign-in codes "G-123456"
  // Critic round 4, P1-1: Discord user/bot tokens (base64 user id . 6-char timestamp . HMAC)
  /(?<![A-Za-z0-9_-])[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}(?![A-Za-z0-9_-])/g,
  // password hashes: htpasswd/crypt $apr1$, $1$, $5$, $6$ and bcrypt $2y$ (offline-crackable, so they count as secrets)
  /\$(?:apr1|[156])\$[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{20,}/g,
  /\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{50,}/g,
];

const OTP_CONTEXT = /your|dein|ihr|verif|best(?:ä|ae)tig|login|log-in|sign|anmeld|sms|secur|sicher|einmal|one-?time|otp|2fa|mfa|zugang|access|pass(?:key|w)|account|konto|alert|tan\b|lautet|\bis\b|\bist\b/i;
// A lowercase bare "code 18040" / "pin 0664" is a card id or a version pin, unless it has the shape of a one-time code
// (6 digits, "123 456") or one-time-code words are near it.
function otpCode(m, label, digits, off, all) {
  const bare = /^(?:code|pin)\s*(?:=\s*)?$/.test(label);
  const otpShape = /^\d{6}$|^\d{3}[ -]\d{3}$/.test(digits) && !label.includes('=');
  if (bare && !otpShape && !OTP_CONTEXT.test(all.slice(Math.max(0, off - 30), off + m.length + 30).replace(m, ' '))) return m;
  return `${label}${R}`;
}

// Critic round 5, P2-8: a bare value before an env line that is base64 of plain text ("Q3l0…" = an encoded name) is an id;
// random key bytes never decode to printable words. "user:password" pairs stay suspicious.
function encodedText(v) {
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(v) || v.length % 4 !== 0) return false;
  const t = Buffer.from(v, 'base64').toString('latin1');
  return /^[A-Za-z0-9 ._-]+$/.test(t) && /[a-z]{4}/i.test(t) && !t.includes(':');
}

const TABLE_SECRET_HEADER = /(?:^|[\s_-])(?:api[ _-]?)?(?:key|token|secret|passwor[dt]|kennwort|pw|pwd|geheim\w*|schlüssel|credential)s?(?:$|[\s_-])/i;
const TABLE_NOT_SECRET = /(?:^|[\s_-])(?:id|name|typ|type|art|count|anzahl|scope|public|status|länge|length|ablauf|expires?)(?:$|[\s_-])/i;
/** Markdown table: mask the cells of columns whose header names a key, token, secret or password. */
function mdTable(block) {
  const rows = block.split(/\r?\n/);
  const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  const cols = cells(rows[0]).map((h) => TABLE_SECRET_HEADER.test(h.trim()) && !TABLE_NOT_SECRET.test(h.trim()));
  if (!cols.some(Boolean)) return block;
  return rows.map((r, i) => {
    if (i < 2) return r;
    const c = cells(r);
    let changed = false;
    const out = c.map((cell, j) => {
      const v = cell.trim().replace(/^`(.*)`$/, '$1');
      if (!cols[j] || !v || isPlaceholder(v) || /\s/.test(v) || /\[REDACTED/.test(v)) return cell;
      if (!(v.length >= 12 && secretish(v, 'weak')) && !(v.length >= 16 && secretish(v, 'lower'))) return cell;
      changed = true;
      return cell.replace(v, R);
    });
    return changed ? r.replace(/\|.*\|/, `|${out.join('|')}|`) : r;
  }).join('\n');
}

// [pattern, replacement]: keep the label, drop the value.
const LABELLED = [
  // env-file style lines with a secret-looking key: OPENAI_API_KEY=..., export DB_PASSWORD="...", DESK_ACCESS_CODE: ab12
  [/((?:^[ \t]*|(?<![A-Za-z0-9_]))(?:export[ \t]+)?([A-Z_][A-Z0-9_]{0,80}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|PIN|CREDENTIALS?|AUTH|FINGERPRINT|COOKIE|SESSION|PRIVATE|SEED|MNEMONIC|DSN|WEBHOOK|SALT|ACCESS_?CODE|AUTH_?CODE|PASSCODE)[A-Z0-9_]{0,80})[ \t]{0,16}[=:][ \t]{0,16})(?=\S)(?!(?:\d+|true|false|null|none)(?:\s|$))(.*)$/gm, envLine],
  // Critic round 2, P0-1: quoted key/value with single or double quotes (Python dict reprs, os.environ dumps, JS objects):
  // {'ABLITERATION_API_KEY': '...'}, {"privateKey": "..."}, environ({'CHUTES_FINGERPRINT': '...'})
  // Round 4 (P1-1): also PHP arrays 'password' => '...'.
  [new RegExp(`((['"])(?![\\w.-]{0,80}_type\\2)${NOT_BARE}(${SECRET_KEY})\\2\\s*(?:=>|[:=])\\s*)(['"])((?:(?!\\4)[^\\s\\\\]|\\\\.){6,})\\4`, 'g'),
    (m, label, _q, key, q, v) => ((isWeakKey(key) && !secretish(v, 'weak')) || isPlaceholder(v) ? m : `${label}${q}${R}${q}`)],
  // Critic round 3, P1-1: the same inside a JSON string (a raw transcript line): \"api_key\": \"...\"
  [new RegExp(`((?<!\\\\)(\\\\+)(['"])${NOT_BARE}(${SECRET_KEY})\\2\\3\\s*[:=]\\s*\\2\\3)([^"'\\\\\\s]{6,})(?=\\2\\3)`, 'g'),
    (m, label, _b, _q, key, v) => (isWeakKey(key) && !secretish(v, 'weak') ? m : `${label}${R}`)],
  // Critic round 2, P1-1: lowercase / camelCase keys with spaces around = or : (~/.aws/credentials, yaml, toml, JS consts)
  // aws_secret_access_key = ..., client_secret: ..., const apiKey = "...". Round 3 (P1-3): only values that look like a secret.
  [new RegExp(`(${KEY_START}${NOT_BARE}(${SECRET_KEY})[ \\t]*[:=][ \\t]*)(?!\\[REDACTED)(?!\\d+(?:[\\s,;]|$))(["']?)([^\\s"']{8,})\\3`, 'g'),
    (m, label, key, q, v) => (secretish(v, keyLevel(key)) ? `${label}${q}${R}${q}` : m)],
  // <secret-ish key> <long hex/base64>: "session_secret 9f8e…", "api key AbC123…" (needs a digit, so long words stay; weak keys never)
  [new RegExp(`(${KEY_START}${NOT_BARE}(${SECRET_KEY})[ \\t]+)(?=[A-Za-z+/_-]*\\d)([A-Za-z0-9+/_-]{32,}={0,2})(?![A-Za-z0-9])`, 'g'),
    (m, label, key) => (isWeakKey(key) ? m : `${label}${R}`)],
  // German / English prose: "Kennwort lautet Sommer2026!", "das Passwort ist Abc123!" (after ist/is only with a digit or symbol)
  [/((?<![A-Za-zÄÖÜäöü])(?:[Pp]asswort|[Kk]ennwort|[Pp]assword|PASSWORT|KENNWORT|PASSWORD)\s{1,8}(?:lautet|is|ist)\s{0,8}:?\s{0,8})(?!\*+[A-Za-z]+\*+(?:\s|$|[.,;]))(?:(?<=lautet\s{0,8}:?\s{0,8})\S+|(?=\S*(?:[\d!@#$%^&*?_+~]|[.-]\S))\S+)/g, `$1${R}`],
  // Cookie / Set-Cookie headers (plain and JSON)
  [/((?:^[ \t>-]*|\b)(?:set-)?cookie[ \t]*:[ \t]*)(?=\S).*$/gim, `$1${R}`],
  [/("(?:set-)?cookie"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, `$1"${R}"`],
  // JSON-quoted secret keys: keep the key, drop the string value ("access_token": "...", "password": "...")
  [/("((?![\w-]{0,80}_type")[\w-]{0,80}(?:token|secret|passw(?:or)?d|passwd|pwd|api[_-]?key|apikey|auth(?!or)|cookie|session|credential)[\w-]{0,80})"\s{0,16}:\s{0,16})"((?:[^"\\]|\\.){6,})"/gi,
    (m, label, key, v) => (isWeakKey(key) && !secretish(v, 'weak') ? m : `${label}"${R}"`)],
  // cookie objects from browser exports: {"name": ..., "value": "...", "domain": ...}
  [/\{[^{}]*\}/g, (m) => (/"name"\s*:/.test(m) && /"domain"\s*:/.test(m) ? m.replace(/("value"\s*:\s*)"(?:[^"\\]|\\.)*"/g, `$1"${R}"`) : m)],
  // Authorization: Basic <base64>
  [/(authorization\s*[:=]\s*basic\s+)[A-Za-z0-9+/]{8,}={0,2}/gi, `$1${R}`],
  // Critic round 4, P1-1: Authorization: Token <v> / ApiKey <v> / <v> (a scheme word: any value; no scheme: secret-looking)
  [/((?<![A-Za-z0-9_-])authorization["']?[ \t]*[:=][ \t]*["']?((?:token|bearer|basic|apikey|api-key|digest|sso-key|key|jwt)[ \t]+)?)(?!\[REDACTED)([^\s"'<>]{8,})/gi,
    (m, label, scheme, v) => (isPlaceholder(v) || (!scheme && !secretish(v, 'lower')) ? m : `${label}${R}`)],
  // UPPER_SNAKE strong key, then a space, tab or comma, then a value >= 16 (COOLIFY_TOKEN <v>, GITHUB_TOKEN\t<v>, CSV)
  [/((?<![A-Za-z0-9_$])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?:[ \t]+|[ \t]*,[ \t]*))(?!\[REDACTED)(["']?)(?![/~.])([A-Za-z0-9+/_.~=-]{16,})\3(?![A-Za-z0-9+/_.~=-])/g,
    (m, label, name, q, v) => (ENV_STRONG.test(name) && secretish(v, 'lower') && !isPlaceholder(v) ? `${label}${q}${R}${q}` : m)],
  // prose: "fingerprint <v>", "the token is <v>", "API-Schlüssel: <v>" (random-looking values only)
  [/((?<![A-Za-z0-9_-])(?:fingerprint|token|secret|api[ _-]?key|access[ _-]?token|client[ _-]?secret|(?:api-?)?schlüssel|zugangsschlüssel)(?:[ \t]*(?:is|ist|lautet|=|:)[ \t]*:?[ \t]*|[ \t]+))(?!\[REDACTED)(["'`]?)([A-Za-z0-9+/_.~-]{16,}={0,2})\2(?![A-Za-z0-9+/_.~=-])/gi,
    (m, label, q, v) => (secretish(v, 'weak') && !isPlaceholder(v) ? `${label}${q}${R}${q}` : m)],
  // Critic round 5, P0-1 (b) / P2-1: German and loose labels on the same line: "meta geheimcode: <v>", "App-Geheimcode: <v>",
  // "Das Geheimnis ist <v>", "pw: <v>", "pw ist <v>", "Kennwort = <v>", "Meta App Secret: <v>", "hier der key: <v>",
  // "the key is <v>", "Token —> <v>". A separator is required ("Der Geheimcode steht im Tresor" stays).
  // Critic round 6, P1-1: at most 3 separators, blanks only between them. `(?:[ \t]*SEP[ \t]*)+` let every blank belong to
  // two iterations and backtracked exponentially ("secret" + 20 x "  :" took 8 s).
  [/((?<![A-Za-zÄÖÜäöüß0-9_])(geheim[a-zäöüß]*|zugangsdaten|kennwort|pw|app[ _-]?secret|key|token|secret|schlüssel)[ \t]*(?:\bist\b|\blautet\b|\bis\b|:|=|—>|–>|->|=>|→)(?:[ \t]*(?:\bist\b|\blautet\b|\bis\b|:|=|—>|–>|->|=>|→)){0,2}[ \t]*)(["'`]?)([^\s"'`<>]{6,})\3(?![^\s"'`<>])/gi,
    (m, label, word, q, v) => {
      if (isPlaceholder(v) || /^\[REDACTED|[«»]/.test(v) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+[.,;:]?$/.test(v)) return m; // a masked label or a variable NAME
      const pw = /^(?:geheim|zugang|kennwort|pw)/i.test(word);
      const ok = pw ? v.length >= 6 && /[\d!@#$%^&*?_+~]/.test(v) && !/^\d{1,7}$/.test(v) && !/^[\d.,:/-]+$/.test(v)
        : v.length >= 16 && /^[A-Za-z0-9+/_.~=-]+$/.test(v) && secretish(v, 'weak');
      return ok ? `${label}${q}${R}${q}` : m;
    }],
  // "Zugangsdaten: florian / <v>", "login: admin@example.org / <v>", "credentials: user / <v>"
  [/((?<![A-Za-zÄÖÜäöüß])(?:zugangsdaten|anmeldedaten|zugang|login|credentials?)(?:[ \t]*[:=][ \t]*|[ \t]+)[^\s/?&=]{1,80}[ \t]+\/[ \t]+)(["'`]?)([^\s"'`]{6,})\2/gi,
    (m, label, q, v) => (!isPlaceholder(v) && /[\d!@#$%^&*?_+~]/.test(v) && !/^\d+$/.test(v) ? `${label}${q}${R}${q}` : m)],
  // YAML block scalar under a secret key: "api_key: >-\n  <v>"
  [new RegExp(`(${KEY_START}${NOT_BARE}(${SECRET_KEY})[ \\t]*:[ \\t]*[>|][-+]?[ \\t]*\\r?\\n[ \\t]+)([^\\s"']{8,})`, 'g'),
    (m, label, key, v) => (secretish(v, keyLevel(key)) && !isPlaceholder(v) ? `${label}${R}` : m)],
  // markdown table: a cell under a key / secret / token / password header ("| Service | API key |")
  [/^[ \t]*\|.*\|[ \t]*\r?\n[ \t]*\|[ \t:|-]+\|[ \t]*(?:\r?\n[ \t]*\|.*\|[ \t]*)+/gm, mdTable],
  // password=..., Passwort: ..., pwd=...
  [/((?<![A-Za-z])(?:passw(?:or)?d|passwort|kennwort|pwd|passphrase)\s*[:=]\s*)(?=\S)(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi, keepPh],
  // Critic round 3, P1-1: command-line passwords: mysql -p<v>, sshpass -p '<v>', --password <v>, --pass=<v>, PGPASSWORD=<v> psql
  [/(\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^\n|;&]{0,200}?\s-p)(?!\s)(?:'[^'\n]*'|"[^"\n]*"|[^\s'"]+)/g, `$1${R}`],
  [/(\bsshpass\b(?:\s+-[a-oq-zA-Z]\S*)*\s+-p\s*)(?:'[^'\n]*'|"[^"\n]*"|[^\s'"]+)/g, `$1${R}`],
  [/((?<![\w-])--(?:password|passwd|pass|pwd)(?![\w-])(?:=|[ \t]+))(?!-)(?:'[^'\n]*'|"[^"\n]*"|[^\s'"]+)/g, keepPh],
  // Critic round 4, P1-1: docker/podman/helm login -p <v>; echo <v> | … --password-stdin / gh auth login --with-token;
  // ssh-keygen -N '<v>' / -P '<v>'
  [/(\b(?:docker|podman|nerdctl|buildah|skopeo|helm(?:[ \t]+registry)?)[ \t]+login\b[^\n|;&]{0,200}?[ \t]-p[ \t]+)(?:'[^'\n]*'|"[^"\n]*"|[^\s'"]+)/g, keepPh],
  [/(\b(?:echo|printf)(?:[ \t]+-[neE]+)*(?:[ \t]+(?:'%s(?:\\n)?'|"%s(?:\\n)?"))?[ \t]+)(?:'[^'\n]*'|"[^"\n]*"|[^\s'"|;&]+)(?=[ \t]*\|[ \t]*(?:sudo[ \t]+)?(?:(?:docker|podman|nerdctl|helm|oras|skopeo|buildah)(?:[ \t]+registry)?[ \t]+login\b[^\n]{0,200}?--password-stdin|gh[ \t]+auth[ \t]+login\b[^\n]{0,200}?--with-token|[\w./-]+[ \t][^\n]{0,200}?--(?:password|token|secret)-stdin))/g, keepPh],
  [/(\bssh-keygen\b[^\n|;&]{0,200}?[ \t]-[NP][ \t]*)(?:'[^'\n]+'|"[^"\n]+"|[^\s'"-][^\s'"]*)/g, keepPh],
  // .netrc: "machine api.example.com login florian password <v>" and multi-line netrc "  password <v>"
  [/((?:\bmachine\s+\S+\s+(?:login\s+\S+\s+)?|^[ \t]*)password[ \t]+)(?!(?:is|ist|lautet|for|of|reset|manager|field|policy)\b)(?=\S*[\d!@#$%^&*?_+~])\S{6,}/gm, `$1${R}`],
  // the generic one of round 1 (key, token, secret, password + long value; variable references and code stay)
  [/(api[_-]?key|token|secret|password)\s*[:=]\s*(?!\[REDACTED\])(\S{8,})/gi, (m, k, v) => (secretish(v, k === 'token' ? 'lower' : 'any') ? R : m)],
  // user:password@host in connection URLs
  // Round 4 (P1-1): an empty user too (redis://:<v>@host); placeholders (${DB_PASSWORD}, <password>) stay (P2-6)
  [/(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]*:)([^\s@/]+)@/gi, (m, label, v) => (isPlaceholder(v) ? m : `${label}${R}@`)],
  // raw 32-byte keys with context: "private key: 0x…", "secretSeed": "0x…"
  [/((?:private|priv|secret)[ _-]?(?:key|seed)["']?\s{0,8}[:=]?\s{0,8}["']?)(?:0x)?[0-9a-fA-F]{64}/gi, `$1${R}`],
  // seed phrases with context: 12-24 lowercase words after seed/mnemonic/recovery phrase
  [/((?:seed(?:[ _-]?phrase)?|mnemonic|recovery[ _-]?phrase|secret[ _-]?phrase|wiederherstellungs(?:phrase|satz)|secretPhrase)["']?\s*[:=]?\s*["']?)(?:[a-z]{3,8}[\s,]+){11,23}[a-z]{3,8}/gi, `$1${R}`],
  // one-time codes, PIN, TAN: "Code: 123456", "Ihr Bestätigungscode lautet 482913", "TAN 123456", "verification code is 1234".
  // Round 3 (P1-3): a lowercase bare "code 18040" / "pin 0664" without any one-time-code context is a card id or a version pin.
  [/((?:[A-Za-zÄÖÜäöüß-]{0,40}(?:code|passcode)|(?<![A-Za-zÄÖÜäöüß])(?:m|sms-?|push-?|chip-?|i|bank-?)?(?:tan|pin|otp))(?![A-Za-zäöüß])(?:\s{0,8}[:=]\s{0,8}|\s{1,8}(?:lautet|ist|is|lautet:|is:)?\s{0,8}))(\d{4,8}|\d{3}[ -]\d{3}|\d{4}-\d{4})(?![\d]|[-./:,]\d)/gi, otpCode],
  // Einmalpasswort 556677, one-time password: 1234
  [/((?:einmal(?:passwort|code|kennwort)|one[- ]?time[- ]?(?:password|code))\s{0,8}[:=]?\s{0,8}(?:lautet|ist|is)?\s{0,8})(\d{4,8})(?!\d)/gi, `$1${R}`],
  // number first: "482913 ist dein Bestätigungscode", "123456 is your verification code"
  [/(?<![\d.,/-])\d{4,8}(?=\s+(?:is your|ist dein|ist Ihr|ist der|est votre|es tu)\b[^\n]{0,40}?(?:code|pin|tan|otp|passcode))/gi, R],
  // Critic round 3, P1-1: a value whose key was cut off, inside an env dump: "ET=<v>\nNEXT_VAR=…" or "<v>\nNEXT_VAR=…"
  [/(^|[=\s]|\\n)([A-Za-z0-9+_.~-][A-Za-z0-9+/_.~-]{15,}={0,2})(?=(?:\\+[nr]|\r?\n)+(?:export\s+)?[A-Z_][A-Z0-9_]*=)/g,
    (m, pre, v) => (secretish(v, 'weak') && !encodedText(v) ? `${pre}${R}` : m)],
  // ... and at the very start of a text that begins mid-key ("ET=<v>")
  [/^((?:export\s+)?[A-Z][A-Z0-9_]{0,40}=)([^\s"'\\]{16,})/, (m, label, v) => (secretish(v, 'weak') ? `${label}${R}` : m)],
  [LABEL_LINE, labelLine],
];

// Links that log someone in or reset something carry their secret in the URL: keep the origin only.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
const LINK_WORDS = /reset|magic|passwor|verif|confirm|login|log-in|signin|sign-in|sign_in|activat|invite|auth|otp|onetime|one-time|unsubscribe|token|session/i;
const SECRET_PARAMS = /[?&#](?:token|code|key|sig|signature|secret|auth|otp|access_token|id_token|refresh_token|session|ticket)=(?=[^&#\s])/i;
// Critic round 4, P2-6: template values in a URL (?key=${TENOR_API_KEY}, &token=<token>, {{ secret }}, $TOKEN) are no secrets;
// URL_RE stops before `}` and `<`, so a cut-off `${NAME` counts too.
// Critic round 7, P2-1: every scan is bounded (a URL of "=%3C" x 30 000 rescanned to its end from every "=").
const URL_PLACEHOLDER = /=(?:\$\{[^}&#\s]{0,200}\}?|\$[A-Za-z_][A-Za-z0-9_]{0,200}|%7B%7B[^&#]{0,200}?%7D%7D|\{\{[^}&#]{0,200}\}\}|%3C[^&#]{0,200}?%3E|<[^>&#]{0,200}>)(?=[&#]|$)/gi;
const LONG_PIECE = /[A-Za-z0-9_-]{24,}/;

// Webhook URLs carry their secret in the path (Slack /services/T…/B…/…, Discord /api/webhooks/<id>/<token>).
// Critic round 7, P2-1: `[^/]+\/.*webhook.*[A-Za-z0-9_-]{24,}` was quadratic on "/webhook" x n; the generic case is now two
// linear searches (a "webhook" in the path, then a 24-char run after it).
const WEBHOOK_HOST = /^(?:hooks\.slack\.com\/services\/|(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\/)/i;
const isWebhook = (hostPath) => {
  if (WEBHOOK_HOST.test(hostPath)) return true;
  const slash = hostPath.indexOf('/');
  const at = slash > 0 ? hostPath.toLowerCase().indexOf('webhook', slash + 1) : -1;
  return at >= 0 && /[A-Za-z0-9_-]{24}/.test(hostPath.slice(at + 7));
};

function scrubUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return url; }
  const rest = url.slice(parsed.origin.length).replace(URL_PLACEHOLDER, '=');
  if (isWebhook(`${parsed.host}${parsed.pathname}`) && parsed.pathname.length > 1) return `${parsed.origin}/${R}`;
  if (SECRET_PARAMS.test(rest) || (LINK_WORDS.test(rest) && LONG_PIECE.test(rest))) return `${parsed.origin}/${R}`;
  return url;
}

function redactPiece(text) {
  let out = text;
  for (const re of TOKENS) out = out.replace(re, R);
  for (const [re, to] of LABELLED) out = out.replace(re, to);
  return out.replace(URL_RE, scrubUrl);
}

// Critic round 6, P1-1 (guard): no regex sees an unbounded input. Texts above CHUNK_FROM are redacted in pieces of at most
// PIECE chars, cut after a newline (or a blank, or hard). A cut is only taken where the SEAM chars on both sides redact the
// same together as apart, so no pattern straddles it (a PEM block, a label line and its value line, a table); otherwise the
// cut moves on by SEAM / 2, at most 4 times, then it is taken anyway.
// Critic round 7, P2-1: chunked from 64 kB (was 200 kB), so no rule sees more than 64 kB at once, and at most 4 seam tries
// (were 8): on text where every cut splits a match (a YAML key line before every value line) the tries cost 7-15x the
// redaction itself. The hard bound is the worker budget in redact.js.
const CHUNK_FROM = 64_000;
const PIECE = 64_000;
const SEAM = 8_000;
function cutNear(text, at, min) {
  const nl = text.lastIndexOf('\n', at - 1);
  if (nl + 1 > Math.max(min, at - PIECE / 2)) return nl + 1;
  const sp = text.slice(at - 2_000, at).search(/\s\S*$/);
  return sp >= 0 && at - 2_000 + sp + 1 > min ? at - 2_000 + sp + 1 : at;
}
function safeCut(text, start) {
  let at = start + PIECE;
  for (let tries = 0; tries < 4; tries += 1) {
    const cut = cutNear(text, at, start + SEAM);
    const a = text.slice(Math.max(start, cut - SEAM), cut);
    const b = text.slice(cut, cut + SEAM);
    if (redactPiece(a + b) === redactPiece(a) + redactPiece(b)) return cut;
    at = cut - SEAM / 2 > start + SEAM ? cut - SEAM / 2 : cut + SEAM / 2;
    if (at >= text.length) return text.length;
  }
  return Math.min(text.length, cutNear(text, at, start + SEAM));
}

/** Scrub one string. Non-strings are returned unchanged. */
export function redactText(text) {
  if (typeof text !== 'string') return text;
  if (text.length <= CHUNK_FROM) return redactPiece(text);
  let out = '';
  for (let start = 0; start < text.length;) {
    const end = text.length - start <= PIECE ? text.length : safeCut(text, start);
    out += redactPiece(text.slice(start, end));
    start = end;
  }
  return out;
}
