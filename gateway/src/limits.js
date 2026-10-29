import { cfg } from './config.js';
import { TEXT, waitAndRetry } from './messages.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const RATES = {
  chat: { max: 40, windowMs: 10 * MINUTE, message: 'Zu viele Nachrichten' },
  transcribe: { max: 60, windowMs: 10 * MINUTE, message: 'Zu viele Diktate' },
  claudeStart: { max: 25, windowMs: DAY, message: TEXT.claudeDaily },
};
const VOICE_MAX_CONCURRENT = 2;
const VOICE_MAX_SECONDS_PER_DAY = 90 * 60;

const dayKey = () => new Date().toISOString().slice(0, 10);

/** Failed-attempt counter per key (login, bridge token) with a sliding window. */
export class FailureLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  #recent(key, now) {
    const recent = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (recent.length) this.hits.set(key, recent);
    else this.hits.delete(key);
    return recent;
  }

  /** Seconds until another attempt is allowed, or 0. */
  retryAfter(key, now = Date.now()) {
    const recent = this.#recent(key, now);
    if (recent.length < this.max) return 0;
    return Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000));
  }

  fail(key, now = Date.now()) {
    this.hits.set(key, [...this.#recent(key, now), now]);
  }

  reset(key) {
    this.hits.delete(key);
  }
}

export class Limits {
  constructor() {
    this.rate = new Map();
    this.cost = new Map();
    this.voice = new Map();
    this.voiceSeconds = new Map();
  }

  /**
   * kind: chat | transcribe | claudeStart (consume one slot of a sliding window), spend (daily USD cap, read-only),
   * voice (concurrency + daily minutes, read-only; bracket a session with voiceOpen/voiceClose).
   */
  check(sid, kind) {
    const now = Date.now();
    if (kind === 'spend') {
      return this.costToday() >= cfg.dailyCapUsd() ? { ok: false, retryAfter: 3600, reason: TEXT.spendCap } : { ok: true };
    }
    if (kind === 'voice') {
      if ((this.voice.get(sid) || 0) >= VOICE_MAX_CONCURRENT) return { ok: false, retryAfter: 30, reason: TEXT.voiceBusy };
      if ((this.voiceSeconds.get(`${sid}:${dayKey()}`) || 0) >= VOICE_MAX_SECONDS_PER_DAY) return { ok: false, retryAfter: 3600, reason: TEXT.voiceMinutes };
      return { ok: true };
    }
    const rule = RATES[kind];
    if (!rule) throw new Error(`unknown limit kind: ${kind}`);
    const key = `${kind}:${sid}`;
    const recent = (this.rate.get(key) || []).filter((t) => now - t < rule.windowMs);
    if (recent.length >= rule.max) {
      this.rate.set(key, recent);
      const retryAfter = Math.max(1, Math.ceil((recent[0] + rule.windowMs - now) / 1000));
      return { ok: false, retryAfter, reason: waitAndRetry(rule.message, retryAfter) };
    }
    recent.push(now);
    this.rate.set(key, recent);
    return { ok: true };
  }

  voiceOpen(sid) {
    this.voice.set(sid, (this.voice.get(sid) || 0) + 1);
  }

  voiceClose(sid, seconds = 0) {
    this.voice.set(sid, Math.max(0, (this.voice.get(sid) || 0) - 1));
    const key = `${sid}:${dayKey()}`;
    this.voiceSeconds.set(key, (this.voiceSeconds.get(key) || 0) + seconds);
  }

  addCost(usd) {
    if (!Number.isFinite(usd) || usd <= 0) return;
    const key = dayKey();
    const total = (this.cost.get(key) || 0) + usd;
    this.cost.clear();
    this.cost.set(key, total);
  }

  costToday() {
    return this.cost.get(dayKey()) || 0;
  }

  snapshot() {
    return {
      rates: RATES,
      voice: { maxConcurrent: VOICE_MAX_CONCURRENT, maxSecondsPerDay: VOICE_MAX_SECONDS_PER_DAY },
      spendTodayUsd: Number(this.costToday().toFixed(4)),
      dailyCapUsd: cfg.dailyCapUsd(),
    };
  }
}

export const limits = new Limits();
