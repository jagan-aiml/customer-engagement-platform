const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const User = require('../models/User');
const Project = require('../models/Project');
const Enquiry = require('../models/Enquiry');
const Payment = require('../models/Payment');
const SupportRequest = require('../models/SupportRequest');

// @route   GET /api/dashboard/customer-stats
// @desc    Get customer statistics (Admin only)
// @access  Private (Admin)
router.get('/customer-stats',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const totalCustomers = await User.countDocuments({ role: 'customer' });
      
      const customersByStatus = await User.aggregate([
        { $match: { role: 'customer' } },
        {
          $group: {
            _id: '$statusType',
            count: { $sum: 1 }
          }
        }
      ]);

      const recentCustomers = await User.find({ role: 'customer' })
        .sort('-createdAt')
        .limit(5)
        .select('firstName lastName email createdAt statusType');

      res.json({
        success: true,
        data: {
          total: totalCustomers,
          byStatus: customersByStatus,
          recent: recentCustomers
        }
      });
    } catch (error) {
      console.error('Get customer stats error:', error);
      res.status(500).json({
        error: 'Failed to fetch customer statistics'
      });
    }
  }
);

// @route   GET /api/dashboard/project-stats
// @desc    Get project statistics (Admin only)
// @access  Private (Admin)
router.get('/project-stats',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const stats = await Project.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalValue: { $sum: '$pricing.basePrice' }
          }
        }
      ]);

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      console.error('Get project stats error:', error);
      res.status(500).json({
        error: 'Failed to fetch project statistics'
      });
    }
  }
);

// @route   GET /api/dashboard/revenue-stats
// @desc    Get revenue statistics (Admin only)
// @access  Private (Admin)
router.get('/revenue-stats',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const stats = await Payment.getStatistics();
      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      console.error('Get revenue stats error:', error);
      res.status(500).json({
        error: 'Failed to fetch revenue statistics'
      });
    }
  }
);

// @route   GET /api/dashboard/quick-stats
// @desc    Get quick statistics for dashboard
// @access  Private
router.get('/quick-stats',
  authenticateToken,
  async (req, res) => {
    try {
      if (req.user.role === 'admin') {
        const [projects, enquiries, payments, tickets, customers] = await Promise.all([
          Project.countDocuments({ isActive: true }),
          Enquiry.countDocuments(),
          Payment.countDocuments({ status: 'success' }),
          SupportRequest.countDocuments(),
          User.countDocuments({ role: 'customer' })
        ]);

        res.json({
          success: true,
          data: {
            projects,
            enquiries,
            payments,
            tickets,
            customers
          }
        });
      } else {
        // Customer quick stats
        const [enquiries, payments, tickets] = await Promise.all([
          Enquiry.countDocuments({ customerId: req.userId }),
          Payment.countDocuments({ customerId: req.userId, status: 'success' }),
          SupportRequest.countDocuments({ customerId: req.userId })
        ]);

        res.json({
          success: true,
          data: {
            enquiries,
            payments,
            tickets
          }
        });
      }
    } catch (error) {
      console.error('Get quick stats error:', error);
      res.status(500).json({
        error: 'Failed to fetch statistics'
      });
    }
  }
);

module.exports = router;
