/**
 * Persian (Farsi) text / number / phone normalization.
 *
 * Covers:
 * - Persian/Arabic character unification (ی/ي, ک/ك, ة/ه, digits)
 * - Arabic diacritics (tashkeel) removal for search
 * - Persian/Arabic/English digits → English digits
 * - Spoken Persian numbers ("دو و نیم میلیارد", "صد و بیست")
 * - Currency words (تومان/تومن/ریال, هزار/میلیون/میلیارد)
 * - Iranian phone numbers (mobile 09xxxxxxxxx + landlines)
 * - Area ("هشتاد متر") and bedroom ("سه خوابه") parsing
 */

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

const DIGIT_MAP: Record<string, string> = {};
for (let i = 0; i < 10; i++) {
  DIGIT_MAP[PERSIAN_DIGITS[i]] = String(i);
  DIGIT_MAP[ARABIC_DIGITS[i]] = String(i);
  DIGIT_MAP[String(i)] = String(i);
}

/** Arabic diacritics / tashkeel + tatweel, stripped for search normalization. */
const TASHKEEL_RE = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/**
 * Canonical Persian text normalization:
 * ي→ی, ك→ک, ة→ه, ؤ→و, ئ→ی, digits→English, tashkeel removed,
 * whitespace collapsed.
 */
export function normalizePersianText(value: string): string {
  if (!value) return "";
  return value
    .replaceAll("ي", "ی")
    .replaceAll("ى", "ی")
    .replaceAll("ك", "ک")
    .replaceAll("ة", "ه")
    .replaceAll("ؤ", "و")
    .replaceAll("ئ", "ی")
    .replace(TASHKEEL_RE, "")
    .replace(/[٠-٩۰-۹]/g, (d) => DIGIT_MAP[d] ?? d)
    .replace(/[\u200B\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercased search form (for latin-mixed content). */
export function normalizeForSearch(value: string): string {
  return normalizePersianText(value).toLowerCase();
}

/** Convert any Persian/Arabic/English digit run to English digits. */
export function normalizeDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹0-9]/g, (d) => DIGIT_MAP[d] ?? d);
}

// ---------------------------------------------------------------------------
// Spoken Persian numbers
// ---------------------------------------------------------------------------

const WORD_NUMBERS: Record<string, number> = {
  صفر: 0,
  یک: 1,
  یه: 1,
  دو: 2,
  سه: 3,
  چهار: 4,
  چار: 4,
  پنج: 5,
  شش: 6,
  شیش: 6,
  هفت: 7,
  هشت: 8,
  نه: 9,
  ده: 10,
  یازده: 11,
  ازده: 11,
  دوازده: 12,
  سیزده: 13,
  چهارده: 14,
  پانزده: 15,
  پونزده: 15,
  شانزده: 16,
  شونزده: 16,
  هفده: 17,
  هیفده: 17,
  هجده: 18,
  هیجده: 18,
  نوزده: 19,
  نونزده: 19,
  بیست: 20,
  سی: 30,
  چهل: 40,
  چل: 40,
  پنجاه: 50,
  پنجا: 50,
  شصت: 60,
  شست: 60,
  هفتاد: 70,
  هفتادو: 70,
  هشتاد: 80,
  هشتادو: 80,
  نود: 90,
  صد: 100,
  یکصد: 100,
  دویست: 200,
  سیصد: 300,
  چهارصد: 400,
  پانصد: 500,
  پونصد: 500,
  ششصد: 600,
  شیشصد: 600,
  هفتصد: 700,
  هشتصد: 800,
  نهصد: 900,
  هزار: 1000,
  میلیون: 1_000_000,
  ملیون: 1_000_000,
  میلیارد: 1_000_000_000,
  ملیارد: 1_000_000_000,
  تریلیون: 1_000_000_000_000,
  هزارمیلیارد: 1_000_000_000_000,
};

const HALF_WORDS = new Set(["نیم", "نصف"]);

/**
 * Parse a spoken/written Persian number into a numeric value.
 * Handles digit strings, word numbers, scales (هزار/میلیون/میلیارد),
 * "و" separators and halves ("دو و نیم میلیارد" → 2.5e9).
 * Returns null when no number can be determined.
 */
