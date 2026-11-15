# AI provider profiles

Which AI services the receptionist uses is a deployment choice, made in the
server's environment file. Two supported profiles ship in `deploy/profiles/`:

| Profile | Model, speech recognition, voice | Needs | Use when |
| --- | --- | --- | --- |
| `gemini-cloud.env.example` | Google Gemini for all three | A server that reaches Google directly; one Gemini API key | The server is hosted outside Iran |
| `local-models.env.example` | Your own OpenAI-compatible model server + local Piper voice | A GPU server | No traffic may leave your network |

## Selecting or switching a profile

1. Open the profile and copy its lines into the server's environment file,
   replacing the previous AI block (every `LLM_`, `COMPATIBLE_LLM_`, `STT_`,
   `TTS_`, `PIPER_TTS_` and `EMBEDDING_` line).
2. Fill the empty values. Model and voice names are the ones that already work
   in your development `.env.local`.
3. Restart the app and the media server. In production the server refuses to
   start if a credential the profile needs is missing, or if any provider is
   still `dev`.

Nothing else changes: database, secrets, telephony and billing settings are not
part of a profile.

## Things to know before switching

- **Embeddings are tied to the profile.** Knowledge-base vectors written under
  one embedding model cannot be searched with another. After switching profile,
  re-index the knowledge base. The vector column is 1536 wide; the embedding
  model must return 1536-dimensional vectors.
- **One compatible endpoint.** The chat model, `STT_PROVIDER=compatible` and
  `EMBEDDING_PROVIDER=compatible` share `COMPATIBLE_LLM_BASE_URL` and its key.
  A mix such as "Gemini chat model + a different compatible speech server" is
  not expressible today.
- **Voice allow-list.** A `TTS_VOICE` that is not built in must be listed in
  `TTS_ALLOWED_VOICE_IDS`, otherwise replies fail with "Voice cloning is
  disabled".
- **Not verified here.** `tests/unit/provider-profiles.test.ts` proves each
  profile passes production configuration checks. It does not call any
  provider: run `npm run test:live:llm`, `test:live:stt`, `test:live:tts` and
  `test:live:embedding` on the server, with its real key, before going live.
