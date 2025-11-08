const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const Enquiry = require('../models/Enquiry');
const Project = require('../models/Project');
const User = require('../models/User');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

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

// @route   POST /api/enquiries
// @desc    Create new enquiry
// @access  Private (Customer)
router.post('/',
  authenticateToken,
  [
    body('projectId').isMongoId().withMessage('Valid project ID required'),
    body('enquiryType').isIn(['general', 'pricing', 'site_visit', 'documentation']),
    body('details').notEmpty().trim().isLength({ max: 1000 }),
    body('preferredContactMethod').optional().isIn(['email', 'phone', 'whatsapp']),
    body('preferredContactTime').optional().trim()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { projectId, enquiryType, details, preferredContactMethod, preferredContactTime } = req.body;

      // Check if project exists
      const project = await Project.findById(projectId);
      if (!project || !project.isActive) {
        return res.status(404).json({
          error: 'Project not found'
        });
      }

      // Create enquiry
      const enquiry = new Enquiry({
        customerId: req.userId,
        projectId,
        enquiryType,
        details,
        preferredContactMethod: preferredContactMethod || 'email',
        preferredContactTime
      });

      await enquiry.save();

      // Update project enquiry count
      project.enquiryCount += 1;
      await project.save();

      // Update user status if it's their first enquiry
      const user = await User.findById(req.userId);
      if (user.statusType === 'just_enquired') {
        user.statusType = 'just_enquired';
        await user.save();
      }

      // Populate the enquiry before sending response
      await enquiry.populate(['projectId', 'customerId']);

      res.status(201).json({
        success: true,
        message: 'Enquiry submitted successfully',
        data: enquiry
      });
    } catch (error) {
      console.error('Create enquiry error:', error);
      res.status(500).json({
        error: 'Failed to create enquiry',
        message: 'Unable to submit enquiry'
      });
    }
  }
);

// @route   GET /api/enquiries
// @desc    Get enquiries (Admin: all, Customer: own)
// @access  Private
router.get('/',
  authenticateToken,
  async (req, res) => {
    try {
      const { status, priority, page = 1, limit = 10, sort = '-createdAt' } = req.query;
      
      // Build filter
      let filter = {};
      if (req.user.role === 'customer') {
        filter.customerId = req.userId;
      }
      if (status) filter.status = status;
      if (priority) filter.priority = priority;

      // Build sort
      let sortObj = {};
      if (sort.startsWith('-')) {
        sortObj[sort.substring(1)] = -1;
      } else {
        sortObj[sort] = 1;
      }

      // Execute query with pagination
      const enquiries = await Enquiry.find(filter)
        .populate('projectId', 'name area status pricing')
        .populate('customerId', 'firstName lastName email phone')
        .populate('assignedTo', 'firstName lastName')
        .sort(sortObj)
        .limit(limit * 1)
        .skip((page - 1) * limit);

      const totalCount = await Enquiry.countDocuments(filter);

      res.json({
        success: true,
        data: enquiries,
        pagination: {
          total: totalCount,
          page: Number(page),
          pages: Math.ceil(totalCount / limit),
          limit: Number(limit)
        }
      });
    } catch (error) {
      console.error('Get enquiries error:', error);
      res.status(500).json({
        error: 'Failed to fetch enquiries',
        message: 'Unable to retrieve enquiries'
      });
    }
  }
);

// @route   GET /api/enquiries/:id
// @desc    Get single enquiry
// @access  Private (Owner or Admin)
router.get('/:id',
  authenticateToken,
  [param('id').isMongoId()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const enquiry = await Enquiry.findById(req.params.id)
        .populate('projectId')
        .populate('customerId', 'firstName lastName email phone')
        .populate('assignedTo', 'firstName lastName')
        .populate('notes.addedBy', 'firstName lastName role');

      if (!enquiry) {
        return res.status(404).json({
          error: 'Enquiry not found'
        });
      }

      // Check authorization
      const isOwner = enquiry.customerId._id.toString() === req.userId.toString();
      const isAdmin = req.user.role === 'admin';

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      res.json({
        success: true,
        data: enquiry
      });
    } catch (error) {
      console.error('Get enquiry error:', error);
      res.status(500).json({
        error: 'Failed to fetch enquiry',
        message: 'Unable to retrieve enquiry details'
      });
    }
  }
);