export function parsePersianNumber(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  const text = normalizePersianText(String(input)).replace(/[\u200c\u200d]/g, " ");
  if (!text) return null;

  // Fast path: pure digit string (supports decimals, thousands separators, negatives).
  const compact = text.replace(/[,\s٬_]/g, "");
  if (/^-?\d+(\.\d+)?$/.test(compact)) {
    const n = Number(compact);
    return Number.isFinite(n) ? n : null;
  }

  const tokens = text.split(" ").filter(Boolean);
  let total = 0;
  let current = 0;
  let lastScale = 1;
  let seen = false;

  const flushScale = (scale: number) => {
    if (scale >= 1000) {
      current = (current || 1) * scale;
      total += current;
      current = 0;
      lastScale = scale;
    } else {
      current += scale;
      lastScale = 1;
    }
  };

  for (const rawToken of tokens) {
    const token = rawToken.replace(/^(و|به|از|در|تا)$/, "");
    if (!token || token === "و") continue;

    // Embedded digits: "2خوابه", "80متری", "3.5".
    const digitPrefix = token.match(/^(-?\d+(?:\.\d+)?)(.*)$/);
    if (digitPrefix) {
      const n = Number(digitPrefix[1]);
      const rest = digitPrefix[2];
      seen = true;
      if (rest) {
        const scale = WORD_NUMBERS[rest];
        if (scale != null && scale >= 1000) {
          total += n * scale;
          lastScale = scale;
          continue;
        }
      }
      current += n;
      continue;
    }

    if (HALF_WORDS.has(token)) {
      seen = true;
      if (current === 0 && lastScale >= 1000) {
        // "دو میلیارد و نیم" → +0.5 میلیارد
        total += 0.5 * lastScale;
      } else {
        current += 0.5;
      }
      continue;
    }

    const value = WORD_NUMBERS[token];
    if (value == null) continue;
    seen = true;
    flushScale(value);
  }

  if (!seen) return null;
  const result = total + current;
  return result > 0 || (result === 0 && seen) ? result : null;
}

/** Backwards-compatible alias. */
export const normalizeNumberInput = parsePersianNumber;

// ---------------------------------------------------------------------------
// Currency / price parsing (تومان / ریال)
// ---------------------------------------------------------------------------

const TUMAN_WORDS = new Set(["تومان", "تومن", "توما", "ت", "toman", "tuman"]);
const RIAL_WORDS = new Set(["ریال", "ریال", "rial"]);

export type ParsedPrice = {
  /** Value normalized to تومان. */
  amountToman: number;
  /** Currency word found in the input (if any). */
  currency: "TOMAN" | "RIAL" | null;
  /** Raw numeric value before ریال→تومان conversion. */
  rawAmount: number;
};

/**
 * Parse Persian price expressions. Returns the amount in تومان
 * (ریال values are divided by 10). Examples:
 * - "دو میلیارد تومان" → 2_000_000_000
 * - "پانصد میلیون تومن" → 500_000_000
 * - "۲۰۰ میلیون ریال" → 20_000_000 تومان
 * - "2,500,000,000" → 2_500_000_000 (unit-less)
 */
export function parsePrice(input: string | number | null | undefined): ParsedPrice | null {
  if (typeof input === "number") {
    return Number.isFinite(input) && input >= 0
      ? { amountToman: input, currency: null, rawAmount: input }
      : null;
  }
  if (input == null || String(input).trim() === "") return null;
  const normalized = normalizePersianText(String(input)).replace(/[\u200c\u200d]/g, " ").toLowerCase();

  let currency: ParsedPrice["currency"] = null;
  for (const token of normalized.split(" ").filter(Boolean)) {
    if (TUMAN_WORDS.has(token)) currency = "TOMAN";
    else if (RIAL_WORDS.has(token)) currency = "RIAL";
  }

  // Strip currency words, keep scale words for the number parser.
  const numericPart = normalized
    .split(" ")
    .filter((t) => !TUMAN_WORDS.has(t) && !RIAL_WORDS.has(t))
    .join(" ");

  const raw = parsePersianNumber(numericPart);
  if (raw == null || raw < 0) return null;
  const amountToman = currency === "RIAL" ? raw / 10 : raw;
  return { amountToman, currency, rawAmount: raw };
}

// ---------------------------------------------------------------------------
// Area / bedrooms
// ---------------------------------------------------------------------------

const AREA_WORDS = new Set(["متر", "متری", "مربع", "مترمربع", "m", "m2", "متراژ"]);

export function parseArea(input: string | number | null | undefined): number | null {
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? input : null;
  if (input == null || String(input).trim() === "") return null;
  const normalized = normalizePersianText(String(input)).replace(/[\u200c\u200d]/g, " ").toLowerCase();
  const numericPart = normalized
    .split(" ")
    .filter((t) => {
      if (AREA_WORDS.has(t)) return false;
      if (/^\d/.test(t)) return true;
      return WORD_NUMBERS[t] != null || HALF_WORDS.has(t) || t === "و";
    })
    .join(" ");
  const value = parsePersianNumber(numericPart || normalized);
  return value != null && value > 0 ? value : null;
}

