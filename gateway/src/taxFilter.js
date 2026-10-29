// Round 9 (critic r8 F2/C3): tax-law statements need a source. The prompt says so; this is the safety net for the text
// agent: a sentence that states a tax-law rule without a source reference in the same sentence is replaced by the
// sentence below (once per answer).
export const TAX_NO_SOURCE = 'Dazu habe ich keine Quelle – frag den Steuerberater.';

const CLAIM = /steuerpflicht\w*\s+(?:entsteht|beginnt|tritt|besteht|liegt)|\b(?:ist|sind|bleibt|bleiben|wäre|wären)\s+(?:\w+\s+){0,2}(?:steuerfrei|steuerpflichtig|steuerbar)|\bsteuerfrei(?:e[nrms]?)?\b|\bunterliegt\w*\s+(?:\w+\s+){0,4}\w*steuer|\b(?:wird|werden|würde|würden)\s+(?:\w+\s+){0,3}(?:versteuert|besteuert)|\bsteuerlich\s+(?:gilt|gelten|relevant|zu behandeln)|§\s*\d+\w*\s*(?:EStG|KStG|UStG|AO)/i;
const SOURCE_REF = /\.(?:md|txt|json|csv|js|mjs)\b|\/home\/|\bDECISIONS\b|\bBoard\s*#\s*\d+|\bThread\s*(?:#\s*)?\d+|\bQuelle\s*:|\bknowledge_read\b|\blaut\s+(?:Datei|Board|Notiz)/i;

/** True when the sentence states a tax-law rule and names no source. */
export function isUnsourcedTaxClaim(sentence) {
  return CLAIM.test(sentence) && !SOURCE_REF.test(sentence);
}

/** Streaming filter: push(text) returns the sentences completed so far (checked); flush() returns the rest. */
export class TaxClaimFilter {
  constructor() { this.buf = ''; this.said = false; }

  check(sentence) {
    if (!isUnsourcedTaxClaim(sentence)) return sentence;
    const lead = /^\s*/.exec(sentence)[0];
    const trail = /(?<!\s)\s*$/.exec(sentence)[0];
    if (this.said) return `${lead.includes('\n') ? lead : ''}${trail.includes('\n') ? trail : ''}`;
    this.said = true;
    return `${lead}${TAX_NO_SOURCE}${trail}`;
  }

  push(text) {
    this.buf += text;
    let out = '';
    for (;;) {
      const m = /[.!?](?=\s)|\n/.exec(this.buf);
      if (!m) break;
      const end = m.index + 1;
      const sentence = this.buf.slice(0, end);
      this.buf = this.buf.slice(end);
      out += this.check(sentence);
    }
    return out;
  }

  flush() {
    const rest = this.buf;
    this.buf = '';
    return this.check(rest);
  }
}
