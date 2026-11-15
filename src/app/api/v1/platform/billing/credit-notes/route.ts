import { NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { ok, parseJsonWith } from "@/lib/api";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { CreditNoteSchema, issueCreditNote } from "@/lib/services/payments";

/** Platform-only credit note (append-only correction, no invoice rewrite). */
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    return ok(await issueCreditNote(auth.userId, await parseJsonWith(req, CreditNoteSchema)), 201);
  });
}
