'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { HugeiconsIcon } from '@hugeicons/react';
import { FileEmpty02Icon, PrinterIcon, ExternalLinkIcon } from '@hugeicons/core-free-icons';
import { explorerTxUrl } from '@/lib/stellarNetwork';

export default function ReceiptPage({ params }: { params: Promise<{ txHash: string }> }) {
  const { txHash } = use(params);
  const searchParams = useSearchParams();
  
  const amount = searchParams.get('amount') || '0';
  const asset = searchParams.get('asset') || 'XLM';
  const creatorName = searchParams.get('creatorName') || 'Unknown Creator';
  const creatorUsername = searchParams.get('creatorUsername') || 'unknown';
  const message = searchParams.get('message') || '';
  const timestamp = searchParams.get('timestamp') || new Date().toISOString();

  const formattedDate = new Date(timestamp).toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const explorerUrl = explorerTxUrl(txHash);

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="min-h-screen bg-background py-10 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Print-only header */}
        <div className="print-only mb-8 text-center hidden print:block">
          <h1 className="text-2xl font-extrabold text-ink">SupportMe Testnet Donation Receipt</h1>
          <p className="text-muted font-medium">Generated on {formattedDate}</p>
        </div>

        {/* Receipt card */}
        <div className="card-brutal p-8 print:shadow-none print:border-2 print:border-ink">
          {/* Header */}
          <div className="flex items-center justify-between mb-8 print:justify-center print:gap-4">
            <div className="flex items-center gap-3 print:items-center">
              <div className="w-12 h-12 rounded-full bg-brand-lime flex items-center justify-center print:hidden">
                <HugeiconsIcon icon={FileEmpty02Icon} size={24} strokeWidth={2} className="text-ink" />
              </div>
              <div>
                <h1 className="text-2xl font-extrabold text-ink">Testnet Donation Receipt</h1>
                <p className="text-sm text-muted font-medium">SupportMe</p>
              </div>
            </div>
            <button
              onClick={handlePrint}
              className="btn-brutal btn-brutal-white px-4 py-2 flex items-center gap-2 text-sm print:hidden"
              aria-label="Print receipt"
            >
              <HugeiconsIcon icon={PrinterIcon} size={18} strokeWidth={2} />
              Print / Save PDF
            </button>
          </div>

          {/* Divider */}
          <div className="border-t-2 border-ink mb-8" />

          {/* Donation details */}
          <div className="space-y-6">
            {/* Amount */}
            <div className="flex justify-between items-baseline">
              <span className="text-lg font-bold text-ink">Amount Donated</span>
              <span className="text-3xl font-extrabold text-ink">
                {amount} {asset}
              </span>
            </div>

            {/* Divider */}
            <div className="border-b border-ink/30" />

            {/* Creator info */}
            <div className="space-y-2">
              <p className="text-sm font-bold text-muted uppercase tracking-wide">To</p>
              <div>
                <p className="text-xl font-extrabold text-ink">{creatorName}</p>
                <p className="text-muted font-medium">@{creatorUsername}</p>
              </div>
            </div>

            {/* Message */}
            {message && (
              <>
                <div className="border-b border-ink/30" />
                <div className="space-y-2">
                  <p className="text-sm font-bold text-muted uppercase tracking-wide">Message</p>
                  <p className="text-ink font-medium italic">&ldquo;{message}&rdquo;</p>
                </div>
              </>
            )}

            {/* Divider */}
            <div className="border-b border-ink/30" />

            {/* Transaction details */}
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-sm font-bold text-muted uppercase tracking-wide">Date</p>
                <p className="text-ink font-medium">{formattedDate}</p>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-bold text-muted uppercase tracking-wide">Transaction Hash</p>
                <div className="flex items-center gap-2">
                  <code className="text-sm font-mono text-ink bg-accent-bg px-2 py-1 rounded border border-ink/30 flex-1 break-all">
                    {txHash}
                  </code>
                  <a
                    href={explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-brutal btn-brutal-white px-3 py-1 flex items-center gap-1 text-sm print:hidden"
                    aria-label="View on Stellar Explorer"
                  >
                    <HugeiconsIcon icon={ExternalLinkIcon} size={16} strokeWidth={2} />
                  </a>
                </div>
                <p className="text-xs text-muted font-medium print:hidden">
                  View on Stellar Explorer for full transaction details
                </p>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="mt-8 pt-6 border-t-2 border-ink">
            <p className="text-xs text-muted font-medium text-center">
              This receipt confirms a donation made on Stellar Testnet. Testnet tokens have no monetary value. All transactions are publicly verifiable on the blockchain.
            </p>
            <p className="text-xs text-muted font-medium text-center mt-2 print:hidden">
              <Link href="/" className="underline hover:text-ink">
                Return to SupportMe
              </Link>
            </p>
          </div>
        </div>

        {/* Print footer */}
        <div className="mt-8 text-center print:block hidden">
          <p className="text-xs text-muted font-medium">
            This is a Testnet receipt — tokens have no monetary value. Verify this transaction at stellar.expert
          </p>
        </div>
      </div>

      <style jsx global>{`
        @media print {
          body {
            background: white !important;
            padding: 0 !important;
          }
          .print-only {
            display: block !important;
          }
          .card-brutal {
            box-shadow: none !important;
            border: 2px solid black !important;
          }
          .btn-brutal {
            display: none !important;
          }
          a[href^="/"] {
            display: none !important;
          }
          @page {
            margin: 2cm;
          }
        }
      `}</style>
    </div>
  );
}
