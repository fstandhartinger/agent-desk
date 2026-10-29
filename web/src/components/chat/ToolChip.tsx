import { useState } from 'react';
import { AlertTriangle, BookOpen, Bot, Briefcase, Check, ChevronRight, FileSearch, FileText, Globe, Loader2, Mail, MessageCircle, MessagesSquare, Search, Sparkles, Terminal, Wand2, type LucideIcon } from 'lucide-react';
import type { ToolEvent } from '../../lib/types';
import { argSummary, hostLabel, toolLabel } from '../../lib/activity';
import { fmtDuration } from '../../lib/format';

const ICONS: Record<string, LucideIcon> = {
  read_core_doc: BookOpen,
  search_files: FileSearch,
  read_file: FileText,
  list_jobs: Briefcase,
  job_status: Briefcase,
  board_threads: MessagesSquare,
  board_read: MessagesSquare,
  board_entry: MessagesSquare,
  board_search: Search,
  search_chats: Search,
  chats_search: Search,
  chat_read: MessagesSquare,
  web_read: Globe,
  discord_read: MessageCircle,
  mail_search: Mail,
  mail_read: Mail,
  skills_list: Wand2,
  skill_read: Wand2,
  run_readonly: Terminal,
  explainer_context: BookOpen,
  handoff_propose: Bot,
  explainer_point: Sparkles,
  claude_task: Bot,
  claude_status: Bot,
};

/** Inline tool activity: compact pill, expands to arguments + result summary. */
export default function ToolChip({ tool }: { tool: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[tool.name] ?? Sparkles;
  const running = tool.status === 'start';
  const failed = tool.status === 'error';
  const target = argSummary(tool.args);
  const host = hostLabel(tool.host);
  return (
    <div className="my-2 animate-fade">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`group inline-flex max-w-full items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-[13px] transition-colors ${
          failed ? 'border-danger/25 bg-danger/[0.06]' : running ? 'border-violet/30 bg-violet/[0.08]' : 'border-white/[0.07] bg-white/[0.03] hover:bg-white/[0.06]'
        }`}
      >
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${failed ? 'bg-danger/15 text-danger' : running ? 'bg-violet/20 text-violet-light' : 'bg-moss/12 text-moss'}`}>
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : failed ? <AlertTriangle className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
        </span>
        <span className="shrink-0 font-medium text-fg-2">{toolLabel(tool.name)}</span>
        {target && <span className="min-w-0 truncate font-mono text-[12px] text-dim">{target}</span>}
        {host && <span data-testid="tool-host" className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-px text-[10.5px] font-medium text-mute">{host}</span>}
        {!running && !failed && <Check className="h-3.5 w-3.5 shrink-0 text-moss/80" />}
        {tool.ms != null && !running && <span className="shrink-0 text-[11px] text-mute tabular">{fmtDuration(tool.ms)}</span>}
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-mute transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="ml-3 mt-1.5 animate-fade border-l-2 border-white/[0.08] py-1 pl-3.5 text-[13px] leading-relaxed">
          {tool.summary ? <p className="text-fg-2">{tool.summary}</p> : <p className="text-mute">{running ? 'Läuft …' : 'Kein Ergebnis-Text.'}</p>}
          {tool.args != null && (
            <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11.5px] text-mute">{JSON.stringify(tool.args, null, 1)}</pre>
          )}
        </div>
      )}
    </div>
  );
}
