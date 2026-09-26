import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { agents, businesses, users } from "@/db/schema";
import { ApiError, ok, parseJson } from "@/lib/api";
import { buildAgentPrompt } from "@/lib/agent-prompt";
import { hashPassword, issueAuthTokens } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { checkRateLimit, withApiHandling } from "@/lib/server-core";

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    checkRateLimit(`register:${req.headers.get("x-forwarded-for") ?? "ip"}`, 5, 60_000);

    const body = await parseJson<{
      businessName: string;
      businessSlug: string;
      name: string;
      email: string;
      phone?: string;
      password: string;
    }>(req);

    const email = body.email.toLowerCase().trim();
    const slug = body.businessSlug.trim().toLowerCase();

    const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existingUser.length > 0) throw new ApiError(409, "EMAIL_EXISTS", "Email already exists");

    const existingBiz = await db.select().from(businesses).where(eq(businesses.slug, slug)).limit(1);
    if (existingBiz.length > 0) throw new ApiError(409, "SLUG_EXISTS", "Business slug already exists");

    const passwordHash = await hashPassword(body.password);

    const result = await db.transaction(async (tx) => {
      const [biz] = await tx
        .insert(businesses)
        .values({
          name: normalizePersianText(body.businessName),
          slug,
          phone: body.phone ?? null,
          industry: "real_estate",
        })
        .returning();

      const [user] = await tx
        .insert(users)
        .values({
          businessId: biz.id,
          name: normalizePersianText(body.name),
          email,
          phone: body.phone ?? null,
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
