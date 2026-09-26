import { describe, expect, it } from "vitest";
import {
  formatTomanFa,
  maskPhone,
  normalizeDigits,
  normalizeForSearch,
  normalizePersianText,
  normalizePropertyCode,
  normalizePhone,
  parseArea,
  parseBedrooms,
  parsePersianNumber,
  parsePrice,
  toE164Iran,
} from "@/lib/normalization";

describe("normalizePersianText", () => {
  it("unifies Arabic Yeh/Kaf/Teh-Marbuta", () => {
    expect(normalizePersianText("علي كتاب مدرسة")).toBe("علی کتاب مدرسه");
    expect(normalizePersianText("ى")).toBe("ی");
    expect(normalizePersianText("مؤسسه")).toBe("موسسه");
  });

  it("converts Persian and Arabic digits to English", () => {
    expect(normalizePersianText("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
    expect(normalizePersianText("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(normalizePersianText("پلاک ۱۲")).toBe("پلاک 12");
  });

  it("strips tashkeel and collapses whitespace", () => {
    expect(normalizePersianText("مُحَمَّد   رضا")).toBe("محمد رضا");
    expect(normalizePersianText("  سلام   دنیا  ")).toBe("سلام دنیا");
  });

  it("handles empty input", () => {
    expect(normalizePersianText("")).toBe("");
  });
});

describe("normalizeDigits / normalizeForSearch", () => {
  it("normalizes digit runs", () => {
    expect(normalizeDigits("۰۹۱۲۳۴۵۶۷۸۹")).toBe("09123456789");
  });
  it("lowercases latin content for search", () => {
    expect(normalizeForSearch("Villa ۱۲")).toBe("villa 12");
  });
});

describe("parsePersianNumber", () => {
  it("parses digit strings with separators", () => {
    expect(parsePersianNumber("2,500,000")).toBe(2500000);
    expect(parsePersianNumber("۲٬۵۰۰٬۰۰۰")).toBe(2500000);
    expect(parsePersianNumber("-42")).toBe(-42);
    expect(parsePersianNumber(123)).toBe(123);
  });

  it("parses spoken word numbers", () => {
    expect(parsePersianNumber("صد و بیست")).toBe(120);
    expect(parsePersianNumber("هشتاد")).toBe(80);
    expect(parsePersianNumber("دویست و سی و پنج")).toBe(235);
    expect(parsePersianNumber("یازده")).toBe(11);
    expect(parsePersianNumber("نهصد")).toBe(900);
  });

  it("parses scale words", () => {
    expect(parsePersianNumber("دو میلیارد")).toBe(2_000_000_000);
    expect(parsePersianNumber("پانصد میلیون")).toBe(500_000_000);
    expect(parsePersianNumber("سه هزار")).toBe(3000);
  });

  it("parses halves", () => {
    expect(parsePersianNumber("دو و نیم میلیارد")).toBe(2_500_000_000);
    expect(parsePersianNumber("یک و نیم")).toBe(1.5);
    expect(parsePersianNumber("نیم")).toBe(0.5);
  });

  it("returns null for non-numeric input", () => {
    expect(parsePersianNumber("سلام دنیا")).toBeNull();
    expect(parsePersianNumber("")).toBeNull();
    expect(parsePersianNumber(null)).toBeNull();
    expect(parsePersianNumber(undefined)).toBeNull();
  });
});

describe("parsePrice", () => {
  it("parses toman amounts", () => {
    expect(parsePrice("دو میلیارد تومان")?.amountToman).toBe(2_000_000_000);
    expect(parsePrice("پانصد میلیون تومن")?.amountToman).toBe(500_000_000);
    expect(parsePrice("دو میلیارد تومان")?.currency).toBe("TOMAN");
  });

  it("converts rial to toman (÷10)", () => {
    expect(parsePrice("۲۰۰ میلیون ریال")?.amountToman).toBe(20_000_000);
    expect(parsePrice("۲۰۰ میلیون ریال")?.currency).toBe("RIAL");
  });

  it("parses unit-less digit prices", () => {
    expect(parsePrice("2,500,000,000")?.amountToman).toBe(2_500_000_000);
    expect(parsePrice(1000)?.amountToman).toBe(1000);
  });

  it("handles mixed spoken + digits", () => {
    expect(parsePrice("2 میلیارد و پانصد میلیون تومان")?.amountToman).toBe(2_500_000_000);
  });

  it("returns null for invalid prices", () => {
    expect(parsePrice("")).toBeNull();
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice("گران")).toBeNull();
  });
});

describe("parseArea", () => {
  it("parses spoken areas", () => {
    expect(parseArea("هشتاد متر")).toBe(80);
    expect(parseArea("صد و بیست متر")).toBe(120);
    expect(parseArea("۱۲۰ متری")).toBe(120);
  });
  it("parses numeric areas", () => {
    expect(parseArea(95)).toBe(95);
    expect(parseArea("95")).toBe(95);
  });
  it("rejects invalid areas", () => {
    expect(parseArea("")).toBeNull();
    expect(parseArea("بزرگ")).toBeNull();
  });
});

describe("parseBedrooms", () => {
  it("parses spoken bedroom counts", () => {
    expect(parseBedrooms("سه خوابه")).toBe(3);
    expect(parseBedrooms("دو خواب")).toBe(2);
    expect(parseBedrooms("2خوابه")).toBe(2);
    expect(parseBedrooms("سوئیت 1 خوابه")).toBe(1);
  });
  it("parses numeric input", () => {
    expect(parseBedrooms(3)).toBe(3);
  });
  it("rejects ambiguous input without bedroom keywords", () => {
    expect(parseBedrooms("سه")).toBeNull();
    expect(parseBedrooms("")).toBeNull();
  });
});

describe("normalizePhone", () => {
  it("normalizes Iranian mobiles", () => {
    expect(normalizePhone("09123456789")).toBe("09123456789");
    expect(normalizePhone("+989123456789")).toBe("09123456789");
    expect(normalizePhone("00989123456789")).toBe("09123456789");
    expect(normalizePhone("989123456789")).toBe("09123456789");
    expect(normalizePhone("9123456789")).toBe("09123456789");
    expect(normalizePhone("۰۹۱۲۳۴۵۶۷۸۹")).toBe("09123456789");
    expect(normalizePhone("0912 345 6789")).toBe("09123456789");
  });

  it("keeps landlines", () => {
    expect(normalizePhone("02122334455")).toBe("02122334455");
  });

  it("rejects invalid numbers", () => {
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("abcdefghij")).toBeNull();
  });
});

describe("toE164Iran / maskPhone", () => {
  it("formats E.164", () => {
    expect(toE164Iran("09123456789")).toBe("+989123456789");
    expect(toE164Iran("invalid")).toBeNull();
  });
  it("masks for display", () => {
    expect(maskPhone("09123456789")).toBe("0912****789");
    expect(maskPhone("bad")).toBe("***");
  });
});

describe("normalizePropertyCode / formatTomanFa", () => {
  it("normalizes codes", () => {
    expect(normalizePropertyCode("apt-۱۲۳")).toBe("APT-123");
    expect(normalizePropertyCode("!!!")).toBeNull();
  });
  it("formats toman in Persian", () => {
    expect(formatTomanFa(2500000000)).toBe("۲٬۵۰۰٬۰۰۰٬۰۰۰ تومان");
    expect(formatTomanFa(NaN)).toBe("—");
  });
});
