import { checkSupabaseHealth } from "./supabase";
import { checkJiraHealth } from "./jira";
import { checkVendorHealth } from "./vendor";
import { checkDatabaseHealth } from "../lib/db-runtime";
import type { IntegrationStatus } from "./config";

export async function healthRegistry(): Promise<IntegrationStatus[]> {
  const [s, j, v, db] = await Promise.all([
    checkSupabaseHealth(),
    checkJiraHealth(),
    checkVendorHealth(),
    checkDatabaseHealth(),
  ]);
  return [db, s, j, v];
}
