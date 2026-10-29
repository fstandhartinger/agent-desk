export interface SSEMessage { id?: string; event?: string; data: string }

// Parses a text/event-stream body (works for POST responses, which EventSource cannot do).
export async function* readSSE(res: Response): AsyncGenerator<SSEMessage> {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let msg: SSEMessage = { data: '' };
  let hasData = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf[nl] === '\r' ? 2 : 1));
        if (line === '') {
          if (hasData) yield msg;
          msg = { data: '' };
          hasData = false;
          continue;
        }
        if (line.startsWith(':')) continue;
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i);
        const val = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (field === 'data') {
          msg.data = hasData ? `${msg.data}\n${val}` : val;
          hasData = true;
        } else if (field === 'id') msg.id = val;
        else if (field === 'event') msg.event = val;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseJSON<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
