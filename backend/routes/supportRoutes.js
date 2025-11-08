const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const SupportRequest = require('../models/SupportRequest');
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

// @route   POST /api/support/requests
// @desc    Create support request
// @access  Private (Customer)
router.post('/requests',
  authenticateToken,
  [
    body('type').isIn(['feedback', 'grievance', 'suggestion', 'technical', 'billing']),
    body('category').optional().trim(),
    body('subject').notEmpty().trim().isLength({ max: 200 }),
    body('description').notEmpty().trim().isLength({ max: 2000 }),
    body('priority').optional().isIn(['low', 'medium', 'high', 'urgent'])
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { type, category, subject, description, priority } = req.body;

      const supportRequest = new SupportRequest({
        customerId: req.userId,
        type,
        category,
        subject,
        description,
        priority: priority || 'medium',
        ticketNumber: 'temp' // Will be generated in pre-save hook
      });

      await supportRequest.save();

      // Populate customer info
      await supportRequest.populate('customerId', 'firstName lastName email');

      res.status(201).json({
        success: true,
        message: 'Support request created successfully',
        data: supportRequest
      });
    } catch (error) {
      console.error('Create support request error:', error);
      res.status(500).json({
        error: 'Failed to create support request',
        message: 'Unable to submit support request'
      });
    }
  }
);

// @route   GET /api/support/requests
// @desc    Get support requests (Admin: all, Customer: own)
// @access  Private
router.get('/requests',
  authenticateToken,
  async (req, res) => {
    try {
      const { status, type, priority, page = 1, limit = 10, sort = '-createdAt' } = req.query;
      
      // Build filter
      let filter = {};
      if (req.user.role === 'customer') {
        filter.customerId = req.userId;
      }
      if (status) filter.status = status;
      if (type) filter.type = type;
      if (priority) filter.priority = priority;

      // Build sort
      let sortObj = {};
      if (sort.startsWith('-')) {
        sortObj[sort.substring(1)] = -1;
      } else {
        sortObj[sort] = 1;
      }

      // Execute query with pagination
      const tickets = await SupportRequest.find(filter)
        .populate('customerId', 'firstName lastName email')
        .populate('assignedTo', 'firstName lastName')
        .sort(sortObj)
        .limit(limit * 1)
        .skip((page - 1) * limit);

      const totalCount = await SupportRequest.countDocuments(filter);

      res.json({
        success: true,
        data: tickets,
        pagination: {
          total: totalCount,
          page: Number(page),
          pages: Math.ceil(totalCount / limit),
          limit: Number(limit)
        }
      });
    } catch (error) {
      console.error('Get support requests error:', error);
      res.status(500).json({
        error: 'Failed to fetch support requests',
        message: 'Unable to retrieve support tickets'
      });
    }
  }
);

// @route   GET /api/support/requests/:id
// @desc    Get single support request
// @access  Private (Owner or Admin)
router.get('/requests/:id',
  authenticateToken,
  [param('id').isMongoId()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const ticket = await SupportRequest.findById(req.params.id)
        .populate('customerId', 'firstName lastName email phone')
        .populate('assignedTo', 'firstName lastName')
        .populate('comments.author', 'firstName lastName role')
        .populate('resolution.resolvedBy', 'firstName lastName');

      if (!ticket) {
        return res.status(404).json({
          error: 'Support request not found'
        });
      }

      // Check authorization
      const isOwner = ticket.customerId._id.toString() === req.userId.toString();
      const isAdmin = req.user.role === 'admin';

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      // Filter internal comments for customers
      if (req.user.role === 'customer') {
        ticket.comments = ticket.comments.filter(comment => !comment.isInternal);
      }

      res.json({
        success: true,
        data: ticket
      });
    } catch (error) {
      console.error('Get support request error:', error);
      res.status(500).json({
        error: 'Failed to fetch support request',
        message: 'Unable to retrieve ticket details'
      });
    }
  }
);

