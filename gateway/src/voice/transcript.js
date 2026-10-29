// Spoken-transcript repair. Gemini's output transcription drops the hyphen of German compounds and glues the parts
// ("Krypto-Emissionen" arrives as "KryptoEmissionen", "GPU-Serverkosten" as "GPUServerkosten"). A lower-to-upper
// seam inside a word is split again with a hyphen, unless the word is a known brand / appeared in a tool result
// (OpenRouter, JevBench, ...). Spaces between fragments are never touched.

const BRANDS = new Set(['GitHub', 'OpenRouter', 'OpenAI', 'ElevenLabs', 'DeepSeek', 'TensorX', 'JevBench', 'BenchmarkHeaven', 'WhatsApp', 'YouTube', 'LinkedIn', 'PowerPoint', 'ChatGPT', 'DeepL', 'TypeScript', 'JavaScript', 'PostgreSQL', 'MongoDB', 'RunPod', 'RunCloud', 'UpCloud', 'SpaceX', 'SpaceXAI', 'TelegramBot', 'AgentDesk', 'ClaudeCode', 'OpenCode', 'PgBouncer', 'WireGuard', 'LeChonk', 'SandyProd', 'GeForce', 'NVIDIA', 'InfiniBand', 'WebSocket', 'WebRTC', 'OAuth', 'macOS', 'iPhone', 'iOS', 'eBay', 'PayPal', 'DevOps', 'Hugging', 'HuggingFace', 'SubNet', 'TaoStats', 'BitTensor']);
const CAMEL = /(?<!\p{L})\b(\p{Lu}?\p{Ll}{2,}|\p{Lu}{2,})(\p{Lu}\p{Ll}{2,})\b/gu;

/** CamelCase-looking words of a text (tool results, instructions): protected from hyphen repair. */
export function knownWords(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(CAMEL)) out.add(m[0]);
  return out;
}

export function repairGlued(text, known = new Set()) {
  return String(text ?? '').replace(CAMEL, (word, left, right) => {
    if (BRANDS.has(word) || known.has(word)) return word;
    // all-caps head: "GPUServerkosten" -> head "GPU", the regex took "GPUS"? the lazy split keeps the last capital with the tail
    return `${left}-${right}`;
  });
}

// Round 12 (critic r11 defect 5): Gemini's output transcript carried a raw tool marker ("zm-thinker:call_tool_use_thinker_agent{}").
// Markup of that shape (name:call_x{...}, call_x{...}, default_api.x(...), <ctrlNN>) never reaches the browser.
const MARKUP_RE = /(?<![\w.-])[\w.-]*:call_\w*(?:\{[^{}]*\})?|\bcall_\w+\{[^{}]*\}|\b(?:print\()?default_api\.\w+\([^)]*\)\)?|<ctrl\d+>|<\/?(?:tool_call|function_call)[^<>]*>/g; // [^<>]: [^>]* rescanned to the next > from every <tool_call (critic r7)

export function stripToolMarkup(text) {
  return String(text ?? '').replace(MARKUP_RE, '').replace(/[ \t]{2,}/g, ' ');
}

/** Streaming version: the last, unfinished word and an unclosed "call_…{" wait for the next delta. */
export class TranscriptMarkupFilter {
  constructor() { this.held = ''; }
  push(delta) {
    const text = this.held + String(delta ?? '');
    let cut = text.length;
    const open = text.lastIndexOf('{');
    if (open >= 0 && text.indexOf('}', open) < 0 && /call_/.test(/(?<!\w)\w*$/.exec(text.slice(0, open))[0])) cut = text.lastIndexOf(' ', open) + 1;
    else {
      const m = /(?:^|\s)(\S*)$/.exec(text); // the last word may still grow into markup ("zm-thin" + "ker:call_…")
      if (m && m[1]) cut = text.length - m[1].length;
    }
    this.held = text.slice(cut);
    return stripToolMarkup(text.slice(0, cut));
  }
  flush() { const rest = stripToolMarkup(this.held); this.held = ''; return rest; }
}

// Round 12: Gemini announced three times ("Ich schaue mir …", "Ich analysiere …", "Ich prüfe …") before it answered. A turn
// shows at most one such filler sentence.
const FILLER_RE = /^\s*(?:(?:okay|ok|gut|alles klar|einen moment|moment)[,.!]?\s*)?(?:ich\s+(?:schaue|schau|sehe|seh|prüfe|analysiere|lese|suche|hole|checke|recherchiere|kläre|gucke|werfe|sammle|verfolge|informiere|kümmere|bereite|arbeite|mache mich)|lass mich|einen moment|moment)\b[^.!?]{0,90}[.!?…]*\s*$/i;
// "Ich sehe, dass …" / "Ich habe gesehen, …" carry content (live r12): a clause with dass / weil / denn, or a digit, is no filler
export const isFiller = (sentence) => FILLER_RE.test(sentence) && !/\d/.test(sentence) && !/(?:^|[\s,])(?:dass|daß|weil|denn|nämlich|wonach)\b|\bhabe\s+\w+(?:en|t)\b/i.test(sentence);

/** `text` without its filler sentences beyond `allowed` (returns {text, fillers}: how many it kept). */
export function limitFillers(text, allowed = 1) {
  let kept = 0;
  const parts = String(text ?? '').match(/[^.!?…]+[.!?…]*\s*|\s+$/g) ?? [];
  const out = parts.filter((p) => {
    if (!isFiller(p)) return true;
    kept += 1;
    return kept <= allowed;
  });
  return { text: out.join('').trim(), fillers: Math.min(kept, allowed) };
}
