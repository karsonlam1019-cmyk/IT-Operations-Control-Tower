import {
  errorMessage,
  fetchWithTimeout,
  readEnv,
  type IntegrationStatus,
} from "./config";

export type Citation = {
  document: string;
  section: string;
  page: number;
  excerpt: string;
};

export type RagDocument = {
  id: string;
  document: string;
  section: string;
  page: number;
  content: string;
};

export type DeepSeekConfig = {
  apiKey: string;
  baseUrl: string;
  proModel: string;
  flashModel: string;
};

export const RAG_DOCUMENTS: RagDocument[] = [
  {
    id: "it-001-4.1",
    document: "SOP-IT-001 v3.2 (IT Department SOP)",
    section: "4.1 Production Release Control",
    page: 28,
    content:
      "No production release may proceed without recorded UAT sign-off, rollback readiness, and CAB authorization. Emergency changes use the expedited path but require retrospective review within one business day.",
  },
  {
    id: "it-001-4.3",
    document: "SOP-IT-001 v3.2 (IT Department SOP)",
    section: "4.3 Emergency Change Path",
    page: 31,
    content:
      "Emergency implementation must be followed by retrospective review within one business day by the head of IT or their deputy.",
  },
  {
    id: "mat-003-2.1",
    document: "SOP-MAT-003 v2.0 (Enterprise IT Approval Matrix)",
    section: "2.1 Tiered Approval Limits",
    page: 8,
    content:
      "Level 1 approvals cover PR/PO up to HKD 100,000. Level 2 covers HKD 100,001 to 500,000. Level 3 covers above HKD 500,000 and requires the Head of IT or Deputy.",
  },
  {
    id: "mat-003-2.4",
    document: "SOP-MAT-003 v2.0 (Enterprise IT Approval Matrix)",
    section: "2.4 Dual Control Rule",
    page: 11,
    content:
      "Payment overrides or schedule changes above HKD 250,000 require dual sign-off by the Head of IT and the Finance/Auditor role.",
  },
  {
    id: "proc-002-3.2",
    document: "SOP-PROC-002 v2.1 (IT Procurement & Vendor Management)",
    section: "3.2 Three-Way Matching",
    page: 19,
    content:
      "Approved PO amount must equal the vendor invoice amount and the milestone sign-off. Price variance tolerance is 0%; tax and shipping tolerance is +/- 2%.",
  },
  {
    id: "proc-002-5.1",
    document: "SOP-PROC-002 v2.1 (IT Procurement & Vendor Management)",
    section: "5.1 Vendor Onboarding & API Access",
    page: 24,
    content:
      "Each vendor receives a dedicated API key. Vendors submit invoices, delivery or milestone confirmations, and PO acceptance through the vendor API.",
  },
];

export function getDeepSeekConfig(): Partial<DeepSeekConfig> {
  return {
    apiKey: readEnv("DEEPSEEK_API_KEY"),
    baseUrl: readEnv("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com",
    proModel: readEnv("DEEPSEEK_PRO_MODEL") ?? "deepseek-v4-pro",
    flashModel: readEnv("DEEPSEEK_FLASH_MODEL") ?? "deepseek-v4-flash",
  };
}

export function isDeepSeekConfigured(): boolean {
  return Boolean(getDeepSeekConfig().apiKey);
}

const SIMILARITY_THRESHOLD = 0.15;

export async function checkDeepSeekHealth(): Promise<IntegrationStatus> {
  if (!isDeepSeekConfigured()) {
    return {
      name: "deepseek",
      configured: false,
      status: "not_configured",
      message: "DEEPSEEK_API_KEY not configured; using representative RAG data",
    };
  }
  const start = Date.now();
  const cfg = getDeepSeekConfig();
  try {
    const res = await fetchWithTimeout(`${cfg.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey as string}` },
    });
    return {
      name: "deepseek",
      configured: true,
      status: res.ok ? "ok" : "error",
      latencyMs: Date.now() - start,
      message: res.ok ? "DeepSeek API reachable" : `DeepSeek API returned ${res.status}`,
    };
  } catch (error) {
    return {
      name: "deepseek",
      configured: true,
      status: "error",
      latencyMs: Date.now() - start,
      message: errorMessage(error),
    };
  }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
}

type RetrievedChunk = { doc: RagDocument; similarity: number };

async function retrieve(query: string, topK: number): Promise<RetrievedChunk[]> {
  const queryTokens = tokenize(query);
  return RAG_DOCUMENTS.map((doc) => {
    const documentTokens = tokenize(`${doc.section} ${doc.content}`);
    const overlap = [...queryTokens].filter((token) => documentTokens.has(token)).length;
    return {
      doc,
      similarity: queryTokens.size ? overlap / queryTokens.size : 0,
    };
  })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

export type RagAnswer = {
  answer: string;
  confidence: number;
  citations: Citation[];
};

async function generateAnswer(query: string, chunks: RetrievedChunk[]): Promise<string> {
  const cfg = getDeepSeekConfig();
  if (!cfg.apiKey) {
    return "Live DeepSeek guidance is not configured. Review the cited procedure excerpts with the Head of IT.";
  }
  const context = chunks
    .map(({ doc }) => `[${doc.document} · ${doc.section} · p. ${doc.page}]\n${doc.content}`)
    .join("\n\n");
  const res = await fetchWithTimeout(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.flashModel,
      temperature: 0.1,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content:
            "Answer only from the supplied verified IT procedure excerpts. Be concise, state uncertainty, and do not invent policy.",
        },
        {
          role: "user",
          content: `Question: ${query}\n\nVerified excerpts:\n${context}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek API returned ${res.status}`);
  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const answer = payload.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) {
    throw new Error("DeepSeek returned an empty answer");
  }
  return answer.trim();
}

export async function searchKnowledgeBase(query: string): Promise<RagAnswer> {
  const chunks = await retrieve(query, 5);

  if (!chunks.length || chunks[0].similarity < SIMILARITY_THRESHOLD) {
    return {
      answer:
        "I cannot find an exact reference in the verified IT procedures manual. Please consult the Head of IT.",
      confidence: 0,
      citations: [],
    };
  }

  let answer: string;
  try {
    answer = await generateAnswer(query, chunks.slice(0, 3));
  } catch {
    answer =
      "Live policy generation is temporarily unavailable. Review the cited verified procedure excerpts and consult the Head of IT before proceeding.";
  }
  return {
    answer,
    confidence: Number(chunks[0].similarity.toFixed(2)),
    citations: chunks.slice(0, 3).map(({ doc }) => ({
      document: doc.document,
      section: doc.section,
      page: doc.page,
      excerpt: doc.content.slice(0, 140),
    })),
  };
}

export const deepseek = {
  config: getDeepSeekConfig,
  isConfigured: isDeepSeekConfigured,
  health: checkDeepSeekHealth,
  search: searchKnowledgeBase,
  documents: RAG_DOCUMENTS,
};