const BEDROOM_WORDS = new Set(["خواب", "خوابه", "خوابها", "اتاق", "اتاقه", "bedroom", "bedrooms", "bed", "br"]);

/**
 * Parse bedroom counts: "سه خوابه" → 3, "2خوابه" → 2, "دو خواب" → 2.
 */
export function parseBedrooms(input: string | number | null | undefined): number | null {
  if (typeof input === "number") {
    return Number.isInteger(input) && input >= 0 && input <= 50 ? input : null;
  }
  if (input == null || String(input).trim() === "") return null;
  const normalized = normalizePersianText(String(input)).replace(/[\u200c\u200d]/g, " ").toLowerCase();
  const tokens = normalized.split(" ").filter(Boolean);

  // Direct digit prefix anywhere ("2خوابه", "سوئیت 1 خوابه").
  for (const token of tokens) {
    const m = token.match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const hasBedroomWord =
        BEDROOM_WORDS.has(token.replace(m[1], "")) ||
        tokens.some((t) => BEDROOM_WORDS.has(t)) ||
        /خواب/.test(token);
      if (hasBedroomWord) {
        const n = Math.floor(Number(m[1]));
        if (Number.isFinite(n) && n >= 0 && n <= 50) return n;
      }
    }
  }

  const numericPart = tokens
    .filter((t) => {
      if (BEDROOM_WORDS.has(t)) return false;
      if (/سوئیت|واحد|دفتر/.test(t)) return false;
      return WORD_NUMBERS[t] != null || HALF_WORDS.has(t) || t === "و";
    })
    .join(" ");
  if (!numericPart) return null;
  // Only accept when a bedroom keyword is present (avoid misreading prices).
  if (!tokens.some((t) => BEDROOM_WORDS.has(t) || /خواب/.test(t))) return null;
  const value = parsePersianNumber(numericPart);
  if (value == null || !Number.isFinite(value) || value < 0 || value > 50) return null;
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// Iranian phone numbers
// ---------------------------------------------------------------------------

/**
 * Normalize an Iranian phone number.
 * - Mobile: 09xxxxxxxxx, +989xxxxxxxxx, 00989xxxxxxxxx, 989xxxxxxxxx → 09xxxxxxxxx
 * - Landline: 0XXXXXXXXXX (e.g. 021...) → kept as 0-prefixed digits
 * Returns null for invalid input.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (input == null) return null;
  let digits = normalizeDigits(String(input)).replace(/\D/g, "");
  if (!digits) return null;

  // International formats → national.
  if (digits.startsWith("0098")) digits = "0" + digits.slice(4);
  else if (digits.startsWith("98") && digits.length === 12) digits = "0" + digits.slice(2);
  else if (digits.startsWith("98") && digits.length > 10) digits = "0" + digits.slice(2);

  // Mobile without leading zero: 9xxxxxxxxx (10 digits) → 09xxxxxxxxx.
  if (/^9\d{9}$/.test(digits)) digits = "0" + digits;

  if (/^09\d{9}$/.test(digits)) return digits; // mobile
  if (/^0\d{10}$/.test(digits)) return digits; // landline (11 digits incl. 0)
  if (/^0\d{9,10}$/.test(digits)) return digits; // short landline forms
  return null;
}

/** E.164 form (+98...) for a normalized Iranian number, or null. */
export function toE164Iran(phone: string | null | undefined): string | null {
  const normalized = normalizePhone(phone);
  if (!normalized || !normalized.startsWith("0")) return null;
  return `+98${normalized.slice(1)}`;
}

/** Mask a phone for display/logging: 0912****345. */
export function maskPhone(phone: string | null | undefined): string {
  const normalized = normalizePhone(phone);
  if (!normalized || normalized.length < 7) return "***";
  return `${normalized.slice(0, 4)}****${normalized.slice(-3)}`;
}

// ---------------------------------------------------------------------------
// Property identifiers / misc
// ---------------------------------------------------------------------------

/** Normalize a property code/identifier for lookup (digits + uppercase latin). */
export function normalizePropertyCode(input: string | null | undefined): string | null {
  if (input == null) return null;
  const normalized = normalizePersianText(String(input)).toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return normalized || null;
}

/** Format a تومان amount for Persian display: 2500000000 → "۲٬۵۰۰٬۰۰۰٬۰۰۰ تومان". */
export function formatTomanFa(amount: number | string): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return "—";
  const grouped = Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
  const fa = grouped.replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]);
  return `${fa} تومان`;
}
