const mongoose = require('mongoose');

const supportRequestSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  ticketNumber: {
    type: String,
    unique: true,
    required: true
  },
  type: {
    type: String,
    enum: ['feedback', 'grievance', 'suggestion', 'technical', 'billing'],
    required: true
  },
  category: {
    type: String,
    trim: true
  },
  subject: {
    type: String,
    required: [true, 'Subject is required'],
    trim: true,
    maxlength: [200, 'Subject cannot exceed 200 characters']
  },
  description: {
    type: String,
    required: [true, 'Description is required'],
    maxlength: [2000, 'Description cannot exceed 2000 characters']
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  status: {
    type: String,
    enum: ['open', 'in_review', 'pending_customer', 'resolved', 'closed'],
    default: 'open'
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  attachments: [{
    name: String,
    url: String,
    type: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  comments: [{
    text: {
      type: String,
      required: true
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    isInternal: {
      type: Boolean,
      default: false
    },
    attachments: [{
      name: String,
      url: String
    }],
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  resolution: {
    text: String,
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    resolvedAt: Date
  },
  rating: {
    score: {
      type: Number,
      min: 1,
      max: 5
    },
    feedback: String,
    ratedAt: Date
  },
  sla: {
    responseTime: Number, // in hours
    resolutionTime: Number, // in hours
    breached: {
      type: Boolean,
      default: false
    },
    responseDeadline: Date,
    resolutionDeadline: Date
  },
  firstResponseAt: Date,
  closedAt: Date,
  reopenedCount: {
    type: Number,
    default: 0
  },
  lastReopenedAt: Date
}, {
  timestamps: true
});

// Indexes for better query performance
supportRequestSchema.index({ customerId: 1 });
supportRequestSchema.index({ ticketNumber: 1 });
supportRequestSchema.index({ status: 1 });
supportRequestSchema.index({ priority: 1 });
supportRequestSchema.index({ assignedTo: 1 });
supportRequestSchema.index({ createdAt: -1 });

// Virtual for age of ticket
supportRequestSchema.virtual('ageInDays').get(function() {
  const now = new Date();
  const created = new Date(this.createdAt);
  const diffTime = Math.abs(now - created);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
});

// Virtual for response time status
supportRequestSchema.virtual('isResponseOverdue').get(function() {
  if (this.firstResponseAt || this.status === 'closed') return false;
  if (!this.sla.responseDeadline) return false;
  return new Date() > new Date(this.sla.responseDeadline);
});

// Virtual for resolution time status
supportRequestSchema.virtual('isResolutionOverdue').get(function() {
  if (this.status === 'resolved' || this.status === 'closed') return false;
  if (!this.sla.resolutionDeadline) return false;
  return new Date() > new Date(this.sla.resolutionDeadline);
});

// Pre-save hook to generate ticket number and set SLA
supportRequestSchema.pre('save', async function(next) {
  // Generate ticket number for new requests
  if (this.isNew && !this.ticketNumber) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const count = await mongoose.model('SupportRequest').countDocuments();
    const sequential = String(count + 1).padStart(5, '0');
    this.ticketNumber = `TKT${year}${month}${sequential}`;
  }
  
  // Set SLA deadlines based on priority
  if (this.isNew) {
    const now = new Date();
    let responseHours = 24; // default
    let resolutionHours = 72; // default
    
    switch(this.priority) {
      case 'urgent':
        responseHours = 2;
        resolutionHours = 24;
        break;
      case 'high':
        responseHours = 4;
        resolutionHours = 48;
        break;
      case 'medium':
        responseHours = 24;
        resolutionHours = 72;
        break;
      case 'low':
        responseHours = 48;
        resolutionHours = 120;
        break;
    }
    
    this.sla.responseDeadline = new Date(now.getTime() + responseHours * 60 * 60 * 1000);
    this.sla.resolutionDeadline = new Date(now.getTime() + resolutionHours * 60 * 60 * 1000);
  }
  
  // Track first response time
  if (this.comments.length > 0 && !this.firstResponseAt) {
    const adminComments = this.comments.filter(c => !c.isInternal || c.author.role === 'admin');
    if (adminComments.length > 0) {
      this.firstResponseAt = adminComments[0].createdAt;
      this.sla.responseTime = Math.abs(new Date(this.firstResponseAt) - new Date(this.createdAt)) / (1000 * 60 * 60);
    }
  }
  
  // Track resolution time
  if (this.status === 'resolved' && !this.resolution.resolvedAt) {
    this.resolution.resolvedAt = new Date();
    this.sla.resolutionTime = Math.abs(new Date() - new Date(this.createdAt)) / (1000 * 60 * 60);
  }
  
  // Track closure
  if (this.status === 'closed' && !this.closedAt) {
    this.closedAt = new Date();
  }
  
  // Check SLA breach
  if (this.sla.responseDeadline && new Date() > this.sla.responseDeadline && !this.firstResponseAt) {
    this.sla.breached = true;
  }
  if (this.sla.resolutionDeadline && new Date() > this.sla.resolutionDeadline && this.status !== 'resolved' && this.status !== 'closed') {
    this.sla.breached = true;
  }
  
  next();
});

// Method to add comment
supportRequestSchema.methods.addComment = function(text, authorId, isInternal = false, attachments = []) {
  this.comments.push({
    text,
    author: authorId,
    isInternal,
    attachments
  });
  return this.save();
};

// Method to assign to support agent
supportRequestSchema.methods.assignToAgent = function(agentId) {
  this.assignedTo = agentId;
  this.status = 'in_review';
  return this.save();
};

// Method to resolve ticket
supportRequestSchema.methods.resolve = function(resolutionText, resolvedById) {
  this.status = 'resolved';
  this.resolution = {
    text: resolutionText,
    resolvedBy: resolvedById,
    resolvedAt: new Date()
  };
  return this.save();
};

// Method to reopen ticket
supportRequestSchema.methods.reopen = function(reason) {
  if (this.status === 'closed' || this.status === 'resolved') {
    this.status = 'open';
    this.reopenedCount += 1;
    this.lastReopenedAt = new Date();
    this.resolution = {};
    if (reason) {
      this.comments.push({
        text: `Ticket reopened: ${reason}`,
        author: this.customerId,
        isInternal: false,
        createdAt: new Date()
      });
    }
  }
  return this.save();
};

// Method to rate support
supportRequestSchema.methods.addRating = function(score, feedback) {
  if (this.status !== 'resolved' && this.status !== 'closed') {
    throw new Error('Can only rate resolved or closed tickets');
  }
  
  this.rating = {
    score,
    feedback,
    ratedAt: new Date()
  };
  return this.save();
};

// Static method to get statistics
supportRequestSchema.statics.getStatistics = async function(filter = {}) {
  const stats = await this.aggregate([
    { $match: filter },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        avgResponseTime: { $avg: '$sla.responseTime' },
        avgResolutionTime: { $avg: '$sla.resolutionTime' },
        avgRating: { $avg: '$rating.score' },
        breachedCount: {
          $sum: { $cond: ['$sla.breached', 1, 0] }
        }
      }
    }
  ]);
  
  const priorityStats = await this.aggregate([
    { $match: filter },
    {
      $group: {
        _id: '$priority',
        count: { $sum: 1 }
      }
    }
  ]);
  
  const typeStats = await this.aggregate([
    { $match: filter },
    {
      $group: {
        _id: '$type',
        count: { $sum: 1 }
      }
    }
  ]);
  
  return {
    byStatus: stats,
    byPriority: priorityStats,
    byType: typeStats
  };
};

module.exports = mongoose.model('SupportRequest', supportRequestSchema);
