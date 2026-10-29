// Tiny dependency-free highlighter for code blocks (keywords, strings, comments, numbers).
const KW = new Set(('const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof in of yield def lambda pass raise with as elif None True False null undefined true false this self echo fi then done esac local readonly interface type enum public private static').split(' '));
const TOKEN = /(\/\/[^\n]*|#(?![!{])[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g;

export type Tok = { t: 'k' | 's' | 'c' | 'n' | null; v: string };

export function tokenize(code: string, lang = ''): Tok[] {
  if (code.length > 20000 || /^(text|txt|plain|log)$/.test(lang)) return [{ t: null, v: code }];
  const hashComments = /^(py|python|sh|bash|shell|zsh|yaml|yml|toml|rb|ruby|conf)$/.test(lang);
  const out: Tok[] = [];
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    const i = m.index!;
    if (m[1] && m[1].startsWith('#') && !hashComments) continue;
    if (i > last) out.push({ t: null, v: code.slice(last, i) });
    const t = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : KW.has(m[4]) ? 'k' : null;
    out.push({ t, v: m[0] });
    last = i + m[0].length;
  }
  if (last < code.length) out.push({ t: null, v: code.slice(last) });
  return out;
}
