import { checkSupabaseHealth } from "./supabase";
import { checkDeepSeekHealth } from "./deepseek";
import { checkJiraHealth } from "./jira";
import { checkVendorHealth } from "./vendor";
import { checkDatabaseHealth } from "../lib/db-runtime";
import type { IntegrationStatus } from "./config";

export async function healthRegistry(): Promise<IntegrationStatus[]> {
  const [s, d, j, v, db] = await Promise.all([
    checkSupabaseHealth(),
    checkDeepSeekHealth(),
    checkJiraHealth(),
    checkVendorHealth(),
    checkDatabaseHealth(),
  ]);
  return [db, s, d, j, v];
}
