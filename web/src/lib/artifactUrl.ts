/** Entry URLs contain hex ids only. Accept older encoded a# forms without ever generating a raw hash. */
export function parseArtifactUrl(input: string) {
  const url = new URL(input, 'https://desk.local');
  const path = /^\/a\/(.+?)\/?$/.exec(url.pathname)?.[1];
  const parts = [url.searchParams.get('a'), path].filter(Boolean).join(',').split(',').filter(Boolean);
  const ids: string[] = [], invalid: string[] = [];
  for (let part of parts) {
    try { part = decodeURIComponent(part); } catch { invalid.push(part); continue; }
    const id = /^(?:a#)?([0-9a-f]{6})$/i.exec(part.trim())?.[1].toLowerCase();
    if (!id || (!ids.includes(id) && ids.length >= 8)) invalid.push(part);
    else if (!ids.includes(id)) ids.push(id);
  }
  const rawVoice = url.searchParams.get('voice');
  const voice = rawVoice === 'gemini' || rawVoice === 'openai' || rawVoice === 'xai' ? rawVoice : null;
  return { ids, invalid, voice, question: (url.searchParams.get('q') ?? '').slice(0, 2000) };
}
export function artifactUrl(ids: string[], voice?: 'gemini' | 'openai' | 'xai', question?: string) {
  const parsed = parseArtifactUrl(`/?a=${encodeURIComponent(ids.join(','))}`);
  const params = new URLSearchParams({ a: parsed.ids.join(',') });
  if (voice) params.set('voice', voice);
  if (question) params.set('q', question);
  return `/?${params}`;
}
