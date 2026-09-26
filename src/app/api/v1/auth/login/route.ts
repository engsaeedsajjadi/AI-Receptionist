import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { ok, parseJsonWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import {
  assertNotLockedOut,
  buildRefreshCookie,
  issueAuthTokens,
  recordFailedLogin,
  recordSuccessfulLogin,
  verifyPassword,
} from "@/lib/auth";
import type { UserRole } from "@/lib/permissions";
import { enforceRateLimit } from "@/lib/rate-limit";
import { withApiHandling } from "@/lib/server-core";

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(256),
});

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await enforceRateLimit(req, "login");

    const body = await parseJsonWith(req, loginSchema);
    const email = body.email.toLowerCase().trim();

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    // Uniform error to avoid user enumeration.
    if (!user || !user.isActive) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");

    await assertNotLockedOut(user);

    const passOk = await verifyPassword(body.password, user.passwordHash);
    if (!passOk) {
      await recordFailedLogin(user.id, user.failedLoginCount);
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
    }

    await recordSuccessfulLogin(user.id);
    const tokens = await issueAuthTokens({
      userId: user.id,
      businessId: user.businessId,
      role: user.role as UserRole,
    });

    // Browser clients get the refresh token as an HttpOnly cookie;
    // native/API clients use the JSON body.
    const res = ok({
      user: {
        id: user.id,
        businessId: user.businessId,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      ...tokens,
    });
    res.headers.set("Set-Cookie", buildRefreshCookie(tokens.refreshToken));
    return res;
  });
}
