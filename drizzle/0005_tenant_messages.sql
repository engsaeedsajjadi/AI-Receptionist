ALTER TABLE "call_messages" ADD COLUMN "business_id" uuid;
--> statement-breakpoint
UPDATE call_messages m SET business_id = c.business_id FROM calls c WHERE c.id = m.call_id;
--> statement-breakpoint
ALTER TABLE call_messages ALTER COLUMN business_id SET NOT NULL;--> statement-breakpoint
ALTER TABLE "call_messages" ADD CONSTRAINT "call_messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX agents_tenant_identity_idx ON agents (business_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX calls_tenant_identity_idx ON calls (business_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX customers_tenant_identity_idx ON customers (business_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX knowledge_documents_tenant_identity_idx ON knowledge_documents (business_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX leads_tenant_identity_idx ON leads (business_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX notifications_tenant_identity_idx ON notifications (business_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX users_tenant_identity_idx ON users (business_id, id);
--> statement-breakpoint
ALTER TABLE call_messages ADD CONSTRAINT call_messages_call_id_tenant_fk FOREIGN KEY (business_id, call_id) REFERENCES calls(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE knowledge_chunks ADD CONSTRAINT knowledge_chunks_document_id_tenant_fk FOREIGN KEY (business_id, document_id) REFERENCES knowledge_documents(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE lead_notes ADD CONSTRAINT lead_notes_lead_id_tenant_fk FOREIGN KEY (business_id, lead_id) REFERENCES leads(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE lead_notes ADD CONSTRAINT lead_notes_user_id_tenant_fk FOREIGN KEY (business_id, user_id) REFERENCES users(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE leads ADD CONSTRAINT leads_customer_id_tenant_fk FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE leads ADD CONSTRAINT leads_assigned_user_id_tenant_fk FOREIGN KEY (business_id, assigned_user_id) REFERENCES users(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE calls ADD CONSTRAINT calls_customer_id_tenant_fk FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE calls ADD CONSTRAINT calls_lead_id_tenant_fk FOREIGN KEY (business_id, lead_id) REFERENCES leads(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE calls ADD CONSTRAINT calls_agent_id_tenant_fk FOREIGN KEY (business_id, agent_id) REFERENCES agents(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE appointments ADD CONSTRAINT appointments_lead_id_tenant_fk FOREIGN KEY (business_id, lead_id) REFERENCES leads(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE appointments ADD CONSTRAINT appointments_customer_id_tenant_fk FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE appointments ADD CONSTRAINT appointments_assigned_user_id_tenant_fk FOREIGN KEY (business_id, assigned_user_id) REFERENCES users(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE notifications ADD CONSTRAINT notifications_user_id_tenant_fk FOREIGN KEY (business_id, user_id) REFERENCES users(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE automation_dispatches ADD CONSTRAINT automation_dispatches_notification_id_tenant_fk FOREIGN KEY (business_id, notification_id) REFERENCES notifications(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_user_id_tenant_fk FOREIGN KEY (business_id, user_id) REFERENCES users(business_id, id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE INDEX call_messages_business_time_idx ON call_messages (business_id, timestamp);
