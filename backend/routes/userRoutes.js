const express = require('express');
const router = express.Router();
const { param, body, validationResult } = require('express-validator');
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

// @route   GET /api/users
// @desc    Get all users (Admin only)
// @access  Private (Admin)
router.get('/',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { role, statusType, page = 1, limit = 10, sort = '-createdAt' } = req.query;
      
      // Build filter
      let filter = {};
      if (role) filter.role = role;
      if (statusType) filter.statusType = statusType;

      // Build sort
      let sortObj = {};
      if (sort.startsWith('-')) {
        sortObj[sort.substring(1)] = -1;
      } else {
        sortObj[sort] = 1;
      }

      // Execute query with pagination
      const users = await User.find(filter)
        .select('-password -refreshToken')
        .sort(sortObj)
        .limit(limit * 1)
        .skip((page - 1) * limit);

      const totalCount = await User.countDocuments(filter);

      res.json({
        success: true,
        data: users,
        pagination: {
          total: totalCount,
          page: Number(page),
          pages: Math.ceil(totalCount / limit),
          limit: Number(limit)
        }
      });
    } catch (error) {
      console.error('Get users error:', error);
      res.status(500).json({
        error: 'Failed to fetch users'
      });
    }
  }
);

// @route   GET /api/users/:id
// @desc    Get single user
// @access  Private (Admin or Self)
router.get('/:id',
  authenticateToken,
  [param('id').isMongoId()],
  handleValidationErrors,
  async (req, res) => {
    try {
      // Check if user is admin or accessing own profile
      if (req.user.role !== 'admin' && req.params.id !== req.userId.toString()) {
        return res.status(403).json({
          error: 'Access denied'
        });
      }

      const user = await User.findById(req.params.id)
        .select('-password -refreshToken');

      if (!user) {
        return res.status(404).json({
          error: 'User not found'
        });
      }

      res.json({
        success: true,
        data: user
      });
    } catch (error) {
      console.error('Get user error:', error);
      res.status(500).json({
        error: 'Failed to fetch user'
      });
    }
  }
);

// @route   PUT /api/users/:id/status
// @desc    Update user status (Admin only)
// @access  Private (Admin)
router.put('/:id/status',
  authenticateToken,
  authorizeRoles('admin'),
  [
    param('id').isMongoId(),
    body('statusType').isIn(['just_enquired', 'paid_initial', 'full_payment_pending', 'full_payment_moved_in', 'emi_customer'])
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const user = await User.findByIdAndUpdate(
        req.params.id,
        { statusType: req.body.statusType },
        { new: true, runValidators: true }
      ).select('-password -refreshToken');

      if (!user) {
        return res.status(404).json({
          error: 'User not found'
        });
      }

      res.json({
        success: true,
        message: 'User status updated successfully',
        data: user
      });
    } catch (error) {
      console.error('Update user status error:', error);
      res.status(500).json({
        error: 'Failed to update user status'
      });
    }
  }
);

// @route   GET /api/users/stats
// @desc    Get user statistics (Admin only)
// @access  Private (Admin)
router.get('/stats/overview',
  authenticateToken,
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const totalUsers = await User.countDocuments();
      const totalCustomers = await User.countDocuments({ role: 'customer' });
      const totalAdmins = await User.countDocuments({ role: 'admin' });
      
      const usersByStatus = await User.aggregate([
        { $match: { role: 'customer' } },
        {
          $group: {
            _id: '$statusType',
            count: { $sum: 1 }
          }
        }
      ]);

      const recentUsers = await User.find()
        .sort('-createdAt')
        .limit(10)
        .select('firstName lastName email role statusType createdAt');

      res.json({
        success: true,
        data: {
          total: totalUsers,
          customers: totalCustomers,
          admins: totalAdmins,
          byStatus: usersByStatus,
          recent: recentUsers
        }
      });
    } catch (error) {
      console.error('Get user stats error:', error);
      res.status(500).json({
        error: 'Failed to fetch user statistics'
      });
    }
  }
);

module.exports = router;
