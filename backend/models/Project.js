const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Project name is required'],
    trim: true,
    maxlength: [100, 'Project name cannot exceed 100 characters']
  },
  description: {
    type: String,
    required: [true, 'Project description is required'],
    maxlength: [2000, 'Description cannot exceed 2000 characters']
  },
  shortDescription: {
    type: String,
    maxlength: [200, 'Short description cannot exceed 200 characters']
  },
  area: {
    type: String,
    required: [true, 'Project area is required'],
    trim: true
  },
  status: {
    type: String,
    enum: ['upcoming', 'in_progress', 'completed'],
    required: true,
    default: 'upcoming'
  },
  specifications: [{
    type: String,
    value: String
  }],
  pricing: {
    basePrice: {
      type: Number,
      required: [true, 'Base price is required'],
      min: [0, 'Price cannot be negative']
    },
    pricePerSqFt: {
      type: Number,
      min: [0, 'Price per sq ft cannot be negative']
    },
    currency: {
      type: String,
      default: 'INR'
    },
    paymentPlans: [{
      name: String,
      description: String,
      downPayment: Number,
      emiMonths: Number,
      interestRate: Number
    }]
  },
  images: [{
    url: {
      type: String,
      required: true
    },
    caption: String,
    isPrimary: {
      type: Boolean,
      default: false
    }
  }],
  location: {
    address: {
      type: String,
      required: true
    },
    latitude: {
      type: Number,
      required: true,
      min: -90,
      max: 90
    },
    longitude: {
      type: Number,
      required: true,
      min: -180,
      max: 180
    },
    nearbyLandmarks: [String]
  },
  dimensions: {
    totalArea: Number,
    builtUpArea: Number,
    carpetArea: Number,
    units: {
      type: String,
      default: 'sqft'
    }
  },
  availability: {
    totalUnits: {
      type: Number,
      default: 1
    },
    availableUnits: {
      type: Number,
      default: 1
    },
    soldUnits: {
      type: Number,
      default: 0
    }
  },
  developer: {
    name: String,
    logo: String,
    description: String
  },
  features: [{
    type: String,
    trim: true
  }],
  documents: [{
    name: String,
    url: String,
    type: {
      type: String,
      enum: ['brochure', 'floor_plan', 'price_list', 'other']
    }
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  views: {
    type: Number,
    default: 0
  },
  enquiryCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Indexes for better query performance
projectSchema.index({ name: 1 });
projectSchema.index({ area: 1 });
projectSchema.index({ status: 1 });
projectSchema.index({ 'pricing.basePrice': 1 });
projectSchema.index({ 'location.latitude': 1, 'location.longitude': 1 });
projectSchema.index({ isActive: 1 });

// Virtual for availability percentage
projectSchema.virtual('availabilityPercentage').get(function() {
  if (this.availability.totalUnits === 0) return 0;
  return Math.round((this.availability.availableUnits / this.availability.totalUnits) * 100);
});

// Virtual for primary image
projectSchema.virtual('primaryImage').get(function() {
  const primary = this.images.find(img => img.isPrimary);
  return primary ? primary.url : (this.images.length > 0 ? this.images[0].url : null);
});

// Method to check if project is available
projectSchema.methods.isAvailable = function() {
  return this.isActive && this.availability.availableUnits > 0;
};

// Method to update availability after booking
projectSchema.methods.updateAvailability = function(units = 1) {
  if (this.availability.availableUnits >= units) {
    this.availability.availableUnits -= units;
    this.availability.soldUnits += units;
    return true;
  }
  return false;
};

// Pre-save hook to ensure data consistency
projectSchema.pre('save', function(next) {
  // Ensure only one primary image
  const primaryImages = this.images.filter(img => img.isPrimary);
  if (primaryImages.length > 1) {
    this.images.forEach((img, index) => {
      img.isPrimary = index === 0;
    });
  }
  
  // Ensure availability consistency
  if (this.availability.soldUnits > this.availability.totalUnits) {
    this.availability.soldUnits = this.availability.totalUnits;
  }
  this.availability.availableUnits = this.availability.totalUnits - this.availability.soldUnits;
  
  next();
});

module.exports = mongoose.model('Project', projectSchema);
