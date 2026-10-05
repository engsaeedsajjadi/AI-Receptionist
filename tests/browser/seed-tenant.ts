import { db } from "@/db";
import { agents, appointments, calls, customers, knowledgeDocuments, knowledgeChunks, leads, properties } from "@/db/schema";

/**
 * Domain fixtures for the browser journeys. Everything is written to the
 * disposable tenant created by global-setup; nothing is fetched from a provider
 * and no external service is contacted.
 */
export async function seedBrowserTenant(businessId: string, businessName: string) {
  const [agent] = await db
    .insert(agents)
    .values({
      businessId,
      name: `منشی ${businessName}`,
      language: "fa-IR",
      systemPrompt: "شما منشی هوشمند یک آژانس املاک هستید و فقط بر اساس پایگاه دانش پاسخ می‌دهید.",
      configuration: { greeting: "سلام، آژانس املاک آرنا در خدمت شماست." },
      isActive: true,
    })
    .returning();

  const propertyTitle = "آپارتمان ۹۵ متری سعادت‌آباد";
  await db.insert(properties).values({
    businessId,
    code: "E2E-100",
    title: propertyTitle,
    transactionType: "sale",
    propertyType: "آپارتمان",
    city: "تهران",
    neighborhood: "سعادت‌آباد",
    location: "تهران، سعادت‌آباد، خیابان سرو",
    price: "12500000000",
    priceCurrency: "TOMAN",
    area: "95",
    bedrooms: 2,
    features: ["پارکینگ", "آسانسور"],
    isAvailable: true,
  });
  await db.insert(properties).values({
    businessId,
    code: "E2E-101",
    title: "ویلا ۳۰۰ متری رامسر",
    transactionType: "rent",
    propertyType: "ویلا",
    city: "رامسر",
    location: "رامسر، ساحل",
    price: "200000000",
    area: "300",
    bedrooms: 4,
    features: ["استخر"],
    isAvailable: true,
  });

  const knowledgeTitle = "قوانین کمیسیون و ساعات کاری";
  const [document] = await db
    .insert(knowledgeDocuments)
    .values({
      businessId,
      title: knowledgeTitle,
      content: "کمیسیون فروش در این مجموعه دو درصد مبلغ قرارداد است. دفتر از شنبه تا پنجشنبه از ساعت ۹ تا ۱۸ باز است.",
      status: "indexed",
      lifecycle: "ACTIVE",
      sourceType: "manual",
      visibility: "TENANT",
      acl: {},
    })
    .returning();
  await db.insert(knowledgeChunks).values({
    businessId,
    documentId: document.id,
    chunkIndex: 0,
    content: "کمیسیون فروش در این مجموعه دو درصد مبلغ قرارداد است.",
    tokenCount: 12,
    metadata: {},
  });

  const customerPhone = "09121112233";
  const [customer] = await db
    .insert(customers)
    .values({ businessId, phone: customerPhone, name: "مهدی رضایی", email: "mahdi@e2e.example.com" })
    .returning();
  await db.insert(leads).values({
    businessId,
    customerId: customer.id,
    type: "BUY",
    status: "NEW",
    location: "تهران",
    bedrooms: 2,
    timeframe: "این ماه",
    notes: "خریدار آپارتمان دو خوابه در تهران",
  });
  await db.insert(calls).values({
    businessId,
    agentId: agent.id,
    customerId: customer.id,
    phoneNumber: customerPhone,
    direction: "INBOUND",
    status: "COMPLETED",
    durationSeconds: 142,
    summary: "مشتری درباره آپارتمان سعادت‌آباد پرسید و برای بازدید هماهنگ شد.",
    transcript: "منشی: سلام\nمشتری: برای بازدید آپارتمان تماس گرفتم",
    endedAt: new Date(),
  });
  await db.insert(appointments).values({
    businessId,
    customerId: customer.id,
    title: "بازدید آپارتمان سعادت‌آباد",
    scheduledAt: new Date(Date.now() + 3 * 86_400_000),
    durationMinutes: 45,
    status: "SCHEDULED",
  });

  return {
    agentName: `منشی ${businessName}`,
    propertyTitle,
    knowledgeTitle,
    customerPhone,
  };
}
