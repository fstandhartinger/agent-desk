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
