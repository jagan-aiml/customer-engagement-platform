const mongoose = require('mongoose');

const enquirySchema = new mongoose.Schema({
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
  enquiryType: {
    type: String,
    enum: ['general', 'pricing', 'site_visit', 'documentation'],
    default: 'general'
  },
  details: {
    type: String,
    required: [true, 'Enquiry details are required'],
    maxlength: [1000, 'Details cannot exceed 1000 characters']
  },
  preferredContactMethod: {
    type: String,
    enum: ['email', 'phone', 'whatsapp'],
    default: 'email'
  },
  preferredContactTime: String,
  status: {
    type: String,
    enum: ['new', 'in_progress', 'follow_up', 'converted', 'closed'],
    default: 'new'
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  notes: [{
    text: {
      type: String,
      required: true
    },
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    addedAt: {
      type: Date,
      default: Date.now
    },
    isInternal: {
      type: Boolean,
      default: false
    }
  }],
  followUpDate: Date,
  responseTime: Number, // in hours
  resolutionTime: Number, // in hours
  convertedToPayment: {
    type: Boolean,
    default: false
  },
  paymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment',
    default: null
  }
}, {
  timestamps: true
});

// Indexes for better query performance
enquirySchema.index({ customerId: 1 });
enquirySchema.index({ projectId: 1 });
enquirySchema.index({ status: 1 });
enquirySchema.index({ assignedTo: 1 });
enquirySchema.index({ createdAt: -1 });

// Virtual for age of enquiry (in days)
enquirySchema.virtual('ageInDays').get(function() {
  const now = new Date();
  const created = new Date(this.createdAt);
  const diffTime = Math.abs(now - created);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
});

// Virtual for overdue status
enquirySchema.virtual('isOverdue').get(function() {
  if (!this.followUpDate) return false;
  return new Date() > new Date(this.followUpDate) && this.status !== 'closed' && this.status !== 'converted';
});

// Pre-save hook to calculate response time
enquirySchema.pre('save', function(next) {
  if (this.isModified('status') && this.status !== 'new' && !this.responseTime) {
    const now = new Date();
    const created = new Date(this.createdAt);
    this.responseTime = Math.abs(now - created) / (1000 * 60 * 60); // Convert to hours
  }
  
  if (this.status === 'closed' || this.status === 'converted') {
    if (!this.resolutionTime) {
      const now = new Date();
      const created = new Date(this.createdAt);
      this.resolutionTime = Math.abs(now - created) / (1000 * 60 * 60); // Convert to hours
    }
  }
  
  next();
});

// Method to add a note
enquirySchema.methods.addNote = function(text, userId, isInternal = false) {
  this.notes.push({
    text,
    addedBy: userId,
    isInternal
  });
  return this.save();
};

// Method to assign to admin
enquirySchema.methods.assignToAdmin = function(adminId) {
  this.assignedTo = adminId;
  this.status = 'in_progress';
  return this.save();
};

// Static method to get statistics
enquirySchema.statics.getStatistics = async function(filter = {}) {
  const stats = await this.aggregate([
    { $match: filter },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        avgResponseTime: { $avg: '$responseTime' },
        avgResolutionTime: { $avg: '$resolutionTime' }
      }
    }
  ]);
  
  return stats;
};

module.exports = mongoose.model('Enquiry', enquirySchema);
