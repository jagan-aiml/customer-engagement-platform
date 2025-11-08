const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const {
  generateToken,
  generateRefreshToken,
  authenticateToken,
  verifyRefreshToken,
  authRateLimiter
} = require('../middleware/auth');

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

// @route   POST /api/auth/register
// @desc    Register a new user
// @access  Public
router.post('/register', 
  authRateLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('firstName').notEmpty().trim().escape(),
    body('lastName').notEmpty().trim().escape(),
    body('phone').matches(/^[0-9]{10}$/).withMessage('Invalid phone number')
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { email, password, firstName, lastName, phone, role = 'customer' } = req.body;

      // Check if user exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({
          error: 'Registration failed',
          message: 'Email already registered'
        });
      }

      // Create new user
      const user = new User({
        email,
        password,
        firstName,
        lastName,
        phone,
        role: role === 'admin' && process.env.ALLOW_ADMIN_REGISTRATION === 'true' ? 'admin' : 'customer'
      });

      await user.save();

      // Generate tokens
      const token = generateToken(user._id);
      const refreshToken = generateRefreshToken(user._id);
      
      // Save refresh token
      user.refreshToken = refreshToken;
      await user.save();

      res.status(201).json({
        success: true,
        message: 'Registration successful',
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role
        },
        token,
        refreshToken
      });
    } catch (error) {
      console.error('Registration error:', error);
      res.status(500).json({
        error: 'Registration failed',
        message: 'Unable to create account'
      });
    }
  }
);

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login',
  authRateLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { email, password } = req.body;

      // Find user with password
      const user = await User.findOne({ email }).select('+password');
      
      if (!user) {
        return res.status(401).json({
          error: 'Authentication failed',
          message: 'Invalid credentials'
        });
      }

      // Check password
      const isPasswordValid = await user.comparePassword(password);
      
      if (!isPasswordValid) {
        return res.status(401).json({
          error: 'Authentication failed',
          message: 'Invalid credentials'
        });
      }

      // Update last login
      user.lastLogin = new Date();
      
      // Generate tokens
      const token = generateToken(user._id);
      const refreshToken = generateRefreshToken(user._id);
      
      // Save refresh token
      user.refreshToken = refreshToken;
      await user.save();

      res.json({
        success: true,
        message: 'Login successful',
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          statusType: user.statusType
        },
        token,
        refreshToken
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({
        error: 'Login failed',
        message: 'Unable to authenticate'
      });
    }
  }
);

// @route   POST /api/auth/refresh
// @desc    Refresh access token
// @access  Public
router.post('/refresh',
  [body('refreshToken').notEmpty()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { refreshToken } = req.body;
      
      const user = await verifyRefreshToken(refreshToken);
      
      // Generate new tokens
      const newToken = generateToken(user._id);
      const newRefreshToken = generateRefreshToken(user._id);
      
      // Save new refresh token
      user.refreshToken = newRefreshToken;
      await user.save();

      res.json({
        success: true,
        token: newToken,
        refreshToken: newRefreshToken
      });
    } catch (error) {
      console.error('Token refresh error:', error);
      res.status(401).json({
        error: 'Token refresh failed',
        message: 'Invalid refresh token'
      });
    }
  }
);

// @route   POST /api/auth/logout
// @desc    Logout user
// @access  Private
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    // Clear refresh token
    const user = await User.findById(req.userId);
    if (user) {
      user.refreshToken = null;
      await user.save();
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      error: 'Logout failed',
      message: 'Unable to logout'
    });
  }
});

// @route   GET /api/auth/profile
// @desc    Get current user profile
// @access  Private
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password -refreshToken');
    
    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error('Profile fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch profile',
      message: 'Unable to retrieve user data'
    });
  }
});

// @route   PUT /api/auth/profile
// @desc    Update user profile
// @access  Private
router.put('/profile',
  authenticateToken,
  [
    body('firstName').optional().trim().escape(),
    body('lastName').optional().trim().escape(),
    body('phone').optional().matches(/^[0-9]{10}$/),
    body('address.street').optional().trim().escape(),
    body('address.city').optional().trim().escape(),
    body('address.state').optional().trim().escape(),
    body('address.pincode').optional().matches(/^[0-9]{6}$/),
    body('preferences.theme').optional().isIn(['light', 'dark']),
    body('preferences.notifications').optional().isBoolean()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const updates = req.body;
      
      // Remove fields that shouldn't be updated through this route
      delete updates.email;
      delete updates.password;
      delete updates.role;
      delete updates.statusType;
      delete updates.isVerified;
      
      const user = await User.findByIdAndUpdate(
        req.userId,
        { $set: updates },
        { new: true, runValidators: true }
      ).select('-password -refreshToken');

      res.json({
        success: true,
        message: 'Profile updated successfully',
        user
      });
    } catch (error) {
      console.error('Profile update error:', error);
      res.status(500).json({
        error: 'Update failed',
        message: 'Unable to update profile'
      });
    }
  }
);

// @route   POST /api/auth/change-password
// @desc    Change user password
// @access  Private
router.post('/change-password',
  authenticateToken,
  [
    body('currentPassword').notEmpty(),
    body('newPassword').isLength({ min: 6 })
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      
      const user = await User.findById(req.userId).select('+password');
      
      // Verify current password
      const isPasswordValid = await user.comparePassword(currentPassword);
      
      if (!isPasswordValid) {
        return res.status(401).json({
          error: 'Password change failed',
          message: 'Current password is incorrect'
        });
      }

      // Update password
      user.password = newPassword;
      await user.save();

      res.json({
        success: true,
        message: 'Password changed successfully'
      });
    } catch (error) {
      console.error('Password change error:', error);
      res.status(500).json({
        error: 'Password change failed',
        message: 'Unable to change password'
      });
    }
  }
);

// @route   POST /api/auth/forgot-password
// @desc    Request password reset
// @access  Public
router.post('/forgot-password',
  authRateLimiter,
  [body('email').isEmail().normalizeEmail()],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { email } = req.body;
      
      const user = await User.findOne({ email });
      
      if (!user) {
        // Don't reveal if email exists
        return res.json({
          success: true,
          message: 'If the email exists, a reset link has been sent'
        });
      }

      // Generate reset token
      const resetToken = user.generatePasswordResetToken();
      await user.save();

      // TODO: Send email with reset token
      // For now, just return the token (remove in production)
      
      res.json({
        success: true,
        message: 'Password reset link sent to email',
        // Remove this in production
        resetToken: resetToken
      });
    } catch (error) {
      console.error('Forgot password error:', error);
      res.status(500).json({
        error: 'Request failed',
        message: 'Unable to process password reset request'
      });
    }
  }
);

// @route   POST /api/auth/reset-password
// @desc    Reset password with token
// @access  Public
router.post('/reset-password',
  [
    body('token').notEmpty(),
    body('newPassword').isLength({ min: 6 })
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      
      const hashedToken = require('crypto')
        .createHash('sha256')
        .update(token)
        .digest('hex');
      
      const user = await User.findOne({
        resetPasswordToken: hashedToken,
        resetPasswordExpires: { $gt: Date.now() }
      });
      
      if (!user) {
        return res.status(400).json({
          error: 'Reset failed',
          message: 'Invalid or expired reset token'
        });
      }

      // Update password
      user.password = newPassword;
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      await user.save();

      res.json({
        success: true,
        message: 'Password reset successful'
      });
    } catch (error) {
      console.error('Reset password error:', error);
      res.status(500).json({
        error: 'Reset failed',
        message: 'Unable to reset password'
      });
    }
  }
);

module.exports = router;
