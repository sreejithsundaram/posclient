import { Injectable } from '@angular/core';
import { BillView, CartItem } from './models';

@Injectable({
  providedIn: 'root'
})
export class PrintService {

  printInvoice(bill: BillView, items: CartItem[]) {
    const printWindow = document.createElement('iframe');
    printWindow.style.position = 'fixed';
    printWindow.style.right = '0';
    printWindow.style.bottom = '0';
    printWindow.style.width = '0';
    printWindow.style.height = '0';
    printWindow.style.border = '0';
    document.body.appendChild(printWindow);

    const doc = printWindow.contentWindow?.document;
    if (!doc) return;

    const html = this.generateReceiptHtml(bill, items);
    doc.open();
    doc.write(html);
    doc.close();

    // Small delay to ensure styles and content are loaded
    setTimeout(() => {
      printWindow.contentWindow?.focus();
      printWindow.contentWindow?.print();
      
      // Remove the iframe after printing dialog closes (or cancels)
      // Note: print() is blocking in most browsers, but it's safer with a small delay
      setTimeout(() => {
        document.body.removeChild(printWindow);
      }, 1000);
    }, 250);
  }

  private generateReceiptHtml(bill: BillView, items: CartItem[]): string {
    const dateTime = new Date().toLocaleString();
    
    // Line items table rows
    const itemRows = items.map(item => `
      <tr>
        <td class="item-desc">
          ${item.item}
          <div class="item-meta">${item.qty} x ₹${item.sp.toFixed(2)}</div>
        </td>
        <td class="item-total">₹${item.total.toFixed(2)}</td>
      </tr>
    `).join('');

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          @page {
            margin: 0;
            size: 80mm auto;
          }
          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            width: 72mm; /* Standard printable width for 80mm paper */
            margin: 0 auto;
            padding: 5mm 0;
            font-size: 12px;
            color: #000;
            line-height: 1.4;
          }
          .header {
            text-align: center;
            margin-bottom: 5mm;
          }
          .brand {
            font-size: 20px;
            font-weight: 800;
            margin-bottom: 2px;
            letter-spacing: -0.5px;
          }
          .subtitle {
            font-size: 10px;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 1px;
          }
          .divider {
            border-top: 1px dashed #ccc;
            margin: 4mm 0;
          }
          .meta-info {
            font-size: 11px;
            margin-bottom: 4mm;
          }
          .meta-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 2px;
          }
          .meta-label { color: #666; }
          .meta-value { font-weight: 600; }

          table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 4mm;
          }
          th {
            text-align: left;
            font-size: 10px;
            text-transform: uppercase;
            color: #888;
            border-bottom: 1px solid #eee;
            padding-bottom: 1mm;
          }
          td {
            padding: 2mm 0;
            vertical-align: top;
          }
          .item-desc {
            font-weight: 500;
          }
          .item-meta {
            font-size: 10px;
            color: #666;
            font-weight: 400;
          }
          .item-total {
            text-align: right;
            font-weight: 600;
          }

          .summary {
            margin-top: 2mm;
          }
          .summary-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 2px;
          }
          .summary-label { color: #444; }
          .summary-value { font-weight: 500; }
          
          .grand-total {
            margin-top: 3mm;
            padding-top: 3mm;
            border-top: 2px solid #000;
            display: flex;
            justify-content: space-between;
            font-size: 16px;
            font-weight: 800;
          }
          
          .savings {
            text-align: center;
            margin-top: 5mm;
            font-size: 11px;
            font-weight: 600;
            color: #000;
            background: #f0f0f0;
            padding: 2mm;
            border-radius: 4px;
          }

          .footer {
            text-align: center;
            margin-top: 8mm;
            font-size: 10px;
            color: #888;
          }
          .barcode {
            margin: 5mm 0;
            font-family: 'Libre Barcode 39', cursive;
            font-size: 32px;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="brand">POS TERMINAL</div>
          <div class="subtitle">Quick Checkout</div>
        </div>

        <div class="meta-info">
          <div class="meta-row">
            <span class="meta-label">Bill No:</span>
            <span class="meta-value">${bill.number}</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">Date:</span>
            <span class="meta-value">${dateTime}</span>
          </div>
          ${bill.customer ? `
          <div class="meta-row">
            <span class="meta-label">Customer:</span>
            <span class="meta-value">${bill.customer}</span>
          </div>
          ` : ''}
        </div>

        <div class="divider"></div>

        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th style="text-align: right">Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemRows}
          </tbody>
        </table>

        <div class="divider"></div>

        <div class="summary">
          <div class="summary-row">
            <span class="summary-label">Subtotal</span>
            <span class="summary-value">₹${bill.subtotal.toFixed(2)}</span>
          </div>
          ${bill.savings > 0 ? `
          <div class="summary-row">
            <span class="summary-label">Discount</span>
            <span class="summary-value">-₹${bill.savings.toFixed(2)}</span>
          </div>
          ` : ''}
          
          <div class="grand-total">
            <span>TOTAL</span>
            <span>₹${bill.roundedtotal.toFixed(2)}</span>
          </div>
        </div>

        ${bill.savings > 0 ? `
        <div class="savings">
          YOU SAVED ₹${bill.savings.toFixed(2)} ON THIS BILL!
        </div>
        ` : ''}

        <div class="footer">
          <p>Thank you for shopping with us!</p>
          <p>Visit again soon</p>
        </div>
      </body>
      </html>
    `;
  }
}
