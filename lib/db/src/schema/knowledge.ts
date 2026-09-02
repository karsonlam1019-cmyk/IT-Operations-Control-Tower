import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// The embedding vector(1024) column is enabled via the pgvector extension in
// the SQL migration (drizzle-kit does not bundle pg-vector's vector type by
// default in this setup), so it is defined in schema.sql and omitted here.
export const policyChunks = pgTable("policy_chunks", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  documentName: text("document_name").notNull(),
  pageNumber: integer("page_number"),
  paragraphIndex: integer("paragraph_index").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: false }).default(sql`NOW()`),
});