// @route   PUT /api/support/requests/:id
// @desc    Update support request
// @access  Private (Admin: all fields, Customer: limited)
router.put('/requests/:id',
  authenticateToken,
  [
    param('id').isMongoId(),
    body('status').optional().isIn(['open', 'in_review', 'pending_customer', 'resolved', 'closed']),
    body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']),
    body('assignedTo').optional().isMongoId()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const ticket = await SupportRequest.findById(req.params.id);

      if (!ticket) {
        return res.status(404).json({
          error: 'Support request not found'
        });
      }

      // Check authorization
      const isOwner = ticket.customerId.toString() === req.userId.toString();
      const isAdmin = req.user.role === 'admin';

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      // Customers can only update certain fields
      let updates = {};
      if (isAdmin) {
        updates = req.body;
      } else {
        // Customers can only reopen closed tickets
        if (req.body.status === 'open' && (ticket.status === 'resolved' || ticket.status === 'closed')) {
          await ticket.reopen('Customer reopened the ticket');
          const updatedTicket = await SupportRequest.findById(req.params.id)
            .populate('customerId', 'firstName lastName email');
          return res.json({
            success: true,
            message: 'Ticket reopened successfully',
            data: updatedTicket
          });
        } else {
          return res.status(403).json({
            error: 'Limited update access',
            message: 'Customers can only reopen resolved/closed tickets'
          });
        }
      }

      // Update ticket
      const updatedTicket = await SupportRequest.findByIdAndUpdate(
        req.params.id,
        { $set: updates },
        { new: true, runValidators: true }
      )
      .populate('customerId', 'firstName lastName email')
      .populate('assignedTo', 'firstName lastName');

      res.json({
        success: true,
        message: 'Support request updated successfully',
        data: updatedTicket
      });
    } catch (error) {
      console.error('Update support request error:', error);
      res.status(500).json({
        error: 'Failed to update support request',
        message: 'Unable to update ticket'
      });
    }
  }
);

// @route   POST /api/support/requests/:id/comments
// @desc    Add comment to support request
// @access  Private (Admin or Owner)
router.post('/requests/:id/comments',
  authenticateToken,
  [
    param('id').isMongoId(),
    body('text').notEmpty().trim(),
    body('isInternal').optional().isBoolean()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const ticket = await SupportRequest.findById(req.params.id);

      if (!ticket) {
        return res.status(404).json({
          error: 'Support request not found'
        });
      }

      // Check authorization
      const isOwner = ticket.customerId.toString() === req.userId.toString();
      const isAdmin = req.user.role === 'admin';

      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      // Only admins can add internal comments
      const isInternal = req.user.role === 'admin' ? (req.body.isInternal || false) : false;

      await ticket.addComment(req.body.text, req.userId, isInternal, req.body.attachments);

      const updatedTicket = await SupportRequest.findById(req.params.id)
        .populate('comments.author', 'firstName lastName role');

      res.json({
        success: true,
        message: 'Comment added successfully',
        data: updatedTicket
      });
    } catch (error) {
      console.error('Add comment error:', error);
      res.status(500).json({
        error: 'Failed to add comment',
        message: 'Unable to add comment to ticket'
      });
    }
  }
);

// @route   PUT /api/support/requests/:id/resolve
// @desc    Resolve support request
// @access  Private (Admin)
router.put('/requests/:id/resolve',
  authenticateToken,
  authorizeRoles('admin'),
  [
    param('id').isMongoId(),
    body('resolutionText').notEmpty().trim()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const ticket = await SupportRequest.findById(req.params.id);

      if (!ticket) {
        return res.status(404).json({
          error: 'Support request not found'
        });
      }

      await ticket.resolve(req.body.resolutionText, req.userId);

      const updatedTicket = await SupportRequest.findById(req.params.id)
        .populate('resolution.resolvedBy', 'firstName lastName');

      res.json({
        success: true,
        message: 'Ticket resolved successfully',
        data: updatedTicket
      });
    } catch (error) {
      console.error('Resolve ticket error:', error);
      res.status(500).json({
        error: 'Failed to resolve ticket',
        message: 'Unable to resolve support request'
      });
    }
  }
);

