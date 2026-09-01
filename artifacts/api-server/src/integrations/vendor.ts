import { readEnv, type IntegrationStatus } from "./config";
import { timingSafeEqual } from "node:crypto";

export type VendorConfig = {
  publicKey: string;
  portalApiKey: string;
  portalVendorId: string;
  portalVendorName: string;
  portalVendorRegion: string;
  portalVendorContact: string;
};

export function getVendorConfig(): Partial<VendorConfig> {
  return {
    publicKey: readEnv("VENDOR_PUBLIC_KEY"),
    portalApiKey: readEnv("VENDOR_PORTAL_API_KEY"),
    portalVendorId: readEnv("VENDOR_PORTAL_VENDOR_ID"),
    portalVendorName: readEnv("VENDOR_PORTAL_VENDOR_NAME"),
    portalVendorRegion: readEnv("VENDOR_PORTAL_VENDOR_REGION"),
    portalVendorContact: readEnv("VENDOR_PORTAL_VENDOR_CONTACT"),
  };
}

export const DEMO_VENDOR_PORTAL_KEY = "vp_demo_meridian_2026";

export type VendorPortalIdentity = {
  id: string;
  name: string;
  region: string;
  contact: string;
  demoMode: boolean;
};

const DEMO_VENDOR: VendorPortalIdentity = {
  id: "v-demo-nimbus",
  name: "Nimbus Cloud Services",
  region: "HK",
  contact: "accounts@nimbus.example",
  demoMode: true,
};

function keysMatch(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length
    && timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

export function resolveVendorPortalIdentity(apiKey?: string): VendorPortalIdentity | null {
  const candidate = apiKey?.trim();
  if (!candidate) return null;

  const config = getVendorConfig();
  if (config.portalApiKey && keysMatch(candidate, config.portalApiKey)) {
    return {
      id: config.portalVendorId ?? DEMO_VENDOR.id,
      name: config.portalVendorName ?? DEMO_VENDOR.name,
      region: config.portalVendorRegion ?? DEMO_VENDOR.region,
      contact: config.portalVendorContact ?? DEMO_VENDOR.contact,
      demoMode: false,
    };
  }

  return keysMatch(candidate, DEMO_VENDOR_PORTAL_KEY) ? { ...DEMO_VENDOR } : null;
}

export type VendorSubmission = {
  vendorId: string;
  type: "invoice" | "delivery" | "milestone" | "po_acceptance";
  poNumber: string;
  amount: number;
  submittedAt: string;
};

const FALLBACK_SUBMISSIONS: VendorSubmission[] = [
  { vendorId: "v-001", type: "invoice", poNumber: "PO-2026-0611", amount: 428000, submittedAt: "28 Aug 2026, 09:20" },
  { vendorId: "v-002", type: "milestone", poNumber: "PO-2026-0607", amount: 223800, submittedAt: "27 Aug 2026, 14:45" },
  { vendorId: "v-003", type: "po_acceptance", poNumber: "PO-2026-0599", amount: 165600, submittedAt: "26 Aug 2026, 11:10" },
];

export function isVendorConfigured(): boolean {
  return Boolean(getVendorConfig().publicKey);
}

export async function checkVendorHealth(): Promise<IntegrationStatus> {
  if (!isVendorConfigured()) {
    return {
      name: "vendor-api",
      configured: false,
      status: "not_configured",
      message: "VENDOR_PUBLIC_KEY not configured; using representative vendor submissions",
    };
  }
  return {
    name: "vendor-api",
    configured: true,
    status: "ok",
    message: "Vendor API configured",
  };
}

export async function listVendorSubmissions(): Promise<VendorSubmission[]> {
  return FALLBACK_SUBMISSIONS;
}

export const vendor = {
  config: getVendorConfig,
  isConfigured: isVendorConfigured,
  health: checkVendorHealth,
  listSubmissions: listVendorSubmissions,
  resolvePortalIdentity: resolveVendorPortalIdentity,
};
