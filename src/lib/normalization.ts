const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
const arabicDigits = "٠١٢٣٤٥٦٧٨٩";

export function normalizePersianText(value: string) {
  return value
    .replaceAll("ي", "ی")
    .replaceAll("ك", "ک")
    .replace(/[٠-٩]/g, (d) => String(arabicDigits.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(persianDigits.indexOf(d)))
    .replace(/\s+/g, " ")
    .trim();
}

const wordToNumber: Record<string, number> = {
  صفر: 0,
  یک: 1,
  دو: 2,
  سه: 3,
  چهار: 4,
  پنج: 5,
  شش: 6,
  هفت: 7,
  هشت: 8,
  نه: 9,
  ده: 10,
  بیست: 20,
  سی: 30,
  چهل: 40,
  پنجاه: 50,
  شصت: 60,
  هفتاد: 70,
  هشتاد: 80,
  نود: 90,
  صد: 100,
  هزار: 1000,
  میلیون: 1000000,
  میلیارد: 1000000000,
};

export function normalizeNumberInput(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;

  const normalized = normalizePersianText(input);
  const numeric = normalized.replace(/[^\d.-]/g, "");
  if (numeric && Number.isFinite(Number(numeric))) return Number(numeric);

  const tokens = normalized.split(" ").filter(Boolean);
  let total = 0;
  let current = 0;

  for (const token of tokens) {
    const value = wordToNumber[token];
    if (value == null) continue;

    if (value >= 1000) {
      current = (current || 1) * value;
      total += current;
      current = 0;
    } else {
      current += value;
    }
  }

  const result = total + current;
  return result > 0 ? result : null;
}
