import { type ReactNode, useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  ClipboardCheck,
  Clock3,
  Command,
  Database,
  FileCheck2,
  FileDown,
  FileSpreadsheet,
  FileText,
  Filter,
  Globe2,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  PackageCheck,
  PanelLeft,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  UsersRound,
  WalletCards,
  X,
  XCircle,
} from 'lucide-react';
import {
  getGetDashboardSummaryQueryKey,
  getGetDelegationStatusQueryKey,
  getGetTreasuryAnalyticsQueryKey,
  getHealthCheckQueryKey,
  getListAuditLogsQueryKey,
  getListPaymentSchedulesQueryKey,
  getListProcurementRecordsQueryKey,
  getListReleaseGatesQueryKey,
  getListStaffQueryKey,
  useAdvanceProcurementStatus,
  useCreatePaymentSchedule,
  useCreateProcurementRecord,
  useDualSignoff,
  useGetDashboardSummary,
  useGetDelegationStatus,
  useGetTreasuryAnalytics,
  useHealthCheck,
  useListAuditLogs,
  useListPaymentSchedules,
  useListProcurementRecords,
  useListReleaseGates,
  useListStaff,
  useMarkPaid,
  useResolveVariance,
  useSearchCompliance,
  useSubmitInvoice,
  useSubmitProcurementReview,
  useToggleReleaseGate,
  useUpdateHeadOfItLeave,
  type AuditLog,
  type BusinessUnitAllocation,
  type ComplianceAnswer,
  type DashboardSummary,
  type DelegationStatus,
  type FxRate,
  type PaymentSchedule,
  type ProcurementRecord,
  type ReleaseGate,
  type StaffMember,
  type TreasuryAnalytics,
} from '@workspace/api-client-react';
import { jsPDF } from 'jspdf';
import * as XLSX from 'xlsx';
import { Toaster, toast } from 'sonner';
import { Link, Route, Switch, useLocation, useSearch, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import {
  useIntegrationHealth,
  useJiraTickets,
  useVendorSubmissions,
  type IntegrationStatus,
  type JiraTicket,
  type VendorSubmission,
} from '@/hooks/use-integrations';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ProcurementPage as ProcurementWorkflowPage } from '@/procurement-workflow';
import { VendorPage } from '@/pages/VendorPage';

const queryClient = new QueryClient();
const STAFF_SYNC_INTERVAL_MS = 3 * 60 * 1000;

type IconType = typeof LayoutDashboard;

const navItems: { label: string; href: string; icon: IconType; note?: string }[] = [
  { label: 'Command center', href: '/', icon: LayoutDashboard },
  { label: 'Staff operations', href: '/staff', icon: UsersRound },
  { label: 'Release control', href: '/release', icon: PackageCheck },
  { label: 'Procurement', href: '/procurement', icon: ClipboardCheck },
  { label: 'Vendor portal', href: '/vendor', icon: Globe2, note: 'external' },
  { label: 'Treasury', href: '/treasury', icon: WalletCards },
  { label: 'Compliance', href: '/compliance', icon: BookOpen },
  { label: 'Administration', href: '/admin', icon: LockKeyhole },
];

const pageMeta: Record<string, { eyebrow: string; title: string; description: string }> = {
  '/': { eyebrow: 'Operations / live view', title: 'Command center', description: 'One operating picture across people, change, spend, and control.' },
  '/staff': { eyebrow: 'People / coverage', title: 'Staff operations', description: 'See who is active, where coverage is thin, and what needs a handoff.' },
  '/release': { eyebrow: 'Change / assurance', title: 'Release control', description: 'A release only moves when the evidence is ready.' },
  '/procurement': { eyebrow: 'Commercial / workflow', title: 'Procurement control', description: 'Approvals, purchase orders, and exceptions in one accountable queue.' },
  '/vendor': { eyebrow: 'Supplier / self-service', title: 'Vendor portal', description: 'Purchase orders, milestone deliveries, and invoice submissions for external vendors.' },
  '/treasury': { eyebrow: 'Finance / allocation', title: 'Treasury overview', description: 'Payment velocity, business-unit allocation, and foreign exchange exposure.' },
  '/compliance': { eyebrow: 'Risk / guidance', title: 'Compliance assistant', description: 'Ask a policy question. Get an answer with a source you can inspect.' },
  '/admin': { eyebrow: 'Governance / access', title: 'Administration', description: 'Access posture and an immutable trail of operational decisions.' },
};

function getCurrentGMT8Date() {
  const d = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Hong_Kong',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
  return formatter.format(d).toUpperCase().replace(/,/g, '');
}

function formatNumber(value?: number) {
  return typeof value === 'number' ? new Intl.NumberFormat('en-US').format(value) : '—';
}

