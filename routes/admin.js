const express = require('express');
const bcrypt = require('bcrypt');
const User = require('../models/User');
const { authorize } = require('../middleware/authMiddleware');

const router = express.Router();

/* ==========================================================
   RESEARCH REPOSITORY ROLE-BASED ACCESS
========================================================== */

/* ---------- Student Access ---------- */
router.get('/student', authorize(['student', 'faculty', 'staff', 'admin']), (req, res) => {
  res.json({ message: `Welcome ${req.user.email}! You can upload and track your research submissions.` });
});

/* ---------- Faculty (Adviser) Access ---------- */
router.get('/faculty', authorize(['faculty', 'admin']), (req, res) => {
  res.json({ message: `Welcome, ${req.user.email}! You can review and approve student research papers.` });
});

/* ---------- Staff Access ---------- */
router.get('/staff', authorize(['staff', 'faculty', 'admin']), (req, res) => {
  res.json({ message: `Hi ${req.user.email}, repository management tools unlocked.` });
});

/* ---------- Public Access ---------- */
router.get('/public', (req, res) => {
  res.json({ message: 'Welcome to the Research Repository! Public research papers are viewable here.' });
});

/* ==========================================================
   ADMIN MANAGEMENT — USER CONTROL
========================================================== */

// View all users
router.get('/users', authorize('admin'), async (req, res) => {
  try {
    const users = await User.find().select('-pinHash -verificationCode');
    res.json(users);
  } catch (err) {
    console.error('❌ Fetch users failed:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Create new users (student, faculty, staff)
router.post('/create-user', authorize('admin'), async (req, res) => {
  try {
    const { firstName, lastName, email, pin, role, college } = req.body;
    if (!firstName || !lastName || !email || !pin || !role)
      return res.status(400).json({ error: 'All fields are required' });

    const validRoles = ['student', 'faculty', 'staff'];
    if (!validRoles.includes(role))
      return res.status(403).json({ error: 'Invalid role for creation' });

    const existing = await User.findOne({ email });
    if (existing)
      return res.status(409).json({ error: 'Email already exists' });

    const pinHash = await bcrypt.hash(pin, 10);

    const user = await User.create({
      firstName,
      lastName,
      email,
      pinHash,
      role,
      college: college || '',
      verified: true,
    });

    res.status(201).json({ message: `${role} account created successfully`, user });
  } catch (err) {
    console.error('❌ Create user error:', err);
    res.status(500).json({ error: 'Server error creating user' });
  }
});

// Update user role (admin only)
router.put('/users/:id/role', authorize('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!role) return res.status(400).json({ error: 'Role required' });

    const validRoles = ['student', 'staff', 'faculty', 'admin'];
    if (!validRoles.includes(role))
      return res.status(400).json({ error: 'Invalid role' });

    const updatedUser = await User.findByIdAndUpdate(id, { role }, { new: true });
    if (!updatedUser) return res.status(404).json({ error: 'User not found' });

    res.json({ message: 'Role updated successfully', user: updatedUser });
  } catch (err) {
    console.error('❌ Update role failed:', err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// Delete user (admin only)
router.delete('/users/:id', authorize('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const deletedUser = await User.findByIdAndDelete(id);
    if (!deletedUser) return res.status(404).json({ error: 'User not found' });

    res.json({ message: 'User deleted successfully', user: deletedUser });
  } catch (err) {
    console.error('❌ Delete user failed:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
