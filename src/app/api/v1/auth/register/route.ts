import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { agents, businesses, users } from "@/db/schema";
import { ok, parseJsonWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { buildAgentPrompt } from "@/lib/agent-prompt";
import { hashPassword, issueAuthTokens, validatePasswordPolicy } from "@/lib/auth";
import { normalizePersianText, normalizePhone } from "@/lib/normalization";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withApiHandling } from "@/lib/server-core";

const registerSchema = z.object({
  businessName: z.string().min(2).max(255),
  businessSlug: z
    .string()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, digits and hyphens"),
  name: z.string().min(2).max(150),
  email: z.string().email().max(255),
  phone: z.string().max(30).optional(),
  password: z.string().min(8).max(128),
});

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await enforceRateLimit(req, "login");

    const body = await parseJsonWith(req, registerSchema);
    validatePasswordPolicy(body.password);

    const email = body.email.toLowerCase().trim();
    const slug = body.businessSlug.trim().toLowerCase();
    const phone = body.phone ? (normalizePhone(body.phone) ?? normalizePersianText(body.phone)) : null;

    const existingUser = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existingUser.length > 0) throw new AppError(409, "EMAIL_EXISTS", "Email already exists");

    const existingBiz = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.slug, slug)).limit(1);
    if (existingBiz.length > 0) throw new AppError(409, "SLUG_EXISTS", "Business slug already exists");

    const passwordHash = await hashPassword(body.password);

    const result = await db.transaction(async (tx) => {
      const [biz] = await tx
        .insert(businesses)
        .values({
          name: normalizePersianText(body.businessName),
          slug,
          phone,
          industry: "real_estate",
        })
        .returning();

      const [user] = await tx
        .insert(users)
        .values({
          businessId: biz.id,
          name: normalizePersianText(body.name),
          email,
          phone,
          passwordHash,
          role: "ADMIN",
        })
        .returning();

      await tx.insert(agents).values({
        businessId: biz.id,
        name: "منشی هوشمند",
        systemPrompt: buildAgentPrompt({
          businessName: biz.name,
          businessContext: "دفتر املاک - پاسخ‌گویی تماس‌ها و ثبت سرنخ",
        }),
      });

      return { biz, user };
    });

    const tokens = await issueAuthTokens({ userId: result.user.id, businessId: result.biz.id, role: "ADMIN" });

    return ok(
      {
        business: result.biz,
        user: {
          id: result.user.id,
          businessId: result.user.businessId,
          name: result.user.name,
          email: result.user.email,
          role: result.user.role,
        },
        ...tokens,
      },
      201,
    );
  });
}
