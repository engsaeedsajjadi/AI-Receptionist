# AI Receptionist — Enterprise voice release gates (2026-10-08)

**Scope:** GitHub branch `fix/voice-vad-pause-regression-2026-10-08` on top of `arena/01a10ae4-ai-receptionist`.

**Critical source limitation:** The latest Windows workspace at
`D:\Downloads\AI-Receptionist-arena-final\AI-Receptionist-arena-final`
has not been mounted or compared with this GitHub branch. That local workspace
reportedly uses `@google/genai` TTS, while this GitHub branch uses the
OpenAI-compatible `src/lib/providers/tts.ts`. No claim of a complete local
sync or Gemini SDK repair can be made.

## Automated evidence and code changes

- `tests/unit/voice-vad-pause-regression.test.ts`: deterministic μ-law
  utterances; a 900 ms injected pause plus 360 ms + 340 ms provider silence
  yields a 1600 ms VAD gap; thresholds 700/1200/1601/1800 tested.
- `tests/unit/voice-vad-safety.test.ts`: isolated spikes cannot accumulate
  into speech, short pauses reset on speech, elapsed-audio max duration is bounded;
  PCM16/μ-law measured duration and malformed/untyped inputs are tested.
- `src/lib/voice/audio.ts`: contiguous activation; utterance duration includes
  internal pauses; measured duration helper for uncompressed mono telephone audio.
- `src/lib/voice/turn.ts`: when an STT provider reports null/invalid duration,
  uses the original raw telephone sample count only if codec and sample rate
  allow trustworthy measurement.
- `tests/integration/voice-turn.test.ts`: checks persisted STT-minute usage
  when a fake STT response has `durationSeconds: null`.
- `scripts/diagnostics/voice-vad-wav.ts`: offline fixed WAV endpoint analysis.
- `tests/live/telephony.acceptance.ts`: outbound PSTN transport test requires
  explicit consent/arming, uses standalone TwiML, and validates the returned
  Twilio call status. It **does not** establish inbound AI-call success.

These changes are on a draft PR, not a production release.
CI must be rerun on the final head **and all jobs green on the same SHA**.

## Release acceptance matrix

| Gate | Current status | Evidence needed to close |
| --- | --- | --- |
| Local Windows source parity / secrets-safe import | **BLOCKED** | Import actual local tree to a new GitHub branch; compare files/lockfile; inspect secrets/changed deps; rerun CI |
| GitHub typecheck, lint, automated tests, migrations, coverage | **IN PROGRESS** | GitHub Actions green on final commit; never infer latest status from earlier runs |
| VAD isolated-spike and absolute-duration regression | **TESTS ADDED** | GitHub CI confirmation on same head |
| VAD with 900ms natural pause and different voices | **PARTIAL** | Offline fixed recordings, 8kHz μ-law + real Persian noise corpus; turn latency p95 |
| Gemini SDK TTS `TypeError: unusable` | **BLOCKED** | Obtain exact local `@google/genai` provider source and trace; reproduce with SDK version, timeout, streaming and response lifecycle |
| STT duration null, raw telephone audio | **CODE + TEST ADDED** | CI integration green and real STT confirmation |
| STT duration null, compressed/unknown audio | **OPEN** | Provider duration or validated local decoding; **never bill an unmeasured duration as proven** |
| `فردا ساعت ۱۰` in caller timezone | **OPEN** | Fixed-clock Persian date parser tests, saved appointment in Asia/Tehran, DST/timezone boundaries, conflict/idempotency |
| PSTN outbound connectivity | **LIVE BLOCKED** | Authorized Twilio account/number, consented destination; explicit live suite with charge opt-in |
| Real inbound PSTN → signed webhook → media WebSocket → STT → agent → TTS → caller | **LIVE BLOCKED** | Human dial-in to provisioned number, tenant routing, actual audible Persian exchange, no silent drops |
| Barge-in / double-talk / DTMF handoff | **LIVE BLOCKED** | Test interruption discards previous audio and reaches human destination |
| Usage/billing vs carrier CDR | **LIVE BLOCKED** | Compare call durations, TTS characters, STT minutes, invoice, refund and quota |
| Real payment, SMTP, OAuth/SCIM, object storage | **LIVE BLOCKED** | Non-production accounts, isolated tenant data and repeatable receipts |
| Browser RTL/mobile accessibility | **CI SUPPORTED** | All Playwright jobs green on final release SHA |
| Backup restore, Docker, SBOM, Trivy and staging soak | **PARTIAL** | Final CI restore + image scan; production-like HA/load/failover measurements |
| n8n runner and independent security assessment | **OPEN** | Harden runner; authenticated vulnerability and tenant-isolation penetration tests |

## Required execution order

1. Sync local source to GitHub on a **new branch**, excluding credentials, large
   runtime artefacts, private uploads and local DB copies.
2. Run `npm ci`, `npm run lint`, `npm run typecheck`,
   `npm run test:coverage`, `npm run build` and migrations against an
   **isolated disposable** database. Do not change schema in production.
3. Run the new deterministic tests first:
   `npx vitest run tests/unit/voice-vad-pause-regression.test.ts tests/unit/voice-vad-safety.test.ts`.
4. Replay consented fixed audio with:
   `npx tsx scripts/diagnostics/voice-vad-wav.ts path/to/test.wav 700,1200,1800`.
   **Do not set 1800 as the production default** without measuring turn latency.
5. Resolve local Gemini TTS network/SDK issue against its actual source tree.
6. Run STT, TTS, telephony, identity, storage and payment live acceptance
   only with explicit sandbox/staging credentials and disposable test data.
7. Final sign-off requires all same-commit CI jobs green plus separate live
   PSTN, payment, provider and human acceptance evidence; otherwise keep PR as draft.

**Security:** Never commit `.env`, access tokens, caller recordings, service
account credentials or production databases.
