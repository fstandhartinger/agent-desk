# Agent Desk voice catalog and samples

Catalog sources, checked 15 November 2026:

- OpenAI Live voices: https://developers.openai.com/api/docs/guides/live-conversations
- Gemini voices: https://ai.google.dev/gemini-api/docs/speech-generation
- xAI names and genders: authenticated `GET https://api.x.ai/v1/tts/voices` returned 28 voices, matching the catalog.

OpenAI's default remains `marin`; xAI remains `eve`. Both Gemini variants use one catalog and preference. `Sulafat` (documented character: warm) is a **provisional** calm default: no listening comparison has been executed yet. The final default must be chosen after the lead runs the comparison below.

The worker protocol reserves spending to the lead. This worker made no paid generation, transcription or judging calls. Every `sample` is initially `null`, so the picker does not offer broken play buttons.

## Lead: generate and compare

```bash
node gateway/scripts/voice-samples.mjs                # dry run, no paid calls
node gateway/scripts/voice-samples.mjs --generate --rate
```

Credentials come only from environment variables `GOOGLE_API_KEY`, `XAI_API_KEY`, `OPENAI_API_KEY`. The script uses the current Gemini 3.8 TTS Interactions API (unary WAV), xAI TTS (MP3), and OpenAI Live client delegation with commentary and silence input. It converts to mono 24 kHz/48 kbps MP3. OpenAI recordings are independently transcribed using Whisper and must match the German sentence; at most one retry is allowed. Files that exist are skipped. No voice sample is exposed by the catalog until its MP3 exists and the manifest is refreshed. Rebuild the web after generation to include the static files.

The script saves call reservations and audio ratings in `docs/voice/sample-receipts.json`, and refreshes `gateway/src/voice/voice-samples.json`. The cumulative reservation cap is USD 2.90, including failed calls and previous invocations. Never delete or reset the receipt ledger to retry. Calm candidates are generated first. With `--rate`, the same Gemini audio-capable model rates seven candidates and a TTS request with no voice set. This baseline is a TTS proxy; it does not prove the identity or delivery of Gemini Live's unspecified default. If the default request fails, report it rather than substituting a guessed voice. The script does not automatically edit the default from model output: review the table and set `DEFAULT_VOICE.gemini` and `DEFAULT_VOICE['gemini-fast']` to the best calm candidate.

Pricing references (15 November 2026):

- xAI TTS USD 15 / million characters: https://docs.x.ai/developers/models
- OpenAI Live USD 0.05 / connected minute, billed per second: https://developers.openai.com/api/docs/models/gpt-live-1 (the generator uses client delegation, with no Responses backend).
- Gemini 3.8 Flash TTS USD 0.50 / million input text tokens, USD 9 / million output audio tokens through 31 December 2026: https://ai.google.dev/gemini-api/docs/pricing
- Whisper USD 0.006 / minute: https://developers.openai.com/api/docs/pricing

Reservations are conservative estimates, **not invoice totals**. Keep original provider usage receipts and record actual billed amounts when available. Generation paths have not been live exercised by this worker; vendor schema errors must be corrected within the remaining cumulative budget.

## Card opening in the central voice (23 Nov 2026)

A Screen Agent session started from a marked Telegram card begins with a short line ("<topic>. <status>. Was brauchst du?").
Until 23 Nov the laptop's Windows voice (speechSynthesis) spoke it; Florian found the quality poor. Now the gateway renders that
line ahead of time in the central narration voice (narration-voice skill: C3 Gemini 3.8 Flash TTS "Enceladus", fallback A2
OpenAI Realtime "ash"; `DESK_OPENING_VOICES=C3,A2|off`):

- `gateway/src/cardOpeningAudio.js` polls the Sandy bridge every 20 s (`notify.cardSummaries`, newest 30 card summaries),
  renders each missing line (about 3 s per line), trims the silence, caps inner pauses at 0.3 s, applies the pronunciation
  table, and checks the take by length and a Groq Whisper transcript. Cache: 80 lines in memory, keyed by the text.
- `card_opening` carries `audio: {mime: 'audio/wav', data, voice}` when the line is cached. The client plays it with an
  Audio element (must start within 200 ms), otherwise it speaks with the device voice exactly as before. A line that was not
  cached yet is queued, so the next start of that card has it.
- Traces: `card.startup.opening_audio {cached, voice}`, `card.startup.first_audio {source: prerendered|local|provider, ms,
  sinceStart}`; client event `card.opening.audio {source, ms}` and `card.opening.fallback`. Logs carry no card text.
- Live check: `node gateway/test/manual/card-opening-live.mjs` (Sandy, `bash -lc`).
