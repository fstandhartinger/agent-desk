// Shared wire types (docs/SPEC.md). Keep in sync with the gateway.
export type Tone = 'moss' | 'papaya' | 'violet' | 'amber' | 'red' | 'neutral';
export type VizNodeKind = 'agent' | 'user' | 'claude' | 'tool' | 'file' | 'job' | 'board' | 'idea' | 'number' | 'risk' | 'decision';
export interface VizNode { id: string; label: string; kind: VizNodeKind; tone?: Tone; value?: string; group?: string }
export interface VizEdge { from: string; to: string; label?: string; style?: 'flow' | 'pulse' | 'dashed' }
export interface VizStep { label: string; state: 'done' | 'active' | 'todo' }
export interface VizSpec { v: 1; title: string; caption?: string; focus?: string; nodes: VizNode[]; edges: VizEdge[]; steps?: VizStep[] }

export interface ToolEvent { type: 'tool'; id: string; name: string; args?: unknown; status: 'start' | 'done' | 'error'; summary?: string; ms?: number; /** Bridge host that served the call (sandy / lechonk). */ host?: string }
/** Proposal from the `handoff_propose` tool. Nothing is posted until Florian clicks; then POST /api/handoff {id}. */
export interface HandoffEvent { type: 'handoff'; id: string; title: string; task: string; why?: string }
/** Proposal from the `claude_task` tool. Nothing starts until Florian clicks; then POST /api/claude/proposal {id}. */
export interface ClaudeProposalEvent { type: 'claude_proposal'; id: string; prompt: string; title: string; sessionId?: string; model?: 'opus' | 'sonnet'; /** chat turns the new session gets along with the prompt */ contextTurns?: number }
export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'status'; text: string }
  | ToolEvent
  | HandoffEvent
  | ClaudeProposalEvent
  | { type: 'viz'; spec: VizSpec }
  | { type: 'done'; usage?: { in: number; out: number }; costUsd?: number; model?: string }
  | { type: 'error'; message: string };

export type ClaudeEvent = { seq: number; ts: string } & (
  | { kind: 'status'; state: 'starting' | 'running' | 'idle' | 'stopped' | 'error'; account?: string; model?: string }
  | { kind: 'user'; text: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input?: string; path?: string; command?: string }
  | { kind: 'tool_result'; id: string; ok: boolean; preview?: string }
  | { kind: 'todo'; items: { content: string; status: string }[] }
  | { kind: 'result'; durationMs?: number; costUsd?: number; turns?: number; agentSteps?: number; subscription?: boolean }
  | { kind: 'error'; message: string });

export type VoiceServerMsg =
  | { type: 'ready'; provider: string; model: string }
  | { type: 'transcript'; role: 'user' | 'assistant'; delta?: string; text?: string; final: boolean }
  | { type: 'speech_started' }
  | ToolEvent
  | HandoffEvent
  | ClaudeProposalEvent
  | { type: 'viz'; spec: VizSpec }
  | { type: 'usage'; seconds: number; costUsd: number }
  | { type: 'error'; message: string; fallback?: string }
  | { type: 'closed' };

export interface PageContext { slug: string; title?: string; t: number; sceneId?: string; pointId?: string; point?: { title: string; short?: string; more?: string }; transcriptNear?: string }