function formatMoney(value?: number, currency = 'HKD') {
  return typeof value === 'number'
    ? new Intl.NumberFormat('en-HK', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
    : '—';
}

function formatTime(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function exportDate() {
  return new Date().toISOString().slice(0, 10);
}

function csvCell(value: string | number) {
  const cell = String(value);
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function treasuryExportRows(data: TreasuryAnalytics): Array<Array<string | number>> {
  return [
    ['TREASURY OVERVIEW'],
    ['Generated', new Date().toLocaleString()],
    [],
    ['SUMMARY'],
    ['Metric', 'Value', 'Unit'],
    ['YTD deployed', data.totalYtd, 'HKD'],
    ['Variance rate', data.varianceRate, '%'],
    [],
    ['MONTHLY PAYMENTS'],
    ['Month', 'Paid', 'Committed', 'Currency'],
    ...data.monthlyPayments.map(item => [item.month, item.paid, item.committed, 'HKD']),
    [],
    ['BUSINESS UNIT ALLOCATION'],
    ['Business unit', 'Value', 'Currency'],
    ...data.businessUnits.map(item => [item.name, item.value, 'HKD']),
    [],
    ['FX REFERENCE RATES'],
    ['Currency', 'Rate', 'Delta %'],
    ...data.fxRates.map(item => [item.currency, item.rate, item.delta]),
  ];
}

function exportTreasuryCsv(data: TreasuryAnalytics) {
  const csv = treasuryExportRows(data)
    .map(row => row.map(csvCell).join(','))
    .join('\r\n');
  downloadBlob(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' }), `treasury-overview-${exportDate()}.csv`);
}

function exportTreasuryExcel(data: TreasuryAnalytics) {
  const workbook = XLSX.utils.book_new();
  const summarySheet = XLSX.utils.aoa_to_sheet([
    ['Treasury overview'],
    ['Generated', new Date().toLocaleString()],
    [],
    ['Metric', 'Value', 'Unit'],
    ['YTD deployed', data.totalYtd, 'HKD'],
    ['Variance rate', data.varianceRate, '%'],
  ]);
  const paymentsSheet = XLSX.utils.json_to_sheet(data.monthlyPayments.map(item => ({
    Month: item.month,
    Paid: item.paid,
    Committed: item.committed,
    Currency: 'HKD',
  })));
  const allocationsSheet = XLSX.utils.json_to_sheet(data.businessUnits.map(item => ({
    'Business unit': item.name,
    Value: item.value,
    Currency: 'HKD',
  })));
  const fxSheet = XLSX.utils.json_to_sheet(data.fxRates.map(item => ({
    Currency: item.currency,
    Rate: item.rate,
    'Delta %': item.delta,
  })));

  summarySheet['!cols'] = [{ wch: 24 }, { wch: 18 }, { wch: 12 }];
  paymentsSheet['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 12 }];
  allocationsSheet['!cols'] = [{ wch: 24 }, { wch: 18 }, { wch: 12 }];
  fxSheet['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 14 }];

  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');
  XLSX.utils.book_append_sheet(workbook, paymentsSheet, 'Monthly Payments');
  XLSX.utils.book_append_sheet(workbook, allocationsSheet, 'Business Units');
  XLSX.utils.book_append_sheet(workbook, fxSheet, 'FX Rates');
  XLSX.writeFile(workbook, `treasury-overview-${exportDate()}.xlsx`);
}

function exportTreasuryPdf(data: TreasuryAnalytics) {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 42;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const contentWidth = pageWidth - margin * 2;
  let y = 48;

  const addText = (text: string, options: { size?: number; bold?: boolean; color?: [number, number, number]; gap?: number } = {}) => {
    const size = options.size ?? 9;
    const lineHeight = size + 5;
    pdf.setFont('helvetica', options.bold ? 'bold' : 'normal');
    pdf.setFontSize(size);
    pdf.setTextColor(...(options.color ?? [35, 48, 62]));
    const lines = pdf.splitTextToSize(text, contentWidth) as string[];
    if (y + lines.length * lineHeight > pageHeight - margin) {
      pdf.addPage();
      y = margin;
    }
    pdf.text(lines, margin, y);
    y += lines.length * lineHeight + (options.gap ?? 0);
  };

  const addSection = (title: string) => {
    if (y > pageHeight - 100) {
      pdf.addPage();
      y = margin;
    }
    y += 8;
    addText(title.toUpperCase(), { size: 9, bold: true, color: [27, 117, 113], gap: 5 });
  };

  pdf.setProperties({ title: 'Treasury Overview', subject: 'Treasury analytics export' });
  addText('TREASURY OVERVIEW', { size: 20, bold: true, color: [30, 50, 64], gap: 4 });
  addText(`Generated ${new Date().toLocaleString()} · Base currency HKD`, { size: 8, color: [99, 110, 120], gap: 12 });

  addSection('Summary');
  addText(`YTD deployed: ${formatMoney(data.totalYtd, 'HKD')}    Variance rate: ${data.varianceRate}%`, { size: 10, bold: true, gap: 3 });

  addSection('Monthly payments');
  addText('Month                         Paid                 Committed', { size: 8, bold: true, color: [99, 110, 120], gap: 3 });
  data.monthlyPayments.forEach(item => addText(
    `${item.month.padEnd(28)}${formatMoney(item.paid, 'HKD').padStart(18)}${formatMoney(item.committed, 'HKD').padStart(22)}`,
    { size: 8, gap: 1 },
  ));

  addSection('Business unit allocation');
  data.businessUnits.forEach(item => addText(`${item.name.padEnd(28)}${formatMoney(item.value, 'HKD')}`, { size: 8, gap: 1 }));

  addSection('FX reference rates');
  addText('Currency                  Rate                 Delta', { size: 8, bold: true, color: [99, 110, 120], gap: 3 });
  data.fxRates.forEach(item => addText(
    `${item.currency.padEnd(26)}${item.rate.toFixed(4).padEnd(20)}${item.delta >= 0 ? '+' : ''}${item.delta.toFixed(2)}%`,
    { size: 8, gap: 1 },
  ));

  const pageCount = pdf.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    pdf.setPage(page);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.setTextColor(130, 140, 148);
    pdf.text(`Orbital IT Operations · Treasury export · ${page} / ${pageCount}`, margin, pageHeight - 20);
  }
  pdf.save(`treasury-overview-${exportDate()}.pdf`);
}

function statusTone(status = '') {
  const normalized = status.toLowerCase();
  if (normalized.includes('active') || normalized.includes('approved') || normalized.includes('ready') || normalized.includes('pass') || normalized.includes('paid')) return 'status-positive';
  if (normalized.includes('stale') || normalized.includes('blocked') || normalized.includes('risk') || normalized.includes('variance') || normalized.includes('failed')) return 'status-critical';
  if (normalized.includes('pending') || normalized.includes('review') || normalized.includes('progress') || normalized.includes('uat')) return 'status-warning';
  return 'status-neutral';
}

function signalTone(signal = '') {
  const normalized = signal.trim().toLowerCase();
  if (normalized === 'active') return 'signal-active';
  if (normalized === 'inactive') return 'signal-inactive';
  return 'status-neutral';
}

function StatusPill({ value, testId, tone = 'default' }: { value: string; testId?: string; tone?: 'default' | 'signal' }) {
  const className = tone === 'signal' ? signalTone(value) : statusTone(value);
  return <span className={`status-pill ${className}`} data-testid={testId}>{value || 'Unassigned'}</span>;
}

function LoadingRows({ count = 4 }: { count?: number }) {
  return <div className="space-y-2" aria-label="Loading">
    {Array.from({ length: count }).map((_, index) => <div className="skeleton-row" key={index} />)}
  </div>;
}

function EmptyState({ title, detail, icon: Icon = Database }: { title: string; detail: string; icon?: IconType }) {
  return <div className="empty-state" data-testid={`empty-${title.toLowerCase().replace(/\s+/g, '-')}`}>
    <span className="empty-icon"><Icon size={18} /></span>
    <div><strong>{title}</strong><p>{detail}</p></div>
  </div>;
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return <div className="error-state" data-testid="status-error">
    <AlertCircle size={18} />
    <div><strong>Signal unavailable</strong><p>We could not reach this operational feed.</p></div>
    <button className="button button-quiet" onClick={onRetry} data-testid="button-retry"><RefreshCw size={14} /> Retry</button>
  </div>;
}

function SectionHeading({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return <div className="section-heading">
    <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>
    {action}
  </div>;
}

function GlobalSearch() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [, setLocation] = useLocation();
  const popupInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => popupInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      setLocation(`/compliance?q=${encodeURIComponent(query.trim())}`);
      setQuery('');
      setOpen(false);
    }
  };

  return (
    <>
      <button className="deepseek-search" type="button" onClick={() => setOpen(true)} aria-label="Open AI search" data-testid="button-global-search">
        <Search size={14} />
        <span>DeepSeek AI search...</span>
        <kbd>⌘K</kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="global-search-dialog">
          <DialogHeader>
            <DialogTitle><Sparkles size={17} /> Ask Orbital AI</DialogTitle>
            <DialogDescription>Search internal policy and operational guidance with cited answers.</DialogDescription>
          </DialogHeader>
          <form className="global-search-form" onSubmit={handleSearch}>
            <Search size={17} />
            <input
              ref={popupInputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="What decision are you making?"
              data-testid="input-global-search"
            />
            <kbd>Enter</kbd>
          </form>
          <div className="global-search-quick">
            <span>Try a question</span>
            {[
              'What are the approval controls for production access?',
              'When is a vendor security review required?',
              'What evidence is needed for release handover?',
            ].map(prompt => (
              <button type="button" key={prompt} onClick={() => setQuery(prompt)}>{prompt}</button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DeputyToggle({ status, loading }: { status?: DelegationStatus; loading: boolean }) {
  const active = Boolean(status?.delegationActive);
  const client = useQueryClient();
  const updateLeave = useUpdateHeadOfItLeave();

  const toggle = () => {
    if (!status || updateLeave.isPending) return;
    updateLeave.mutate({ data: { onLeave: !active } }, {
      onSuccess: () => {
        void client.invalidateQueries({ queryKey: getGetDelegationStatusQueryKey() });
        void client.invalidateQueries({ queryKey: getListAuditLogsQueryKey() });
        toast.success(!active ? 'Deputy Mode enabled' : 'Deputy Mode disabled');
      },
      onError: () => toast.error('Could not update Deputy Mode'),
    });
  };

  return (
    <button
      className={`deputy-toggle ${active ? 'deputy-active' : ''}`}
      type="button"
      role="switch"
      aria-checked={active}
      aria-label="Deputy Mode"
      onClick={toggle}
      disabled={loading || !status || updateLeave.isPending}
      title={active ? `${status?.deputy?.name} is acting as Deputy Head of IT` : 'Enable Deputy Mode to activate delegated authority'}
      data-testid="button-deputy-toggle"
    >
      <UserRound size={14} />
      <span className="deputy-toggle-label">Deputy Mode</span>
      <span className="deputy-switch" aria-hidden="true"><i /></span>
      <strong>{loading ? '…' : active ? 'On' : 'Off'}</strong>
    </button>
  );
}

function IntegrationPulse() {
  const healthQuery = useIntegrationHealth();
  const statuses = healthQuery.data?.integrations ?? [];
  const configuredOk = statuses.filter((s: IntegrationStatus) => s.status === 'ok').length;
  const total = statuses.length;
  const connected = statuses.filter((s: IntegrationStatus) => s.configured).length;
  return (
    <div className="pulse-mini">
      <div className="pulse-mini-heading">
        <span className="signal-dot" /> Integrations{' '}
        <span className="font-mono">{healthQuery.isLoading ? '...' : `${configuredOk}/${total || 0}`}</span>
      </div>
      <div className="pulse-bars">
        {statuses.length
          ? statuses.map((s: IntegrationStatus, i: number) => (
              <i
                key={s.name}
                style={{
                  height: s.status === 'ok' ? 92 : s.status === 'error' ? 30 : 55,
                  background: s.status === 'ok' ? 'var(--accent)' : s.status === 'error' ? '#e5484d' : undefined,
                }}
              />
            ))
          : [40, 55, 45, 60].map((h, i) => <i style={{ height: h }} key={i} />)}
      </div>
      <small>{healthQuery.isLoading ? 'Checking service feeds…' : `${connected} of ${total || 0} services configured`}</small>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const staffQuery = useListStaff({
    query: {
      queryKey: getListStaffQueryKey(),
      refetchInterval: STAFF_SYNC_INTERVAL_MS,
      refetchOnMount: 'always',
      refetchIntervalInBackground: false,
    },
  });
  const delegationQuery = useGetDelegationStatus({
    query: { queryKey: getGetDelegationStatusQueryKey(), refetchInterval: 15000 },
  });
  const delegation = delegationQuery.data as DelegationStatus | undefined;
  const activePerson = delegation?.delegationActive && delegation.deputy
    ? delegation.deputy
    : delegation?.headOfIt;
  const meta = pageMeta[location] ?? pageMeta['/'];
  return <div className="app-shell min-h-[100dvh]">
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <div className="brand">
        <div className="brand-mark"><span /><span /><span /></div>
        <div><strong>ORBITAL</strong><small>IT OPERATIONS</small></div>
        <button className="sidebar-close" onClick={() => setMobileOpen(false)} data-testid="button-close-menu"><X size={17} /></button>
      </div>
      <div className="tenant-switcher" data-testid="text-tenant">
        <span className="tenant-dot" /><span>Meridian Group</span><ChevronRight size={14} className="rotate-90" />
      </div>
      <nav className="nav-list" aria-label="Primary navigation">
        <span className="nav-label">Control surfaces</span>
        {navItems.map(({ label, href, icon: Icon, note }) => <Link
          key={href} href={href} onClick={() => setMobileOpen(false)}
          className={`nav-link ${location === href ? 'nav-link-active' : ''}`}
          data-testid={`link-${label.toLowerCase().replace(/\s+/g, '-')}`}
        >
          <Icon size={17} strokeWidth={1.8} /><span>{label}</span>{label === 'Staff operations'
            ? <em>{staffQuery.isLoading ? '…' : formatNumber(Array.isArray(staffQuery.data) ? staffQuery.data.length : undefined)}</em>
            : note && <em>{note}</em>}
        </Link>)}
      </nav>
      <div className="sidebar-lower">
        <IntegrationPulse />
        <button className="profile-row" data-testid="button-profile"><span className="avatar avatar-lime">{activePerson?.name.split(' ').map(part => part[0]).slice(0, 2).join('') || 'LC'}</span><span><strong>{activePerson?.name || 'Leah Chan'}</strong><small>{delegation?.delegationActive ? 'Acting Deputy Head of IT' : 'Head of IT'}</small></span><MoreHorizontal size={16} /></button>
      </div>
    </aside>
    {mobileOpen && <button className="mobile-scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" data-testid="button-scrim" />}
    <main className="main-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button className="mobile-menu" onClick={() => setMobileOpen(true)} data-testid="button-open-menu"><Menu size={20} /></button>
          <span className="breadcrumb">Orbital <ChevronRight size={13} /> {meta.eyebrow.split(' / ')[0]}</span>
        </div>
        <div className="topbar-center">
          <GlobalSearch />
        </div>
        <div className="topbar-actions">
          <DeputyToggle status={delegation} loading={delegationQuery.isLoading} />
          <div className="sync-status"><span className="signal-dot" /> Live <span className="font-mono">09:42:18</span></div>
          <button className="icon-button notification-button" aria-label="Notifications" data-testid="button-notifications"><Bell size={17} /><i /></button>
          <div className="topbar-profile">
            <span className="role-badge" data-testid="text-role-badge">{delegation?.delegationActive ? 'Deputy Head of IT' : 'Head of IT'}</span>
            <div className="top-avatar avatar">{activePerson?.name.split(' ').map(part => part[0]).slice(0, 2).join('') || 'LC'}</div>
          </div>
        </div>
      </header>
      <div className="page-content">
        <div className="page-intro animate-in"><div><span className="eyebrow">{meta.eyebrow}</span><h1>{meta.title}</h1><p>{meta.description}</p></div><div className="page-intro-side"><span className="font-mono">{getCurrentGMT8Date()}</span><button className="button button-outline" onClick={() => toast.success('View refreshed')} data-testid="button-refresh-view"><RefreshCw size={14} /> Refresh view</button></div></div>
        {children}
      </div>
    </main>
  </div>;
}

function MetricCard({ label, value, detail, accent = 'teal', icon: Icon }: { label: string; value: string; detail: string; accent?: string; icon: IconType }) {
  return <div className={`metric-card accent-${accent} animate-in`} data-testid={`metric-${label.toLowerCase().replace(/\s+/g, '-')}`}>
    <div className="metric-top"><span>{label}</span><Icon size={17} /></div><strong>{value}</strong><small>{detail}</small><div className="metric-rule" />
  </div>;
}

function DashboardPage() {
  const summaryQuery = useGetDashboardSummary({ query: { queryKey: getGetDashboardSummaryQueryKey(), refetchInterval: 30000 } });
  const staffQuery = useListStaff({ query: { queryKey: getListStaffQueryKey(), refetchInterval: false, refetchOnMount: false } });
  const healthQuery = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30000 } });
  const summary = summaryQuery.data as DashboardSummary | undefined;
  const staff = (staffQuery.data as StaffMember[] | undefined) ?? [];
  const recentStaff = useMemo(() => staff.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 5), [staff]);
  const hasError = summaryQuery.isError || staffQuery.isError;
  return <div className="page-stack">
    {hasError && <ErrorState onRetry={() => { void summaryQuery.refetch(); void staffQuery.refetch(); }} />}
    <div className="metric-grid">
      <MetricCard label="Active staff" value={summary ? formatNumber(summary.activeStaff) : '—'} detail={summary ? `Jira SHIFT feed · ${formatNumber(summary.staleStaff)} stale check-ins` : 'Awaiting Jira staff feed'} accent="teal" icon={UsersRound} />
      <MetricCard label="Pending approvals" value={summary ? formatNumber(summary.pendingApprovals) : '—'} detail="Across procurement and access" accent="amber" icon={Clock3} />
      <MetricCard label="Release readiness" value={summary ? `${summary.releaseReadiness}%` : '—'} detail="Evidence-backed gate score" accent="lime" icon={PackageCheck} />
      <MetricCard label="Blocked variances" value={summary ? formatNumber(summary.blockedVariances) : '—'} detail="Requires owner action" accent="coral" icon={AlertCircle} />
    </div>
    <div className="dashboard-grid">
      <section className="panel pulse-panel animate-in animate-delay-1 signal-grid">
        <SectionHeading eyebrow="Operational heartbeat" title="System pulse" action={<StatusPill value={healthQuery.data?.status === 'ok' ? 'Nominal' : healthQuery.isLoading ? 'Checking' : 'Review'} testId="status-system-pulse" />} />
        <div className="pulse-score-row"><div><strong>{summary?.systemPulse ?? '—'}</strong><span>/ 100</span><p>Composite signal across monitored services</p></div><div className="pulse-ring"><div><span>{summary?.systemPulse ? 'GOOD' : 'WAIT'}</span></div></div></div>
        <div className="large-pulse-bars">{[36, 42, 38, 50, 44, 61, 56, 72, 69, 78, 74, 88, 82, 92, 87, 96, 90, 93, 88, 95, 94, 97, 96, 99].map((height, i) => <i key={i} style={{ height: `${height}%` }} />)}</div>
        <div className="panel-foot"><span>Last sync <b className="font-mono">{formatTime(summary?.lastSync)}</b></span><span className="signal-text"><span className="signal-dot" /> Stable telemetry</span></div>
      </section>
      <section className="panel action-panel animate-in animate-delay-2">
        <SectionHeading eyebrow="Triage queue" title="Next actions" action={<Link href="/admin" className="text-link" data-testid="link-view-audit">View audit <ChevronRight size={14} /></Link>} />
        <div className="action-list">
          {summary ? <><Link href="/staff" className="action-item" data-testid="action-stale-staff"><span className="action-icon action-icon-coral"><UsersRound size={16} /></span><span><b>{summary.staleStaff} staff check-ins are stale</b><small>Reconcile coverage before the next shift</small></span><ChevronRight size={15} /></Link>
            <Link href="/procurement" className="action-item" data-testid="action-pending-approvals"><span className="action-icon action-icon-amber"><ClipboardCheck size={16} /></span><span><b>{summary.pendingApprovals} approvals need a decision</b><small>2 requests have an FX or policy variance</small></span><ChevronRight size={15} /></Link>
            <Link href="/release" className="action-item" data-testid="action-release-gates"><span className="action-icon action-icon-teal"><PackageCheck size={16} /></span><span><b>Release gates need evidence review</b><small>Hold the handover if owner sign-off is absent</small></span><ChevronRight size={15} /></Link></> : <EmptyState title="Queue is loading" detail="Waiting for the command summary." icon={ListChecks} />}
        </div>
      </section>
    </div>
    <section className="panel animate-in animate-delay-3">
      <SectionHeading eyebrow="Latest telemetry" title="Activity across operations" action={<span className="muted-label">Showing latest 5 updates</span>} />
      {staffQuery.isLoading ? <LoadingRows /> : recentStaff.length ? <div className="activity-table">
        <div className="table-head"><span>Person</span><span>Workstream</span><span>Environment</span><span>State</span><span>Updated</span></div>
        {recentStaff.map(member => <div className="table-row" key={member.id} data-testid={`row-activity-${member.id}`}><span className="person-cell"><span className="avatar">{member.initials}</span><span><b>{member.name}</b><small>{member.role}</small></span></span><span>{member.team}<small>{member.region}</small></span><span className="font-mono">{member.environment || '—'}</span><span><StatusPill value={member.status} /></span><span className="font-mono muted-label">{formatTime(member.updatedAt)}</span></div>)}
      </div> : <EmptyState title="No activity yet" detail="The staff feed has not returned any monitored updates." />}
    </section>
    <JiraQueueSection />
  </div>;
}

function JiraQueueSection() {
  const jira = useJiraTickets();
  const tickets = jira.data?.tickets ?? [];
  return (
    <section className="panel animate-in">
      <SectionHeading
        eyebrow="Jira work queue"
        title="Live tickets"
        action={<span className="muted-label">Source: {jira.data?.source ?? '…'}</span>}
      />
      {jira.isLoading ? <LoadingRows count={3} /> : tickets.length ? <div className="activity-table">
        <div className="table-head"><span>Key</span><span>Summary</span><span>Status</span><span>Env</span><span>Assignee</span></div>
        {tickets.map((t: JiraTicket) => <div className="table-row" key={t.id} data-testid={`row-jira-${t.key}`}><span className="font-mono"><b>{t.key}</b></span><span>{t.summary}</span><span><StatusPill value={t.status} /></span><span className="font-mono">{t.environment}</span><span>{t.assignee}<small>{t.updatedAt}</small></span></div>)}
      </div> : <EmptyState title="No tickets" detail="Jira is not configured yet." icon={ClipboardCheck} />}
    </section>
  );
}

function StaffPage() {
  const query = useListStaff({ query: { queryKey: getListStaffQueryKey(), refetchInterval: false, refetchOnMount: false } });
  const delegationQuery = useGetDelegationStatus({
    query: { queryKey: getGetDelegationStatusQueryKey(), refetchInterval: 15000 },
  });
  const updateLeave = useUpdateHeadOfItLeave();
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [signal, setSignal] = useState('All');
  const staff = (query.data as StaffMember[] | undefined) ?? [];
  const signals = ['All', ...Array.from(new Set(staff.map(item => item.signal ?? item.status).filter(Boolean)))];
  const filtered = useMemo(() => staff.filter(item => {
    const text = `${item.name} ${item.role} ${item.team} ${item.region}`.toLowerCase();
    const itemSignal = item.signal ?? item.status;
    return text.includes(search.toLowerCase()) && (signal === 'All' || itemSignal === signal);
  }), [staff, search, signal]);
  const delegation = delegationQuery.data as DelegationStatus | undefined;
  const changeHeadLeave = () => {
    if (!delegation) return;
    const onLeave = !delegation.headOfIt.onLeave;
    updateLeave.mutate({ data: { onLeave } }, {
      onSuccess: () => {
        void client.invalidateQueries({ queryKey: getGetDelegationStatusQueryKey() });
        void client.invalidateQueries({ queryKey: getListAuditLogsQueryKey() });
        toast.success(onLeave ? 'Deputy authority activated automatically' : 'Direct Head of IT authority restored');
      },
      onError: () => toast.error('Could not update Head of IT leave status'),
    });
  };
  return <div className="page-stack">
    <section className={`panel delegation-panel ${delegation?.delegationActive ? 'delegation-panel-active' : ''}`} data-testid="panel-delegation-status">
      <div className="delegation-summary">
        <span className={`posture-icon ${delegation?.delegationActive ? 'delegation-icon-active' : ''}`}><ShieldCheck size={18} /></span>
        <div><span className="eyebrow">Authority coverage</span><h2>{delegation?.delegationActive ? 'Deputy authority is active' : 'Head of IT is available'}</h2><p>{delegation?.delegationActive
          ? `${delegation.deputy?.name || 'The configured deputy'} now holds delegated Head of IT rights. Privileged actions are audited as deputy actions.`
          : `${delegation?.headOfIt.name || 'The Head of IT'} retains direct authority. The configured deputy activates automatically when leave starts.`}</p></div>
      </div>
      <div className="delegation-people">
        <div><span>Head of IT</span><strong>{delegation?.headOfIt.name || 'Loading…'}</strong><small>{delegation?.headOfIt.onLeave ? 'On leave' : 'Available'}</small></div>
        <ChevronRight size={16} />
        <div><span>Configured deputy</span><strong>{delegation?.deputy?.name || 'Not assigned'}</strong><small>{delegation?.delegationActive ? 'Authority active' : 'Standby'}</small></div>
      </div>
      <button className={`button ${delegation?.headOfIt.onLeave ? 'button-outline' : 'button-primary'}`} onClick={changeHeadLeave} disabled={!delegation || updateLeave.isPending} data-testid="button-toggle-head-leave">
        {updateLeave.isPending ? 'Updating…' : delegation?.headOfIt.onLeave ? 'Return from leave' : 'Mark Head of IT on leave'}
      </button>
    </section>
    <div className="toolbar panel"><div className="search-field"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search people, teams, regions" data-testid="input-search-staff" /></div><div className="filter-group"><Filter size={14} /><select value={signal} onChange={e => setSignal(e.target.value)} aria-label="Signal" data-testid="select-staff-signal">{signals.map(value => <option value={value} key={value}>{value}</option>)}</select></div><span className="toolbar-count font-mono">{filtered.length} / {staff.length} visible</span></div>
    <section className="panel">
      <SectionHeading eyebrow="Coverage board" title="Shift signal" />
      {query.isError ? <ErrorState onRetry={() => void query.refetch()} /> : query.isLoading ? <LoadingRows count={6} /> : !filtered.length ? <EmptyState title={staff.length ? 'No matching staff' : 'No staff feed available'} detail={staff.length ? 'Adjust the search or status filter.' : 'Once monitored staff are connected, their shift signal will appear here.'} icon={UsersRound} /> : <div className="staff-table">
        <div className="table-head staff-head"><span>Staff Member</span><span>Team</span><span>Region</span><span>Signal</span><span>Status</span><span>Source</span></div>
        {filtered.map(member => <div className="table-row staff-row" key={member.id} data-testid={`row-staff-${member.id}`}><span className="person-cell"><span className={`avatar ${member.isStale ? 'avatar-stale' : ''}`}>{member.initials}</span><span><b>{member.name}</b></span></span><span>{member.team}</span><span>{member.region}</span><span><StatusPill value={member.signal ?? 'Unknown'} tone="signal" testId={`signal-staff-${member.id}`} /></span><span><StatusPill value={member.status} testId={`status-staff-${member.id}`} /><small className="table-subtext">Updated {formatTime(member.updatedAt)}</small></span><span className="muted-label">{member.source ?? '—'}</span></div>)}
      </div>}
    </section>
  </div>;
}

function ReleasePage() {
  const query = useListReleaseGates({ query: { queryKey: getListReleaseGatesQueryKey(), refetchInterval: 30000 } });
  const toggle = useToggleReleaseGate();
  const client = useQueryClient();
  const gates = (query.data as ReleaseGate[] | undefined) ?? [];
  const environments = ['SIT', 'UAT', 'Prod'];
  return <div className="page-stack">
    <div className="release-summary panel"><div><span className="eyebrow">Handover posture</span><h2>{gates.length ? `${gates.filter(g => g.checked).length} of ${gates.length} gates checked` : 'No gate data'}</h2><p>Every gate carries an owner, due date, and risk signal.</p></div><div className="handover-meter"><div style={{ width: `${gates.length ? (gates.filter(g => g.checked).length / gates.length) * 100 : 0}%` }} /><span>{gates.length ? Math.round((gates.filter(g => g.checked).length / gates.length) * 100) : 0}% ready</span></div><div className="release-callout"><ShieldCheck size={18} /><span>Production handover requires all critical gates checked.</span></div></div>
    {query.isError ? <ErrorState onRetry={() => void query.refetch()} /> : query.isLoading ? <LoadingRows count={3} /> : gates.length ? <div className="release-columns">{environments.map((environment, index) => {
      const envGates = gates.filter(g => g.environment.toLowerCase() === environment.toLowerCase());
      return <section className={`panel release-column animate-in animate-delay-${index + 1}`} key={environment}><div className="column-heading"><div><span className={`env-badge env-${environment.toLowerCase()}`}>{environment}</span><h2>{envGates.length} gates</h2></div><span className="font-mono muted-label">{envGates.filter(g => g.checked).length}/{envGates.length}</span></div>{envGates.length ? <div className="gate-list">{envGates.map(gate => <button className={`gate-item ${gate.checked ? 'gate-checked' : ''}`} key={gate.id} onClick={() => toggle.mutate({ id: gate.id }, { onSuccess: () => { void client.invalidateQueries({ queryKey: getListReleaseGatesQueryKey() }); toast.success(gate.checked ? 'Gate reopened' : 'Gate checked'); }, onError: () => toast.error('Gate update failed') })} disabled={toggle.isPending} data-testid={`button-gate-${gate.id}`}><span className={`check-box ${gate.checked ? 'check-box-checked' : ''}`}>{gate.checked && <Check size={13} />}</span><span className="gate-copy"><b>{gate.title}</b><small>{gate.owner} · due {formatDate(gate.due)}</small></span><StatusPill value={gate.risk} /></button>)}</div> : <EmptyState title={`No ${environment} gates`} detail="This environment has no checklist items in the current release." icon={FileCheck2} />}</section>;
    })}</div> : <EmptyState title="No release gates" detail="The release checklist will appear once the change feed is connected." icon={PackageCheck} />}
  </div>;
}


function VendorSubmissionsSection() {
  const vendorQuery = useVendorSubmissions();
  const submissions = vendorQuery.data?.submissions ?? [];
  return (
    <section className="panel animate-in">
      <SectionHeading
        eyebrow="Vendor API"
        title="Incoming submissions"
        action={<span className="muted-label">Source: {vendorQuery.data?.source ?? '…'}</span>}
      />
      {vendorQuery.isLoading ? <LoadingRows count={3} /> : submissions.length ? <div className="activity-table">
        <div className="table-head"><span>Type</span><span>PO</span><span>Amount</span><span>Vendor</span><span>Submitted</span></div>
        {submissions.map((s: VendorSubmission, i: number) => <div className="table-row" key={`${s.poNumber}-${i}`}><span><StatusPill value={s.type} /></span><span className="font-mono"><b>{s.poNumber}</b></span><span><b>{formatMoney(s.amount, 'HKD')}</b></span><span className="font-mono">{s.vendorId}</span><span className="muted-label">{s.submittedAt}</span></div>)}
      </div> : <EmptyState title="No submissions" detail="The vendor API is not configured yet." icon={ClipboardCheck} />}
    </section>
  );
}

function PaymentChart({ data }: { data: TreasuryAnalytics['monthlyPayments'] }) {
  if (!data.length) return <EmptyState title="No payment history" detail="Monthly payment data is not available." icon={BarChart3} />;
  const max = Math.max(...data.flatMap(item => [item.paid, item.committed]), 1);
  return <div className="payment-chart" data-testid="chart-monthly-payments"><div className="chart-y"><span>{formatMoney(max, 'HKD')}</span><span>{formatMoney(max / 2, 'HKD')}</span><span>0</span></div><div className="chart-area">{data.map(item => <div className="month-bars" key={item.month}><div className="bar-group"><i className="bar-committed" style={{ height: `${(item.committed / max) * 100}%` }} /><i className="bar-paid" style={{ height: `${(item.paid / max) * 100}%` }} /></div><small>{item.month}</small></div>)}</div></div>;
}

function AllocationList({ data }: { data: BusinessUnitAllocation[] }) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  if (!data.length) return <EmptyState title="No allocations" detail="Business unit allocation data is not available." icon={BarChart3} />;
  return <div className="allocation-list" data-testid="list-business-units">{data.map(item => <div className="allocation-row" key={item.name}><span className="allocation-name"><i style={{ background: item.color }} />{item.name}</span><span className="allocation-track"><i style={{ width: `${total ? (item.value / total) * 100 : 0}%`, background: item.color }} /></span><b>{formatMoney(item.value, 'HKD')}</b></div>)}</div>;
}

function FxList({ data }: { data: FxRate[] }) {
  if (!data.length) return <EmptyState title="No FX rates" detail="FX data is not available." icon={Globe2} />;
  return <div className="fx-list" data-testid="list-fx-rates">{data.map(rate => <div className="fx-row" key={rate.currency}><span className="font-mono">{rate.currency}</span><b>{rate.rate.toFixed(4)}</b><span className={rate.delta >= 0 ? 'delta-up' : 'delta-down'}>{rate.delta >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{Math.abs(rate.delta).toFixed(2)}%</span></div>)}</div>;
}

function TreasuryPage() {
  const query = useGetTreasuryAnalytics({ query: { queryKey: getGetTreasuryAnalyticsQueryKey(), refetchInterval: 60000 } });
  const data = query.data as TreasuryAnalytics | undefined;
  const [activeExport, setActiveExport] = useState<string | null>(null);
  const handleExport = (format: 'csv' | 'excel' | 'pdf') => {
    if (!data) return;
    setActiveExport(format);
    try {
      if (format === 'csv') exportTreasuryCsv(data);
      if (format === 'excel') exportTreasuryExcel(data);
      if (format === 'pdf') exportTreasuryPdf(data);
      toast.success(`${format === 'csv' ? 'CSV' : format === 'excel' ? 'Excel' : 'PDF'} export downloaded`);
    } catch {
      toast.error('Export failed. Please try again.');
    } finally {
      setActiveExport(null);
    }
  };
  return <div className="page-stack">{query.isError && <ErrorState onRetry={() => void query.refetch()} />}{query.isLoading ? <LoadingRows count={4} /> : data ? <>
    <div className="treasury-export-bar panel">
      <div><span className="eyebrow">Reporting</span><strong>Download treasury view</strong><small>Exports include the current mock analytics snapshot.</small></div>
      <div className="treasury-export-actions">
        <button className="button button-outline export-button" onClick={() => handleExport('csv')} disabled={activeExport !== null} data-testid="button-export-csv"><FileDown size={14} /> {activeExport === 'csv' ? 'Preparing…' : 'Export CSV'}</button>
        <button className="button button-outline export-button" onClick={() => handleExport('excel')} disabled={activeExport !== null} data-testid="button-export-excel"><FileSpreadsheet size={14} /> {activeExport === 'excel' ? 'Preparing…' : 'Export Excel'}</button>
        <button className="button button-primary export-button" onClick={() => handleExport('pdf')} disabled={activeExport !== null} data-testid="button-export-pdf"><FileText size={14} /> {activeExport === 'pdf' ? 'Preparing…' : 'Export PDF'}</button>
      </div>
    </div>
    <div className="treasury-kpis"><div className="treasury-total"><span className="eyebrow">YTD deployed</span><strong>{formatMoney(data.totalYtd, 'HKD')}</strong><small><span className="delta-up"><ArrowUpRight size={13} /> 8.4%</span> versus plan</small></div><div className="mini-metric"><span>Variance rate</span><strong>{data.varianceRate}%</strong><small>Within monitored tolerance</small></div><div className="mini-metric"><span>Payment cycles</span><strong>{data.monthlyPayments.length}</strong><small>Periods reported</small></div></div>
    <div className="treasury-grid"><section className="panel"><SectionHeading eyebrow="Cash movement" title="Paid vs committed" action={<div className="legend"><span><i className="legend-dot paid" /> Paid</span><span><i className="legend-dot committed" /> Committed</span></div>} /><PaymentChart data={data.monthlyPayments} /></section><section className="panel"><SectionHeading eyebrow="Cost allocation" title="Business units" /><AllocationList data={data.businessUnits} /></section></div>
    <section className="panel"><SectionHeading eyebrow="Market watch" title="FX reference rates" action={<span className="muted-label">Base currency HKD</span>} /><FxList data={data.fxRates} /></section>
  </> : <EmptyState title="No treasury data" detail="Treasury analytics will appear when the reporting feed is available." icon={WalletCards} />}</div>;
}

function CitationCard({ citation }: { citation: ComplianceAnswer['citations'][number] }) {
  return <div className="citation-card" data-testid={`citation-${citation.page}-${citation.section}`}><div className="citation-meta"><FileCheck2 size={14} /><span>{citation.document}</span><span>§ {citation.section}</span><span>p. {citation.page}</span></div><p>“{citation.excerpt}”</p></div>;
}

function CompliancePage() {
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const initialQuery = searchParams.get('q') || '';
  const [queryText, setQueryText] = useState(initialQuery);
  const search = useSearchCompliance();
  const answer = search.data as ComplianceAnswer | undefined;
  
  const hasRunInitial = useRef(false);
  
  const ask = useCallback((q: string) => { 
    if (!q.trim()) return; 
    search.mutate({ data: { query: q.trim() } }, { 
      onSuccess: () => toast.success('Guidance retrieved'), 
      onError: () => toast.error('Could not search policy guidance') 
    }); 
  }, [search.mutate]);

  useEffect(() => {
    if (initialQuery && !hasRunInitial.current) {
      hasRunInitial.current = true;
      ask(initialQuery);
    }
  }, [initialQuery, ask]);

  const handleAsk = () => ask(queryText);

  return <div className="page-stack compliance-page"><section className="compliance-hero panel signal-grid"><div className="compliance-orb"><Sparkles size={20} /></div><div><span className="eyebrow">Verified policy search</span><h2>What decision are you making?</h2><p>Ask in plain language. Orbital searches internal policy and returns cited guidance for review.</p></div><div className="compliance-search"><Search size={17} /><input value={queryText} onChange={e => setQueryText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleAsk(); }} placeholder="e.g. Can a vendor access production data during UAT?" data-testid="input-compliance-query" /><button className="button button-primary" onClick={handleAsk} disabled={search.isPending || !queryText.trim()} data-testid="button-search-compliance">{search.isPending ? 'Searching' : 'Search guidance'}<Send size={14} /></button></div></section>
    {search.isError && <ErrorState onRetry={handleAsk} />}
    {!answer && !search.isPending && <section className="compliance-empty"><BookOpen size={22} /><strong>Answers carry their evidence</strong><p>Start with a policy question. Your results will show confidence and the exact document excerpt behind the answer.</p><div className="question-chips"><button onClick={() => setQueryText('What are the approval controls for production access?')} data-testid="button-suggest-access">Production access controls</button><button onClick={() => setQueryText('When is a vendor security review required?')} data-testid="button-suggest-vendor">Vendor security review</button><button onClick={() => setQueryText('What evidence is needed for release handover?')} data-testid="button-suggest-release">Release evidence</button></div></section>}
    {search.isPending && <section className="panel"><LoadingRows count={3} /></section>}
    {answer && <div className="answer-grid"><section className="panel answer-card"><div className="answer-top"><span className="eyebrow">Policy answer</span><span className="confidence"><span style={{ width: `${answer.confidence * 100}%` }} /> {Math.round(answer.confidence * 100)}% confidence</span></div><p className="answer-copy">{answer.answer}</p><div className="answer-foot"><ShieldCheck size={15} /> Grounded in {answer.citations.length} cited source{answer.citations.length === 1 ? '' : 's'} <button className="button button-quiet" onClick={() => setQueryText('')} data-testid="button-clear-answer">Clear</button></div></section><section className="panel"><SectionHeading eyebrow="Evidence trail" title="Citations" /><div className="citation-list">{answer.citations.length ? answer.citations.map((citation, i) => <CitationCard citation={citation} key={`${citation.document}-${i}`} />) : <EmptyState title="No citations returned" detail="Ask a narrower policy question for source evidence." icon={FileCheck2} />}</div></section></div>}
  </div>;
}

function AdminPage() {
  const query = useListAuditLogs({ query: { queryKey: getListAuditLogsQueryKey(), refetchInterval: 30000 } });
  const delegationQuery = useGetDelegationStatus({ query: { queryKey: getGetDelegationStatusQueryKey() } });
  const [search, setSearch] = useState('');
  const [authority, setAuthority] = useState('All');
  const logs = (query.data as AuditLog[] | undefined) ?? [];
  const isDeputyAction = (log: AuditLog) => log.actedAsDeputy || Boolean(log.deputy);
  const filtered = logs.filter(log => {
    const searchMatch = `${log.actor} ${log.action} ${log.target} ${log.region}`.toLowerCase().includes(search.toLowerCase());
    const authorityMatch = authority === 'All' || (authority === 'Deputy' ? isDeputyAction(log) : !isDeputyAction(log));
    return searchMatch && authorityMatch;
  });
  const currentDelegation = delegationQuery.data as DelegationStatus | undefined;
  return <div className="page-stack"><div className="admin-cards"><div className="access-posture panel"><div className="posture-icon"><KeyRound size={18} /></div><div><span className="eyebrow">Super Admin audit viewer</span><h2>Controlled</h2><p>{currentDelegation?.authorityLabel || 'All privileged actions require named ownership.'}</p></div><StatusPill value={currentDelegation?.delegationActive ? 'Deputy active' : 'Direct authority'} /></div><div className="mini-metric"><span>Audit entries</span><strong>{formatNumber(logs.length)}</strong><small>Immutable records loaded</small></div><div className="mini-metric"><span>Deputy actions</span><strong>{formatNumber(logs.filter(isDeputyAction).length)}</strong><small>Acting on delegated authority</small></div></div>
    <section className="panel"><div className="toolbar-inner"><div><SectionHeading eyebrow="Governance" title="System activity log" /></div><div className="audit-filters"><div className="search-field"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search actor, action, target" data-testid="input-search-audit" /></div><div className="filter-group"><SlidersHorizontal size={15} /><select value={authority} onChange={event => setAuthority(event.target.value)} data-testid="select-audit-authority"><option>All</option><option>Direct</option><option>Deputy</option></select></div></div></div>{query.isError ? <ErrorState onRetry={() => void query.refetch()} /> : query.isLoading ? <LoadingRows count={6} /> : !filtered.length ? <EmptyState title={logs.length ? 'No matching events' : 'No audit events'} detail={logs.length ? 'Try another actor, action, target, or authority filter.' : 'Immutable events will appear when administrative activity is recorded.'} icon={LockKeyhole} /> : <div className="audit-table"><div className="table-head audit-head"><span>Actor</span><span>Action</span><span>Target</span><span>Region</span><span>Timestamp</span><span>Authority</span></div>{filtered.map(log => <div className="table-row audit-row" key={log.id} data-testid={`row-audit-${log.id}`}><span className="person-cell"><span className="avatar">{log.actor.split(' ').map(n => n[0]).slice(0, 2).join('')}</span><b>{log.actor}</b></span><span><StatusPill value={log.action.replaceAll('_', ' ')} /></span><span className="font-mono">{log.target}</span><span>{log.region}</span><span className="font-mono">{formatDate(log.timestamp)} {formatTime(log.timestamp)}</span><span>{isDeputyAction(log) ? <span className="deputy"><UserRound size={13} /> Deputy</span> : <span className="muted-label">Direct</span>}</span></div>)}</div>}</section></div>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

import { VendorPortal } from '@/vendor-portal';

function Router() {
  const [location] = useLocation();

  if (location.startsWith('/vendor-portal')) {
    return <RoutedErrorBoundary><Switch><Route path="/vendor-portal" component={VendorPortal} /></Switch></RoutedErrorBoundary>;
  }

  return <Shell><RoutedErrorBoundary><Switch>
    <Route path="/" component={DashboardPage} />
    <Route path="/staff" component={StaffPage} />
    <Route path="/release" component={ReleasePage} />
    <Route path="/procurement" component={ProcurementWorkflowPage} />
    <Route path="/vendor" component={VendorPage} />
    <Route path="/treasury" component={TreasuryPage} />
    <Route path="/compliance" component={CompliancePage} />
    <Route path="/admin" component={AdminPage} />
    <Route><NotFoundPage /></Route>
  </Switch></RoutedErrorBoundary></Shell>;
}

function NotFoundPage() {
  const [, setLocation] = useLocation();
  return <div className="not-found panel"><CircleDot size={28} /><span className="eyebrow">404 / surface not found</span><h1>That control surface does not exist.</h1><button className="button button-primary" onClick={() => setLocation('/')} data-testid="button-back-command-center">Back to command center <ChevronRight size={14} /></button></div>;
}

function App() {
  return <QueryClientProvider client={queryClient}><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster position="bottom-right" /></QueryClientProvider>;
}

export default App;
