const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const Payment = require('../models/Payment');
const Project = require('../models/Project');
const User = require('../models/User');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const InvoiceGenerator = require('../utils/invoiceGenerator');
const crypto = require('crypto');
// const Razorpay = require('razorpay'); // Uncomment when Razorpay is configured

// Validation middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      errors: errors.array()
    });
  }
  next();
};

// Initialize Razorpay (uncomment when configured)
// const razorpay = new Razorpay({
//   key_id: process.env.RAZORPAY_KEY_ID,
//   key_secret: process.env.RAZORPAY_KEY_SECRET
// });

// @route   POST /api/payments/initiate
// @desc    Initiate payment
// @access  Private (Customer)
router.post('/initiate',
  authenticateToken,
  [
    body('projectId').isMongoId(),
    body('amount').isNumeric({ min: 1 }),
    body('paymentType').isIn(['booking', 'down_payment', 'emi', 'full_payment', 'other']),
    body('method').isIn(['card', 'bank_transfer', 'upi', 'cash', 'cheque'])
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { projectId, amount, paymentType, method } = req.body;

      // Verify project exists
      const project = await Project.findById(projectId);
      if (!project || !project.isActive) {
        return res.status(404).json({
          error: 'Project not found'
        });
      }

      // Create payment record
      const payment = new Payment({
        customerId: req.userId,
        projectId,
        amount,
        paymentType,
        method,
        status: 'pending'
      });

      // For online payment methods, create Razorpay order
      if (['card', 'upi'].includes(method)) {
        // TODO: Implement Razorpay order creation
        // const razorpayOrder = await razorpay.orders.create({
        //   amount: amount * 100, // Razorpay expects amount in paise
        //   currency: 'INR',
        //   receipt: payment._id.toString()
        // });
        // payment.gatewayDetails.orderId = razorpayOrder.id;
        
        // For now, return mock data
        payment.gatewayDetails = {
          provider: 'razorpay',
          orderId: `order_${Date.now()}`,
          paymentId: null
        };
      }

      await payment.save();

      res.status(201).json({
        success: true,
        message: 'Payment initiated successfully',
        data: {
          payment,
          razorpayOrderId: payment.gatewayDetails?.orderId,
          razorpayKey: process.env.RAZORPAY_KEY_ID || 'mock_key_id'
        }
      });
    } catch (error) {
      console.error('Initiate payment error:', error);
      res.status(500).json({
        error: 'Failed to initiate payment',
        message: 'Unable to process payment request'
      });
    }
  }
);

// @route   POST /api/payments/verify
// @desc    Verify payment after Razorpay callback
// @access  Private (Customer)
router.post('/verify',
  authenticateToken,
  [
    body('paymentId').notEmpty(),
    body('orderId').notEmpty(),
    body('signature').optional()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { paymentId, orderId, signature } = req.body;

      // Find payment by order ID
      const payment = await Payment.findOne({
        'gatewayDetails.orderId': orderId,
        customerId: req.userId
      });

      if (!payment) {
        return res.status(404).json({
          error: 'Payment not found'
        });
      }

      // TODO: Verify signature with Razorpay
      // const crypto = require('crypto');
      // const expectedSignature = crypto
      //   .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      //   .update(`${orderId}|${paymentId}`)
      //   .digest('hex');
      // 
      // if (expectedSignature !== signature) {
      //   payment.status = 'failed';
      //   payment.failureReason = 'Invalid signature';
      //   await payment.save();
      //   return res.status(400).json({ error: 'Payment verification failed' });
      // }

      // Update payment status
      await payment.updateStatus('success', {
        paymentId,
        signature
      });

      // Update user status if first payment
      const user = await User.findById(req.userId);
      if (user.statusType === 'just_enquired') {
        if (payment.paymentType === 'booking' || payment.paymentType === 'down_payment') {
          user.statusType = 'paid_initial';
        } else if (payment.paymentType === 'full_payment') {
          user.statusType = 'full_payment_pending';
        }
        await user.save();
      }

      // Generate invoice
      try {
        const populatedPayment = await Payment.findById(payment._id)
          .populate('customerId', 'firstName lastName email phone address')
          .populate('projectId', 'name area status specifications');

        const invoiceGenerator = new InvoiceGenerator();
        const invoiceData = {
          ...populatedPayment.toObject(),
          customer: populatedPayment.customerId,
          project: populatedPayment.projectId,
          invoice: {
            number: `INV${Date.now()}`
          }
        };

        const invoice = await invoiceGenerator.generateHTMLInvoice(invoiceData);
        
        // Save invoice details to payment
        payment.invoice = {
          number: invoiceData.invoice.number,
          url: `/api/payments/${payment._id}/invoice`,
          generatedAt: new Date()
        };
        await payment.save();
      } catch (invoiceError) {
        console.error('Invoice generation error:', invoiceError);
        // Don't fail the payment if invoice generation fails
      }

      res.json({
        success: true,
        message: 'Payment verified successfully',
        data: payment
      });
    } catch (error) {
      console.error('Verify payment error:', error);
      res.status(500).json({
        error: 'Failed to verify payment',
        message: 'Unable to confirm payment'
      });
    }
  }
);

