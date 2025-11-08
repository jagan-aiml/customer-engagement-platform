const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

class InvoiceGenerator {
  constructor() {
    this.doc = null;
    this.invoiceDir = path.join(__dirname, '../../invoices');
    
    // Create invoices directory if it doesn't exist
    if (!fs.existsSync(this.invoiceDir)) {
      fs.mkdirSync(this.invoiceDir, { recursive: true });
    }
  }

  generateInvoice(paymentData) {
    return new Promise((resolve, reject) => {
      try {
        const fileName = `invoice_${paymentData.receiptNumber}.pdf`;
        const filePath = path.join(this.invoiceDir, fileName);
        
        // Create PDF document
        this.doc = new PDFDocument({ margin: 50 });
        
        // Pipe to file
        const stream = fs.createWriteStream(filePath);
        this.doc.pipe(stream);
        
        // Generate invoice content
        this.generateHeader(paymentData);
        this.generateCustomerInformation(paymentData);
        this.generateInvoiceTable(paymentData);
        this.generateFooter();
        
        // Finalize PDF
        this.doc.end();
        
        stream.on('finish', () => {
          resolve({
            fileName,
            filePath,
            url: `/invoices/${fileName}`
          });
        });
        
        stream.on('error', reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  generateHeader(paymentData) {
    this.doc
      .fillColor('#444444')
      .fontSize(20)
      .text('RealtyEngage', 50, 45)
      .fontSize(10)
      .text('Customer Engagement Platform', 50, 70)
      .text('123 Business Street', 200, 65, { align: 'right' })
      .text('Bangalore, Karnataka 560001', 200, 80, { align: 'right' })
      .text('Phone: +91 98765 43210', 200, 95, { align: 'right' })
      .text('Email: info@realtyengage.com', 200, 110, { align: 'right' })
      .moveDown();
    
    // Add invoice title and number
    this.doc
      .fillColor('#000000')
      .fontSize(18)
      .text('PAYMENT INVOICE', 50, 160, { align: 'center' })
      .fontSize(12)
      .text(`Invoice #: ${paymentData.invoice?.number || paymentData.receiptNumber}`, 50, 185, { align: 'center' })
      .text(`Date: ${new Date(paymentData.paidAt || Date.now()).toLocaleDateString('en-IN')}`, 50, 200, { align: 'center' })
      .moveDown();
  }

  generateCustomerInformation(paymentData) {
    const { customer, project } = paymentData;
    
    this.doc
      .fontSize(14)
      .text('BILL TO:', 50, 250)
      .fontSize(10)
      .font('Helvetica-Bold')
      .text(`${customer.firstName} ${customer.lastName}`, 50, 270)
      .font('Helvetica')
      .text(customer.email, 50, 285)
      .text(customer.phone, 50, 300)
      .text(`${customer.address?.street || ''}, ${customer.address?.city || ''}`, 50, 315)
      .text(`${customer.address?.state || ''} - ${customer.address?.pincode || ''}`, 50, 330);
    
    // Project details
    this.doc
      .fontSize(14)
      .text('PROJECT DETAILS:', 300, 250)
      .fontSize(10)
      .font('Helvetica-Bold')
      .text(project.name, 300, 270)
      .font('Helvetica')
      .text(`Location: ${project.area}`, 300, 285)
      .text(`Unit Type: ${project.specifications?.[0]?.value || 'N/A'}`, 300, 300)
      .text(`Status: ${project.status.replace('_', ' ').toUpperCase()}`, 300, 315);
  }

  generateInvoiceTable(paymentData) {
    const tableTop = 380;
    const itemX = 50;
    const descriptionX = 150;
    const amountX = 450;
    
    // Table headers
    this.doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .text('Item', itemX, tableTop)
      .text('Description', descriptionX, tableTop)
      .text('Amount', amountX, tableTop);
    
    this.generateHr(tableTop + 15);
    
    // Table content
    const items = this.getPaymentItems(paymentData);
    let position = tableTop + 30;
    
    items.forEach(item => {
      this.doc
        .font('Helvetica')
        .text(item.name, itemX, position)
        .text(item.description, descriptionX, position, { width: 250 })
        .text(this.formatCurrency(item.amount), amountX, position);
      
      position += 30;
    });
    
    this.generateHr(position + 10);
    
    // Totals
    const subtotal = paymentData.amount;
    const tax = 0; // GST can be calculated here
    const total = subtotal + tax;
    
    position += 25;
    this.doc
      .font('Helvetica-Bold')
      .text('Subtotal:', 380, position)
      .text(this.formatCurrency(subtotal), amountX, position);
    
    if (tax > 0) {
      position += 20;
      this.doc
        .text('GST (18%):', 380, position)
        .text(this.formatCurrency(tax), amountX, position);
    }
    
    position += 20;
    this.generateHr(position - 5);
    position += 10;
    
    this.doc
      .fontSize(12)
      .text('Total:', 380, position)
      .text(this.formatCurrency(total), amountX, position);
    
    // Payment details
    position += 40;
    this.doc
      .fontSize(10)
      .font('Helvetica')
      .text('Payment Details:', 50, position)
      .text(`Payment Method: ${paymentData.method.toUpperCase()}`, 50, position + 15)
      .text(`Transaction ID: ${paymentData.gatewayDetails?.transactionId || paymentData.receiptNumber}`, 50, position + 30)
      .text(`Status: ${paymentData.status.toUpperCase()}`, 50, position + 45);
  }

  generateFooter() {
    this.doc
      .fontSize(10)
      .text(
        'Terms & Conditions:\n' +
        '1. This is a computer-generated invoice and does not require a signature.\n' +
        '2. Please retain this invoice for future reference.\n' +
        '3. For any queries, contact our support team.',
        50,
        650,
        { align: 'left', width: 500 }
      )
      .fontSize(8)
      .text(
        'Thank you for choosing RealtyEngage!',
        50,
        720,
        { align: 'center', width: 500 }
      );
  }

  generateHr(y) {
    this.doc
      .strokeColor('#aaaaaa')
      .lineWidth(1)
      .moveTo(50, y)
      .lineTo(550, y)
      .stroke();
  }

  formatCurrency(amount) {
    return `₹${Number(amount).toLocaleString('en-IN')}`;
  }

  getPaymentItems(paymentData) {
    const items = [];
    
    switch (paymentData.paymentType) {
      case 'booking':
        items.push({
          name: 'Booking Amount',
          description: `Initial booking amount for ${paymentData.project.name}`,
          amount: paymentData.amount
        });
        break;
      
      case 'down_payment':
        items.push({
          name: 'Down Payment',
          description: `Down payment for property purchase`,
          amount: paymentData.amount
        });
        break;
      
      case 'emi':
        items.push({
          name: 'EMI Payment',
          description: `Monthly installment ${paymentData.metadata?.installmentNumber || ''}/${paymentData.metadata?.totalInstallments || ''}`,
          amount: paymentData.amount
        });
        break;
      
      case 'full_payment':
        items.push({
          name: 'Full Payment',
          description: `Complete payment for property`,
          amount: paymentData.amount
        });
        break;
      
      default:
        items.push({
          name: 'Payment',
          description: paymentData.metadata?.description || 'Property payment',
          amount: paymentData.amount
        });
    }
    
    return items;
  }

  // Generate simple HTML invoice (alternative to PDF)
  generateHTMLInvoice(paymentData) {
    const { customer, project } = paymentData;
    const date = new Date(paymentData.paidAt || Date.now()).toLocaleDateString('en-IN');
    
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Invoice - ${paymentData.receiptNumber}</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        .header { text-align: center; margin-bottom: 30px; }
        .company-name { font-size: 24px; font-weight: bold; }
        .invoice-title { font-size: 20px; margin: 20px 0; }
        .row { display: flex; justify-content: space-between; margin-bottom: 20px; }
        .col { flex: 1; }
        .table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        .table th, .table td { border: 1px solid #ddd; padding: 10px; text-align: left; }
        .table th { background-color: #f4f4f4; }
        .total-row { font-weight: bold; font-size: 16px; }
        .footer { margin-top: 50px; text-align: center; font-size: 12px; color: #666; }
        @media print { body { margin: 0; } }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="company-name">RealtyEngage</div>
        <div>Customer Engagement Platform</div>
        <div class="invoice-title">PAYMENT INVOICE</div>
        <div>Invoice #: ${paymentData.invoice?.number || paymentData.receiptNumber}</div>
        <div>Date: ${date}</div>
      </div>
      
      <div class="row">
        <div class="col">
          <h3>Bill To:</h3>
          <p>
            <strong>${customer.firstName} ${customer.lastName}</strong><br>
            ${customer.email}<br>
            ${customer.phone}<br>
            ${customer.address?.city || ''}, ${customer.address?.state || ''}
          </p>
        </div>
        <div class="col">
          <h3>Project Details:</h3>
          <p>
            <strong>${project.name}</strong><br>
            Location: ${project.area}<br>
            Status: ${project.status.replace('_', ' ').toUpperCase()}
          </p>
        </div>
      </div>
      
      <table class="table">
        <thead>
          <tr>
            <th>Description</th>
            <th>Payment Type</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${this.getPaymentDescription(paymentData)}</td>
            <td>${paymentData.paymentType.replace('_', ' ').toUpperCase()}</td>
            <td>${this.formatCurrency(paymentData.amount)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr class="total-row">
            <td colspan="2" style="text-align: right;">Total:</td>
            <td>${this.formatCurrency(paymentData.amount)}</td>
          </tr>
        </tfoot>
      </table>
      
      <div>
        <h3>Payment Information:</h3>
        <p>
          Payment Method: ${paymentData.method.toUpperCase()}<br>
          Transaction ID: ${paymentData.gatewayDetails?.transactionId || paymentData.receiptNumber}<br>
          Status: ${paymentData.status.toUpperCase()}
        </p>
      </div>
      
      <div class="footer">
        <p>This is a computer-generated invoice and does not require a signature.</p>
        <p>Thank you for choosing RealtyEngage!</p>
      </div>
    </body>
    </html>
    `;
  }

  getPaymentDescription(paymentData) {
    const descriptions = {
      'booking': 'Initial booking amount',
      'down_payment': 'Down payment for property',
      'emi': `EMI Payment ${paymentData.metadata?.installmentNumber || ''}`,
      'full_payment': 'Full payment for property',
      'other': 'Property payment'
    };
    return descriptions[paymentData.paymentType] || 'Payment';
  }
}

module.exports = InvoiceGenerator;
