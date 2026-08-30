import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

/*
 * Lightweight clients for the integration endpoints added on the api-server
 * (/api/health, /api/jira/tickets, /api/vendor/submissions). These sit outside
 * the generated @workspace/api-client-react surface, so we fetch the relative
 * /api paths directly (Vite proxies them to the api-server in dev).
 */

export type IntegrationStatus = {
  name: string;
  configured: boolean;
  status: 'ok' | 'error' | 'not_configured';
  latencyMs?: number;
  message?: string;
};

export type JiraTicket = {
  id: string;
  key: string;
  summary: string;
  status: string;
  assignee: string;
  environment: 'SIT' | 'UAT' | 'STAGING' | 'PROD';
  updatedAt: string;
};

export type VendorSubmission = {
  vendorId: string;
  type: 'invoice' | 'delivery' | 'milestone' | 'po_acceptance';
  poNumber: string;
  amount: number;
  submittedAt: string;
};

type HealthResponse = { integrations: IntegrationStatus[] };
type IntegrationFeed = {
  source: string;
  degraded?: boolean;
  message?: string;
};
type JiraResponse = IntegrationFeed & { tickets: JiraTicket[] };
type VendorResponse = IntegrationFeed & { submissions: VendorSubmission[] };

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return (await res.json()) as T;
}

function getHealth() {
  return getJSON<HealthResponse>('/api/health');
}
function getJiraTickets() {
  return getJSON<JiraResponse>('/api/jira/tickets');
}
function getVendorSubmissions() {
  return getJSON<VendorResponse>('/api/vendor/submissions');
}

export const integrationsKey = ['integrations', 'health'] as const;
export const jiraTicketsKey = ['integrations', 'jira', 'tickets'] as const;
export const vendorSubmissionsKey = ['integrations', 'vendor', 'submissions'] as const;

export function useIntegrationHealth() {
  return useQuery({
    queryKey: integrationsKey,
    queryFn: getHealth,
    refetchInterval: 30000,
  });
}

export function useJiraTickets() {
  return useQuery({
    queryKey: jiraTicketsKey,
    queryFn: getJiraTickets,
    refetchInterval: 30000,
  });
}

export function useVendorSubmissions() {
  return useQuery({
    queryKey: vendorSubmissionsKey,
    queryFn: getVendorSubmissions,
    refetchInterval: 30000,
  });
}

export function useRefreshIntegrations() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await Promise.all([getHealth(), getJiraTickets(), getVendorSubmissions()]);
      return true;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['integrations'] });
    },
  });
}
