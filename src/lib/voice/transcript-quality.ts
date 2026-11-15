/**
 * Speech recognizers (Whisper in particular) answer non-speech audio — line
 * echo, a fan, the assistant's own voice leaking into the microphone — with a
 * confident loop of one or two words repeated dozens of times. Passing that to
 * the assistant produces a reply to something nobody said and pollutes the
 * conversation history, so such a transcript is treated as "nothing heard".
 *
 * Deliberately conservative: short emphatic repeats a caller really says
 * («نه نه نه», «بله بله») and digit strings are never rejected.
 */
const MIN_TOKENS = 8;
const MAX_UNIQUE_RATIO = 0.25;
const MAX_CONSECUTIVE_REPEATS = 6;

function tokens(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(/[‌‍]/g, "")
    .replace(/[.,،؛;:!?؟«»"'()\[\]…-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function isDegenerateTranscript(text: string | null | undefined): boolean {
  const words = tokens(text ?? "");
  if (words.length < MIN_TOKENS) return false;

  // The same word, or the same two/three-word phrase, back to back many times.
  for (const size of [1, 2, 3]) {
    let run = 1;
    for (let i = size; i + size <= words.length; i += 1) {
      const same = words.slice(i, i + size).join(" ") === words.slice(i - size, i).join(" ");
      if (!same) { run = 1; continue; }
      // Advancing one word at a time, a phrase of `size` words repeats every `size` steps.
      run += 1 / size;
      if (run >= MAX_CONSECUTIVE_REPEATS) return true;
    }
  }

  // A long utterance made of almost no distinct words.
  return new Set(words).size / words.length <= MAX_UNIQUE_RATIO;
}
