import { Router, type IRouter } from "express";
import { healthRegistry } from "../integrations/registry";
import { deepseek, type RagAnswer } from "../integrations/deepseek";
import { listJiraTickets, listJiraUpcomingTasks } from "../integrations/jira";
import { listVendorSubmissions } from "../integrations/vendor";

const router: IRouter = Router();

router.get("/health", async (_req, res) => {
  const statuses = await healthRegistry();
  res.json({ integrations: statuses });
});

router.get("/rag/documents", (_req, res) => {
  res.json({ documents: deepseek.documents });
});

router.post("/rag/search", async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    res.status(400).json({ error: "Enter a compliance question" });
    return;
  }
  const result: RagAnswer = await deepseek.search(query);
  res.json(result);
});

// /api/jira/tickets — upcoming, outstanding work from Jira
router.get("/jira/tickets", async (_req, res) => {
  const liveTickets = await listJiraUpcomingTasks();
  if (liveTickets) {
    res.json({ tickets: liveTickets, source: "Jira · next 30 days" });
    return;
  }
  res.json({ tickets: await listJiraTickets(), source: "representative" });
});

// /api/vendor/submissions — vendor invoices/milestones via the vendor API
router.get("/vendor/submissions", async (_req, res) => {
  const feed = await listVendorSubmissions();
  res.json(feed);
});

export default router;
