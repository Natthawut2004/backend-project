const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const router = express.Router();

//  สมัครสมาชิก
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role = 'user' } = req.body;

    const hash = await bcrypt.hash(password, 10);

    const [result] = await pool.query(
      'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      [name, email, hash, role]
    );

    res.status(201).json({ message: 'Registered', id: result.insertId });
  } catch (err) {
    res.status(400).json({ message: 'Email already exists' });
  }
});

//  ล็อกอิน รับ token
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
  if (!rows.length) return res.status(404).json({ message: 'Email not found' });

  const user = rows[0];

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ message: 'Invalid password' });

  const token = jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET || 'mysecret',
    { expiresIn: '1d' }
  );

  await pool.query('INSERT INTO tokens (user_id, token) VALUES (?, ?)', [user.id, token]);

  res.json({ message: 'Logged in', token });
});

//  Logout
router.post('/logout', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer '))
    return res.status(401).json({ message: 'No token provided' });

  const token = auth.split(' ')[1];
  await pool.query('DELETE FROM tokens WHERE token = ?', [token]);

  res.json({ message: 'Logged out' });
});

module.exports = router;