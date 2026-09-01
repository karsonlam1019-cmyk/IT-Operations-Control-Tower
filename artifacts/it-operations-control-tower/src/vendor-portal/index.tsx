import { useState } from 'react';
import { 
  getGetVendorPortalSessionQueryKey, 
  useConfirmVendorPortalMilestone, 
  useGetVendorPortalSession, 
  useSubmitVendorPortalInvoice,
  type VendorPortalSession,
  type VendorPortalPurchaseOrder,
  type PaymentSchedule
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { 
  CheckCircle2, 
  FileText, 
  KeyRound, 
  LogOut, 
  PackageCheck, 
  WalletCards,
  ArrowRight,
  AlertCircle,
  FileCheck2,
  Clock3
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

function formatMoney(value?: number, currency = 'HKD') {
  return typeof value === 'number'
    ? new Intl.NumberFormat('en-HK', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
    : '—';
}

function formatDate(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function VendorPortal() {
  const [apiKey, setApiKey] = useState<string>('');
  const [authenticatedKey, setAuthenticatedKey] = useState<string | null>(null);
  const [loginAttempt, setLoginAttempt] = useState(0);

  // Authenticate
  const sessionQuery = useGetVendorPortalSession({
    query: {
      enabled: !!authenticatedKey,
      queryKey: [...getGetVendorPortalSessionQueryKey(), loginAttempt],
      retry: false,
    },
    request: {
      headers: {
        'X-Vendor-API-Key': authenticatedKey || '',
      }
    }
  });

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (apiKey.trim()) {
      setAuthenticatedKey(apiKey.trim());
      setLoginAttempt((attempt) => attempt + 1);
    }
  };

  const handleLogout = () => {
    setAuthenticatedKey(null);
    setApiKey('');
    setLoginAttempt(0);
  };

  if (!authenticatedKey || sessionQuery.isError) {
    return (
      <div className="vendor-portal-theme min-h-[100dvh] flex flex-col">
        <header className="vp-header">
          <div className="vp-brand">
            <div className="vp-brand-mark"><span /><span /><span /></div>
            <div><strong>ORBITAL</strong><small>VENDOR WORKSPACE</small></div>
          </div>
        </header>
        <main className="vp-login-main">
          <div className="vp-login-card animate-in">
            <div className="vp-login-icon">
              <KeyRound size={24} />
            </div>
            <h1>Secure handoff</h1>
            <p>Enter your vendor access key to view purchase orders and submit invoices.</p>
            
            <form onSubmit={handleLogin} className="vp-login-form">
              {sessionQuery.isError && (
                <div className="vp-error-banner" data-testid="error-invalid-key">
                  <AlertCircle size={16} />
                  <span>Invalid or revoked API key. Please check your credentials.</span>
                </div>
              )}
              <div className="vp-input-group">
                <Input 
                  type="password"
                  placeholder="e.g. vp_demo_meridian_2026"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  data-testid="input-api-key"
                  className="vp-input"
                  autoComplete="off"
                  autoFocus
                />
              </div>
              <Button 
                type="submit" 
                className="vp-button-primary w-full"
                disabled={!apiKey.trim() || sessionQuery.isFetching}
                data-testid="button-login"
              >
                {sessionQuery.isFetching ? 'Authenticating...' : 'Access workspace'}
                <ArrowRight size={16} />
              </Button>
            </form>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="vendor-portal-theme min-h-[100dvh] flex flex-col">
      <header className="vp-header">
        <div className="vp-brand">
          <div className="vp-brand-mark"><span /><span /><span /></div>
          <div><strong>ORBITAL</strong><small>VENDOR WORKSPACE</small></div>
        </div>
        <div className="vp-header-actions">
          {sessionQuery.data && (
            <div className="vp-vendor-badge" data-testid="text-vendor-name">
              <WalletCards size={14} />
              <span>{sessionQuery.data.vendor.name}</span>
            </div>
          )}
          <button onClick={handleLogout} className="vp-logout-button" data-testid="button-logout">
            <LogOut size={16} />
            <span>Sign out</span>
          </button>
        </div>
      </header>

      <main className="vp-workspace-main">
        {sessionQuery.isLoading ? (
          <div className="vp-loading-state">
            <div className="skeleton-row" style={{ height: 60, width: '100%', marginBottom: 16 }} />
            <div className="skeleton-row" style={{ height: 200, width: '100%' }} />
          </div>
        ) : sessionQuery.data ? (
          <VendorWorkspace 
            session={sessionQuery.data} 
            apiKey={authenticatedKey} 
          />
        ) : null}
      </main>
    </div>
  );
}

function VendorWorkspace({ session, apiKey }: { session: VendorPortalSession; apiKey: string }) {
  const [selectedPoId, setSelectedPoId] = useState<string | null>(
    session.purchaseOrders.length > 0 ? session.purchaseOrders[0].id : null
  );

  const selectedPo = session.purchaseOrders.find(po => po.id === selectedPoId);

  return (
    <div className="vp-workspace-grid animate-in">
      <div className="vp-sidebar">
        <div className="vp-sidebar-header">
          <span className="vp-eyebrow">Assigned Purchase Orders</span>
        </div>
        <div className="vp-po-list">
          {session.purchaseOrders.length === 0 ? (
            <div className="vp-empty-mini">No active purchase orders.</div>
          ) : (
            session.purchaseOrders.map(po => (
              <button
                key={po.id}
                className={`vp-po-item ${selectedPoId === po.id ? 'active' : ''}`}
                onClick={() => setSelectedPoId(po.id)}
                data-testid={`button-select-po-${po.poNumber}`}
              >
                <div className="vp-po-item-top">
                  <strong>{po.poNumber}</strong>
                  <span className={`vp-status-pill vp-status-${po.status.toLowerCase().replace('_', '-')}`}>
                    {po.status}
                  </span>
                </div>
                <div className="vp-po-item-bottom">
                  <span>{formatMoney(po.amount, po.currency)}</span>
                  <span className="vp-project-code">{po.projectCode}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
      
      <div className="vp-content">
        {selectedPo ? (
          <PurchaseOrderDetail po={selectedPo} apiKey={apiKey} />
        ) : (
          <div className="vp-empty-state">
            <FileText size={32} />
            <h2>Select a purchase order</h2>
            <p>Choose a purchase order from the list to view details and submit invoices.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function PurchaseOrderDetail({ po, apiKey }: { po: VendorPortalPurchaseOrder; apiKey: string }) {
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [milestoneModalOpen, setMilestoneModalOpen] = useState(false);
  const [selectedMilestone, setSelectedMilestone] = useState<PaymentSchedule | null>(null);

  const openInvoiceModal = (milestone: PaymentSchedule) => {
    setSelectedMilestone(milestone);
    setInvoiceModalOpen(true);
  };

  const openMilestoneModal = (milestone: PaymentSchedule) => {
    setSelectedMilestone(milestone);
    setMilestoneModalOpen(true);
  };

  return (
    <div className="vp-po-detail">
      <div className="vp-po-header">
        <div className="vp-po-header-main">
          <div>
            <span className="vp-eyebrow">Purchase Order</span>
            <h1>{po.poNumber}</h1>
            <div className="vp-po-meta">
              <span><strong>PR Ref:</strong> {po.prNumber}</span>
              <span><strong>Project:</strong> {po.projectCode}</span>
              <span><strong>Issued:</strong> {formatDate(po.createdAt)}</span>
            </div>
          </div>
          <div className="vp-po-amount-box">
            <span className="vp-eyebrow">Total Value</span>
            <div className="vp-amount">{formatMoney(po.amount, po.currency)}</div>
            <span className="vp-payment-terms">{po.paymentTerms}</span>
          </div>
        </div>
      </div>

      <div className="vp-section">
        <div className="vp-section-header">
          <h2>Payment Schedule & Milestones</h2>
          <span className="vp-badge">{po.milestones.length} installments</span>
        </div>
        
        <div className="vp-milestone-list">
          {po.milestones.length === 0 ? (
            <div className="vp-empty-state mini">
              No milestones defined for this order.
            </div>
          ) : (
            po.milestones.map((m, index) => (
              <div key={m.id} className="vp-milestone-card" data-testid={`card-milestone-${m.id}`}>
                <div className="vp-milestone-info">
                  <div className="vp-milestone-title">
                    <div className="vp-milestone-index">{m.milestoneNumber || index + 1}</div>
                    <div>
                      <strong>{m.milestoneDescription || `Installment ${index + 1}`}</strong>
                      <div className="vp-milestone-meta">
                        <Clock3 size={12} />
                        <span>Due {formatDate(m.dueDate)}</span>
                        {m.paidAt && <span className="vp-paid-date">· Paid {formatDate(m.paidAt)}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="vp-milestone-amount">
                    {formatMoney(m.amount, po.currency)}
                  </div>
                </div>
                
                <div className="vp-milestone-actions">
                  <div className="vp-milestone-status">
                    {m.paidAt ? (
                      <span className="vp-status-pill vp-status-paid"><CheckCircle2 size={12} /> Settled</span>
                    ) : m.invoiceNumber ? (
                      <span className="vp-status-pill vp-status-invoiced"><FileText size={12} /> Invoiced ({m.invoiceNumber})</span>
                    ) : m.confirmationStatus === 'CONFIRMED' ? (
                      <span className="vp-status-pill vp-status-confirmed"><CheckCircle2 size={12} /> Delivery confirmed</span>
                    ) : (
                      <span className="vp-status-pill vp-status-pending">Pending</span>
                    )}
                  </div>
                  
                  <div className="vp-action-buttons">
                    {!m.invoiceNumber && po.status !== 'PAID' && (
                      <>
                        {m.isMilestonePayment && m.confirmationStatus !== 'CONFIRMED' && (
                          <Button 
                            variant="outline" 
                            size="sm" 
                            className="vp-button-outline"
                            onClick={() => openMilestoneModal(m)}
                            data-testid={`button-confirm-milestone-${m.id}`}
                          >
                            <PackageCheck size={14} className="mr-2" />
                            Confirm delivery
                          </Button>
                        )}
                        <Button 
                          size="sm" 
                          className="vp-button-primary"
                          onClick={() => openInvoiceModal(m)}
                          data-testid={`button-submit-invoice-${m.id}`}
                        >
                          <FileCheck2 size={14} className="mr-2" />
                          Submit invoice
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {selectedMilestone && (
        <InvoiceModal 
          isOpen={invoiceModalOpen}
          onClose={() => setInvoiceModalOpen(false)}
          po={po}
          milestone={selectedMilestone}
          apiKey={apiKey}
        />
      )}

      {selectedMilestone && (
        <MilestoneModal 
          isOpen={milestoneModalOpen}
          onClose={() => setMilestoneModalOpen(false)}
          po={po}
          milestone={selectedMilestone}
          apiKey={apiKey}
        />
      )}
    </div>
  );
}

function InvoiceModal({ 
  isOpen, 
  onClose, 
  po, 
  milestone, 
  apiKey 
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  po: VendorPortalPurchaseOrder;
  milestone: PaymentSchedule;
  apiKey: string;
}) {
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceAmount, setInvoiceAmount] = useState(milestone.amount.toString());
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  
  const queryClient = useQueryClient();
  const submitInvoice = useSubmitVendorPortalInvoice({
    request: { headers: { 'X-Vendor-API-Key': apiKey } }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!invoiceNumber.trim() || !invoiceAmount) return;

    submitInvoice.mutate(
      {
        id: po.id,
        data: {
          paymentScheduleId: milestone.id,
          invoiceNumber: invoiceNumber.trim(),
          invoiceAmount: parseFloat(invoiceAmount),
          invoiceDate
        }
      },
      {
        onSuccess: () => {
          toast.success('Invoice submitted successfully');
          queryClient.invalidateQueries({ queryKey: getGetVendorPortalSessionQueryKey() });
          onClose();
        },
        onError: () => {
          toast.error('Failed to submit invoice');
        }
      }
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="vp-dialog-content vendor-portal-theme sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="vp-dialog-title">Submit Invoice</DialogTitle>
          <DialogDescription className="vp-dialog-desc">
            Submit an invoice for {milestone.milestoneDescription || 'this installment'}.
          </DialogDescription>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="vp-label">Invoice Number</label>
            <Input 
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="e.g. INV-2023-001"
              required
              className="vp-input"
              data-testid="input-invoice-number"
            />
          </div>
          
          <div className="space-y-2">
            <label className="vp-label">Invoice Amount ({po.currency})</label>
            <Input 
              type="number"
              step="0.01"
              min="0.01"
              value={invoiceAmount}
              onChange={(e) => setInvoiceAmount(e.target.value)}
              required
              className="vp-input"
              data-testid="input-invoice-amount"
            />
            <p className="vp-help-text">Expected amount: {formatMoney(milestone.amount, po.currency)}</p>
          </div>

          <div className="space-y-2">
            <label className="vp-label">Invoice Date</label>
            <Input
              type="date"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
              required
              className="vp-input"
              data-testid="input-invoice-date"
            />
          </div>
          
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={onClose} className="vp-button-outline" data-testid="button-cancel-invoice">
              Cancel
            </Button>
            <Button 
              type="submit" 
              className="vp-button-primary"
              disabled={submitInvoice.isPending || !invoiceNumber.trim()}
              data-testid="button-confirm-invoice"
            >
              {submitInvoice.isPending ? 'Submitting...' : 'Submit Invoice'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MilestoneModal({ 
  isOpen, 
  onClose, 
  po, 
  milestone, 
  apiKey 
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  po: VendorPortalPurchaseOrder;
  milestone: PaymentSchedule;
  apiKey: string;
}) {
  const [note, setNote] = useState('');
  
  const queryClient = useQueryClient();
  const confirmMilestone = useConfirmVendorPortalMilestone({
    request: { headers: { 'X-Vendor-API-Key': apiKey } }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    confirmMilestone.mutate(
      {
        id: milestone.id,
        data: {
          confirmationNote: note.trim() || undefined
        }
      },
      {
        onSuccess: () => {
          toast.success('Milestone confirmed');
          queryClient.invalidateQueries({ queryKey: getGetVendorPortalSessionQueryKey() });
          onClose();
        },
        onError: () => {
          toast.error('Failed to confirm milestone');
        }
      }
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="vp-dialog-content vendor-portal-theme sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="vp-dialog-title">Confirm Delivery</DialogTitle>
          <DialogDescription className="vp-dialog-desc">
            Confirm that you have completed the deliverables for {milestone.milestoneDescription || 'this milestone'}.
          </DialogDescription>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="vp-label">Confirmation Note (Optional)</label>
            <Textarea 
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add any links or notes about the delivery..."
              className="vp-input min-h-[100px]"
              data-testid="input-milestone-note"
            />
          </div>
          
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={onClose} className="vp-button-outline" data-testid="button-cancel-milestone">
              Cancel
            </Button>
            <Button 
              type="submit" 
              className="vp-button-primary"
              disabled={confirmMilestone.isPending}
              data-testid="button-confirm-delivery"
            >
              {confirmMilestone.isPending ? 'Confirming...' : 'Confirm Delivery'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
