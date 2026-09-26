import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { ApiError, ok, parseJson } from "@/lib/api";
import { issueAuthTokens, verifyPassword } from "@/lib/auth";
import { checkRateLimit, withApiHandling } from "@/lib/server-core";

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    checkRateLimit(`login:${req.headers.get("x-forwarded-for") ?? "ip"}`, 5, 60_000);

    const body = await parseJson<{ email: string; password: string }>(req);
    const email = body.email.toLowerCase().trim();

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid credentials");

    const passOk = await verifyPassword(body.password, user.passwordHash);
    if (!passOk) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid credentials");

    const tokens = await issueAuthTokens({ userId: user.id, businessId: user.businessId, role: user.role });

    return ok({
      user: {
        id: user.id,
        businessId: user.businessId,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      ...tokens,
    });
  });
}