// @route   POST /api/support/requests/:id/rating
// @desc    Rate support response
// @access  Private (Customer - Owner only)
router.post('/requests/:id/rating',
  authenticateToken,
  [
    param('id').isMongoId(),
    body('score').isInt({ min: 1, max: 5 }),
    body('feedback').optional().trim()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const ticket = await SupportRequest.findById(req.params.id);

      if (!ticket) {
        return res.status(404).json({
          error: 'Support request not found'
        });
      }

      // Check if user is the owner
      if (ticket.customerId.toString() !== req.userId.toString()) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'Only ticket owner can rate the support'
        });
      }

      await ticket.addRating(req.body.score, req.body.feedback);

      res.json({
        success: true,
        message: 'Rating added successfully',
        data: ticket
      });
    } catch (error) {
      console.error('Add rating error:', error);
      res.status(500).json({
        error: 'Failed to add rating',
        message: error.message || 'Unable to rate support request'
      });
    }
  }
);

// @route   PUT /api/support/requests/:id/assign
// @desc    Assign ticket to support agent
// @access  Private (Admin)
router.put('/requests/:id/assign',
  authenticateToken,
  authorizeRoles('admin'),
  [
    param('id').isMongoId(),
    body('agentId').isMongoId()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const ticket = await SupportRequest.findById(req.params.id);

      if (!ticket) {
        return res.status(404).json({
          error: 'Support request not found'
        });
      }

      await ticket.assignToAgent(req.body.agentId);

      const updatedTicket = await SupportRequest.findById(req.params.id)
        .populate('assignedTo', 'firstName lastName');

      res.json({
        success: true,
        message: 'Ticket assigned successfully',
        data: updatedTicket
      });
    } catch (error) {
      console.error('Assign ticket error:', error);
      res.status(500).json({
        error: 'Failed to assign ticket',
        message: 'Unable to assign support request'
      });
    }
  }
);

// @route   GET /api/support/requests/stats/overview
// @desc    Get support statistics
// @access  Private (Admin)
router.get('/requests/stats/overview',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const stats = await SupportRequest.getStatistics();

      const totalTickets = await SupportRequest.countDocuments();
      const openTickets = await SupportRequest.countDocuments({ status: 'open' });
      const resolvedTickets = await SupportRequest.countDocuments({ status: 'resolved' });
      
      // Calculate average rating
      const ratedTickets = await SupportRequest.find({ 'rating.score': { $exists: true } });
      const avgRating = ratedTickets.length > 0
        ? ratedTickets.reduce((sum, t) => sum + t.rating.score, 0) / ratedTickets.length
        : 0;

      res.json({
        success: true,
        data: {
          total: totalTickets,
          open: openTickets,
          resolved: resolvedTickets,
          resolutionRate: totalTickets > 0 ? (resolvedTickets / totalTickets * 100).toFixed(2) : 0,
          averageRating: avgRating.toFixed(2),
          ...stats
        }
      });
    } catch (error) {
      console.error('Get support stats error:', error);
      res.status(500).json({
        error: 'Failed to fetch statistics',
        message: 'Unable to retrieve support statistics'
      });
    }
  }
);

// @route   DELETE /api/support/requests/:id
// @desc    Delete support request (Admin only)
// @access  Private (Admin)
router.delete('/requests/:id',
  authenticateToken,
  authorizeRoles('admin'),
  [param('id').isMongoId()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const ticket = await SupportRequest.findByIdAndDelete(req.params.id);

      if (!ticket) {
        return res.status(404).json({
          error: 'Support request not found'
        });
      }

      res.json({
        success: true,
        message: 'Support request deleted successfully'
      });
    } catch (error) {
      console.error('Delete support request error:', error);
      res.status(500).json({
        error: 'Failed to delete support request',
        message: 'Unable to delete ticket'
      });
    }
  }
);

module.exports = router;
