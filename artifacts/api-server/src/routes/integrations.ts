import { Router, type IRouter } from "express";
import { healthRegistry } from "../integrations/registry";
import { listJiraTickets } from "../integrations/jira";
import { listVendorSubmissions } from "../integrations/vendor";

const router: IRouter = Router();

router.get("/health", async (_req, res) => {
  const statuses = await healthRegistry();
  res.json({ integrations: statuses });
});

// /api/jira/tickets — work queue from Jira (falls back to representative data)
router.get("/jira/tickets", async (_req, res) => {
  const feed = await listJiraTickets();
  res.json(feed);
});

// /api/vendor/submissions — vendor invoices/milestones via the vendor API
router.get("/vendor/submissions", async (_req, res) => {
  const feed = await listVendorSubmissions();
  res.json(feed);
});

export default router;