// @route   GET /api/payments
// @desc    Get payments (Admin: all, Customer: own)
// @access  Private
router.get('/',
  authenticateToken,
  async (req, res) => {
    try {
      const { status, paymentType, page = 1, limit = 10, sort = '-createdAt' } = req.query;
      
      // Build filter
      let filter = {};
      if (req.user.role === 'customer') {
        filter.customerId = req.userId;
      }
      if (status) filter.status = status;
      if (paymentType) filter.paymentType = paymentType;

      // Build sort
      let sortObj = {};
      if (sort.startsWith('-')) {
        sortObj[sort.substring(1)] = -1;
      } else {
        sortObj[sort] = 1;
      }

      // Execute query with pagination
      const payments = await Payment.find(filter)
        .populate('projectId', 'name area')
        .populate('customerId', 'firstName lastName email')
        .sort(sortObj)
        .limit(limit * 1)
        .skip((page - 1) * limit);

      const totalCount = await Payment.countDocuments(filter);

      res.json({
        success: true,
        data: payments,
        pagination: {
          total: totalCount,
          page: Number(page),
          pages: Math.ceil(totalCount / limit),
          limit: Number(limit)
        }
      });
    } catch (error) {
      console.error('Get payments error:', error);
      res.status(500).json({
        error: 'Failed to fetch payments',
        message: 'Unable to retrieve payment history'
      });
    }
  }
);

// @route   GET /api/payments/:id
// @desc    Get single payment
// @access  Private (Owner or Admin)
router.get('/:id',
  authenticateToken,
  [param('id').isMongoId()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const payment = await Payment.findById(req.params.id)
        .populate('projectId')
        .populate('customerId', 'firstName lastName email phone');

      if (!payment) {
        return res.status(404).json({
          error: 'Payment not found'
        });
      }

      // Check authorization
      const isOwner = payment.customerId._id.toString() === req.userId.toString();
      const isAdmin = req.user.role === 'admin';

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      res.json({
        success: true,
        data: payment
      });
    } catch (error) {
      console.error('Get payment error:', error);
      res.status(500).json({
        error: 'Failed to fetch payment',
        message: 'Unable to retrieve payment details'
      });
    }
  }
);

// @route   POST /api/payments/:id/refund
// @desc    Initiate refund (Admin only)
// @access  Private (Admin)
router.post('/:id/refund',
  authenticateToken,
  authorizeRoles('admin'),
  [
    param('id').isMongoId(),
    body('amount').isNumeric({ min: 1 }),
    body('reason').notEmpty().trim()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const payment = await Payment.findById(req.params.id);

      if (!payment) {
        return res.status(404).json({
          error: 'Payment not found'
        });
      }

      await payment.initiateRefund(req.body.amount, req.body.reason);

      // TODO: Process refund with Razorpay
      // const refund = await razorpay.refunds.create({
      //   payment_id: payment.gatewayDetails.paymentId,
      //   amount: req.body.amount * 100
      // });
      // payment.refundDetails.refundId = refund.id;
      // payment.refundDetails.status = 'processing';
      // await payment.save();

      res.json({
        success: true,
        message: 'Refund initiated successfully',
        data: payment
      });
    } catch (error) {
      console.error('Refund payment error:', error);
      res.status(500).json({
        error: 'Failed to initiate refund',
        message: error.message || 'Unable to process refund'
      });
    }
  }
);

