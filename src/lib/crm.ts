/**
 * Backwards-compatible CRM helpers (re-exported from the customer service).
 * New code should import from `@/lib/services/customers` directly.
 */
export {
  findOrCreateCustomer,
  getCustomer,
  getCustomerHistory,
  updateCustomer,
} from "@/lib/services/customers";
export type { CustomerInput } from "@/lib/services/customers";
