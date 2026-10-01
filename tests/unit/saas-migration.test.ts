import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
describe("enterprise SaaS migration contract",()=>{
 const sql=readFileSync("drizzle/0004_enterprise_saas.sql","utf8");
 it("creates tenant, membership, billing and metering tables",()=>{
  for(const table of ["tenants","tenant_workspaces","tenant_users","plans","subscriptions","invoices","payment_history","usage_meters"]) expect(sql).toContain("CREATE TABLE IF NOT EXISTS "+table);
 });
 it("backfills existing businesses without deleting operational scope",()=>{
  expect(sql).toContain("INSERT INTO tenants");
  expect(sql).toContain("INSERT INTO tenant_workspaces");
  expect(sql).toContain("ON CONFLICT");
  expect(sql).not.toMatch(/DROP TABLE\s+businesses/i);
 });
 it("ships all four commercial plans",()=>{for(const plan of ["FREE","STARTER","PROFESSIONAL","ENTERPRISE"]) expect(sql).toContain("'"+plan+"'");});
});