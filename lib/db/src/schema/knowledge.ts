import { pgTable, uuid, varchar, text, integer, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// The embedding vector(1024) column is enabled via the pgvector extension in
// the SQL migration (drizzle-kit does not bundle pg-vector's vector type by
// default in this setup), so it is defined in schema.sql and omitted here.
export const knowledgeBaseVectors = pgTable("knowledge_base_vectors", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuid_generate_v4()`),
  documentTitle: text("document_title").notNull(),
  language: varchar("language", { length: 2 }).notNull(),
  sectionReference: text("section_reference"),
  pageNumber: integer("page_number"),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`NOW()`),
});
