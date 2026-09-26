import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { normalizePersianText } from "@/lib/normalization";

export async function findOrCreateCustomer(input: {
  businessId: string;
  phone: string;
  name?: string;
  email?: string;
}) {
  const phone = normalizePersianText(input.phone);

  const existing = await db
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, input.businessId), eq(customers.phone, phone)))
    .limit(1);

  if (existing.length > 0) return existing[0];

  const [created] = await db
    .insert(customers)
    .values({
      businessId: input.businessId,
      phone,
      name: input.name ? normalizePersianText(input.name) : "",
      email: input.email ?? null,
    })
    .returning();

  return created;
}