// @route   PUT /api/enquiries/:id
// @desc    Update enquiry (Admin only)
// @access  Private (Admin)
router.put('/:id',
  authenticateToken,
  authorizeRoles('admin'),
  [
    param('id').isMongoId(),
    body('status').optional().isIn(['new', 'in_progress', 'follow_up', 'converted', 'closed']),
    body('priority').optional().isIn(['low', 'medium', 'high']),
    body('assignedTo').optional().isMongoId(),
    body('followUpDate').optional().isISO8601()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const updates = req.body;

      const enquiry = await Enquiry.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { new: true, runValidators: true }
      )
      .populate('projectId', 'name area')
      .populate('customerId', 'firstName lastName email')
      .populate('assignedTo', 'firstName lastName');

      if (!enquiry) {
        return res.status(404).json({
          error: 'Enquiry not found'
        });
      }

      // If enquiry is converted, update user status
      if (updates.status === 'converted') {
        const user = await User.findById(enquiry.customerId);
        if (user && user.statusType === 'just_enquired') {
          user.statusType = 'paid_initial';
          await user.save();
        }
      }

      res.json({
        success: true,
        message: 'Enquiry updated successfully',
        data: enquiry
      });
    } catch (error) {
      console.error('Update enquiry error:', error);
      res.status(500).json({
        error: 'Failed to update enquiry',
        message: 'Unable to update enquiry'
      });
    }
  }
);

// @route   POST /api/enquiries/:id/notes
// @desc    Add note to enquiry
// @access  Private (Admin or Owner)
router.post('/:id/notes',
  authenticateToken,
  [
    param('id').isMongoId(),
    body('text').notEmpty().trim(),
    body('isInternal').optional().isBoolean()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const enquiry = await Enquiry.findById(req.params.id);

      if (!enquiry) {
        return res.status(404).json({
          error: 'Enquiry not found'
        });
      }

      // Check authorization
      const isOwner = enquiry.customerId.toString() === req.userId.toString();
      const isAdmin = req.user.role === 'admin';

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      // Customers can't add internal notes
      const isInternal = req.user.role === 'admin' ? req.body.isInternal : false;

      await enquiry.addNote(req.body.text, req.userId, isInternal);

      const updatedEnquiry = await Enquiry.findById(req.params.id)
        .populate('notes.addedBy', 'firstName lastName role');

      res.json({
        success: true,
        message: 'Note added successfully',
        data: updatedEnquiry
      });
    } catch (error) {
      console.error('Add note error:', error);
      res.status(500).json({
        error: 'Failed to add note',
        message: 'Unable to add note to enquiry'
      });
    }
  }
);

// @route   PUT /api/enquiries/:id/assign
// @desc    Assign enquiry to admin
// @access  Private (Admin)
router.put('/:id/assign',
  authenticateToken,
  authorizeRoles('admin'),
  [
    param('id').isMongoId(),
    body('adminId').isMongoId()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const enquiry = await Enquiry.findById(req.params.id);

      if (!enquiry) {
        return res.status(404).json({
          error: 'Enquiry not found'
        });
      }

      // Verify admin exists
      const admin = await User.findOne({ _id: req.body.adminId, role: 'admin' });
      if (!admin) {
        return res.status(400).json({
          error: 'Invalid admin ID'
        });
      }

      await enquiry.assignToAdmin(req.body.adminId);

      const updatedEnquiry = await Enquiry.findById(req.params.id)
        .populate('assignedTo', 'firstName lastName');

      res.json({
        success: true,
        message: 'Enquiry assigned successfully',
        data: updatedEnquiry
      });
    } catch (error) {
      console.error('Assign enquiry error:', error);
      res.status(500).json({
        error: 'Failed to assign enquiry',
        message: 'Unable to assign enquiry'
      });
    }
  }
);

// @route   GET /api/enquiries/stats
// @desc    Get enquiry statistics (Admin only)
// @access  Private (Admin)
router.get('/stats/overview',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const stats = await Enquiry.getStatistics();

      const totalEnquiries = await Enquiry.countDocuments();
      const newEnquiries = await Enquiry.countDocuments({ status: 'new' });
      const convertedEnquiries = await Enquiry.countDocuments({ status: 'converted' });

      res.json({
        success: true,
        data: {
          total: totalEnquiries,
          new: newEnquiries,
          converted: convertedEnquiries,
          conversionRate: totalEnquiries > 0 ? (convertedEnquiries / totalEnquiries * 100).toFixed(2) : 0,
          byStatus: stats
        }
      });
    } catch (error) {
      console.error('Get enquiry stats error:', error);
      res.status(500).json({
        error: 'Failed to fetch statistics',
        message: 'Unable to retrieve enquiry statistics'
      });
    }
  }
);

// @route   DELETE /api/enquiries/:id
// @desc    Delete enquiry (Admin only)
// @access  Private (Admin)
router.delete('/:id',
  authenticateToken,
  authorizeRoles('admin'),
  [param('id').isMongoId()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const enquiry = await Enquiry.findByIdAndDelete(req.params.id);

      if (!enquiry) {
        return res.status(404).json({
          error: 'Enquiry not found'
        });
      }

      // Update project enquiry count
      const project = await Project.findById(enquiry.projectId);
      if (project) {
        project.enquiryCount = Math.max(0, project.enquiryCount - 1);
        await project.save();
      }

      res.json({
        success: true,
        message: 'Enquiry deleted successfully'
      });
    } catch (error) {
      console.error('Delete enquiry error:', error);
      res.status(500).json({
        error: 'Failed to delete enquiry',
        message: 'Unable to delete enquiry'
      });
    }
  }
);

module.exports = router;
