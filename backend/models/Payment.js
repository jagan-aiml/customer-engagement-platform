const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  amount: {
    type: Number,
    required: [true, 'Payment amount is required'],
    min: [0, 'Amount cannot be negative']
  },
  currency: {
    type: String,
    default: 'INR'
  },
  paymentType: {
    type: String,
    enum: ['booking', 'down_payment', 'emi', 'full_payment', 'other'],
    required: true
  },
  method: {
    type: String,
    enum: ['card', 'bank_transfer', 'upi', 'cash', 'cheque'],
    required: true
  },
  gatewayDetails: {
    provider: {
      type: String,
      default: 'razorpay'
    },
    orderId: String,
    paymentId: String,
    signature: String,
    transactionId: String
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'success', 'failed', 'refunded'],
    default: 'pending'
  },
  receiptNumber: {
    type: String,
    unique: true,
    sparse: true
  },
  invoice: {
    number: String,
    url: String,
    generatedAt: Date
  },
  metadata: {
    unitNumber: String,
    paymentPlan: String,
    installmentNumber: Number,
    totalInstallments: Number,
    emiAmount: Number,
    nextDueDate: Date,
    description: String
  },
  refundDetails: {
    amount: Number,
    reason: String,
    date: Date,
    refundId: String,
    status: {
      type: String,
      enum: ['initiated', 'processing', 'completed', 'failed']
    }
  },
  failureReason: String,
  paidAt: Date,
  attempts: {
    type: Number,
    default: 0
  },
  notes: String
}, {
  timestamps: true
});

// Indexes for better query performance
paymentSchema.index({ customerId: 1 });
paymentSchema.index({ projectId: 1 });
paymentSchema.index({ status: 1 });
paymentSchema.index({ receiptNumber: 1 });
paymentSchema.index({ 'gatewayDetails.paymentId': 1 });
paymentSchema.index({ createdAt: -1 });

// Virtual for display amount (formatted)
paymentSchema.virtual('displayAmount').get(function() {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: this.currency
  }).format(this.amount);
});

// Virtual for payment age
paymentSchema.virtual('ageInDays').get(function() {
  if (!this.paidAt) return null;
  const now = new Date();
  const paid = new Date(this.paidAt);
  const diffTime = Math.abs(now - paid);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
});

// Pre-save hook to generate receipt number
paymentSchema.pre('save', async function(next) {
  if (this.status === 'success' && !this.receiptNumber) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    this.receiptNumber = `REC${year}${month}${random}`;
    this.paidAt = date;
  }
  
  // Update attempts count
  if (this.isModified('status') && this.status === 'failed') {
    this.attempts += 1;
  }
  
  next();
});

// Method to initiate refund
paymentSchema.methods.initiateRefund = function(amount, reason) {
  if (this.status !== 'success') {
    throw new Error('Can only refund successful payments');
  }
  
  if (amount > this.amount) {
    throw new Error('Refund amount cannot exceed payment amount');
  }
  
  this.refundDetails = {
    amount,
    reason,
    date: new Date(),
    status: 'initiated'
  };
  
  return this.save();
};

// Method to update payment status
paymentSchema.methods.updateStatus = function(status, details = {}) {
  this.status = status;
  
  if (status === 'success') {
    this.paidAt = new Date();
    if (details.paymentId) {
      this.gatewayDetails.paymentId = details.paymentId;
    }
    if (details.signature) {
      this.gatewayDetails.signature = details.signature;
    }
  } else if (status === 'failed') {
    this.failureReason = details.reason || 'Payment failed';
    this.attempts += 1;
  }
  
  return this.save();
};

// Static method to get payment statistics
paymentSchema.statics.getStatistics = async function(filter = {}) {
  const stats = await this.aggregate([
    { $match: { ...filter, status: 'success' } },
    {
      $group: {
        _id: null,
        totalAmount: { $sum: '$amount' },
        totalPayments: { $sum: 1 },
        avgAmount: { $avg: '$amount' },
        byType: {
          $push: {
            type: '$paymentType',
            amount: '$amount'
          }
        }
      }
    },
    {
      $project: {
        totalAmount: 1,
        totalPayments: 1,
        avgAmount: 1,
        paymentTypes: {
          $reduce: {
            input: '$byType',
            initialValue: {},
            in: {
              $mergeObjects: [
                '$$value',
                {
                  $arrayToObject: [[{
                    k: '$$this.type',
                    v: {
                      $add: [
                        { $ifNull: [{ $getField: { field: '$$this.type', input: '$$value' } }, 0] },
                        '$$this.amount'
                      ]
                    }
                  }]]
                }
              ]
            }
          }
        }
      }
    }
  ]);
  
  return stats[0] || {
    totalAmount: 0,
    totalPayments: 0,
    avgAmount: 0,
    paymentTypes: {}
  };
};

// Static method to get EMI defaulters
paymentSchema.statics.getEMIDefaulters = async function(daysOverdue = 7) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOverdue);
  
  return this.find({
    paymentType: 'emi',
    status: 'pending',
    'metadata.nextDueDate': { $lt: cutoffDate }
  }).populate('customerId projectId');
};

module.exports = mongoose.model('Payment', paymentSchema);