// @route   GET /api/payments/stats/overview
// @desc    Get payment statistics (Admin only)
// @access  Private (Admin)
router.get('/stats/overview',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const stats = await Payment.getStatistics();
      
      // Get EMI defaulters
      const defaulters = await Payment.getEMIDefaulters();

      res.json({
        success: true,
        data: {
          ...stats,
          emiDefaulters: defaulters.length,
          defaultersList: defaulters
        }
      });
    } catch (error) {
      console.error('Get payment stats error:', error);
      res.status(500).json({
        error: 'Failed to fetch statistics',
        message: 'Unable to retrieve payment statistics'
      });
    }
  }
);

// @route   GET /api/payments/:id/invoice
// @desc    Get payment invoice
// @access  Private (Owner or Admin)
router.get('/:id/invoice',
  authenticateToken,
  [param('id').isMongoId()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const payment = await Payment.findById(req.params.id)
        .populate('customerId', 'firstName lastName email phone address')
        .populate('projectId', 'name area status specifications');

      if (!payment) {
        return res.status(404).json({
          error: 'Payment not found'
        });
      }

      // Check authorization
      const isOwner = payment.customerId._id.toString() === req.userId.toString();
      const isAdmin = req.user.role === 'admin';

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      // Generate HTML invoice
      const invoiceGenerator = new InvoiceGenerator();
      const invoiceData = {
        ...payment.toObject(),
        customer: payment.customerId,
        project: payment.projectId
      };

      const htmlInvoice = invoiceGenerator.generateHTMLInvoice(invoiceData);

      res.setHeader('Content-Type', 'text/html');
      res.send(htmlInvoice);
    } catch (error) {
      console.error('Get invoice error:', error);
      res.status(500).json({
        error: 'Failed to generate invoice',
        message: 'Unable to retrieve invoice'
      });
    }
  }
);

// @route   POST /api/payments/calculate-emi
// @desc    Calculate EMI for a given amount
// @access  Public
router.post('/calculate-emi',
  [
    body('principal').isNumeric({ min: 1 }),
    body('rate').isNumeric({ min: 0 }),
    body('tenure').isInt({ min: 1 })
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { principal, rate, tenure } = req.body;
      
      const monthlyRate = rate / 12 / 100;
      const emi = (principal * monthlyRate * Math.pow(1 + monthlyRate, tenure)) / 
                  (Math.pow(1 + monthlyRate, tenure) - 1);
      
      const totalAmount = Math.round(emi * tenure);
      const totalInterest = totalAmount - principal;
      
      res.json({
        success: true,
        data: {
          monthlyEMI: Math.round(emi),
          totalAmount,
          totalInterest,
          principal,
          rate,
          tenure,
          breakdown: Array.from({ length: Math.min(tenure, 12) }, (_, i) => {
            const month = i + 1;
            const interestComponent = Math.round(principal * monthlyRate);
            const principalComponent = Math.round(emi - interestComponent);
            return {
              month,
              emi: Math.round(emi),
              principal: principalComponent,
              interest: interestComponent,
              balance: Math.round(principal - (principalComponent * month))
            };
          })
        }
      });
    } catch (error) {
      console.error('EMI calculation error:', error);
      res.status(500).json({
        error: 'Failed to calculate EMI',
        message: 'Unable to process EMI calculation'
      });
    }
  }
);

// @route   POST /api/payments/webhook
// @desc    Razorpay webhook endpoint
// @access  Public (validated by signature)
router.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      // TODO: Validate webhook signature
      // const signature = req.headers['x-razorpay-signature'];
      // const crypto = require('crypto');
      // const expectedSignature = crypto
      //   .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      //   .update(JSON.stringify(req.body))
      //   .digest('hex');
      // 
      // if (signature !== expectedSignature) {
      //   return res.status(400).json({ error: 'Invalid webhook signature' });
      // }

      const event = req.body;
      
      switch (event.event) {
        case 'payment.captured':
          // Handle successful payment
          break;
        case 'payment.failed':
          // Handle failed payment
          break;
        case 'refund.processed':
          // Handle successful refund
          break;
        default:
          console.log('Unhandled webhook event:', event.event);
      }

      res.json({ received: true });
    } catch (error) {
      console.error('Webhook error:', error);
      res.status(400).json({ error: 'Webhook processing failed' });
    }
  }
);

module.exports = router;
