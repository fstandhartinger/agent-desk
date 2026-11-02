import { parseArtifactUrl } from './artifactUrl';

declare const __DESK_VERSION__: string;
declare const __DESK_COMMIT__: string;

export type VoiceEntry = { path: string; card?: string; page_aid?: string; element?: string };
export type ClientInfo = { app: 'web'; version: string; commit: string; device: 'phone' | 'desktop' };

export const clientInfo = (desktop: boolean): ClientInfo => ({
  app: 'web',
  version: typeof __DESK_VERSION__ === 'string' ? __DESK_VERSION__ : 'dev',
  commit: typeof __DESK_COMMIT__ === 'string' ? __DESK_COMMIT__ : 'dev',
  device: desktop ? 'desktop' : 'phone',
});

/** What the URL and page say about how this session was reached: ?companion=1 = Screen Agent, ?x= slug = explainer page, ?a= ids, ?from=card:<n>. */
export function buildEntry(loc: { pathname: string; search: string }, element?: string | null): VoiceEntry {
  const q = new URLSearchParams(loc.search);
  const card = /^card:(\d{1,9})$/.exec(q.get('from') ?? '')?.[1];
  const slug = q.get('x');
  const [page_aid] = parseArtifactUrl(`${loc.pathname}${loc.search}`).ids;
  const path = q.get('companion') === '1' ? 'screen-agent' : [card ? 'card' : '', slug ? 'interactive' : '', 'desk'].filter(Boolean).join('>');
  return { path, ...(card ? { card } : {}), ...(page_aid ? { page_aid } : {}), ...(element ? { element } : {}) };
}
