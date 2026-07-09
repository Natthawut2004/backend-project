// routes/student.courses.routes.js
// Route สำหรับฝั่งนักเรียน/หน้าเว็บทั่วไป (public-facing)
// แยกออกมาจาก courses.routes.js (ฝั่ง admin) เพื่อไม่ให้ logic ปนกัน
const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// GET /courses — รายการคอร์สทั้งหมด (รองรับ filter term/status/availability)
router.get('/', async (req, res) => {
  try {
    const { termId, statusId, availabilityId } = req.query;
    const where = [];
    const params = [];

    if (termId) { where.push('Term_Id = ?'); params.push(Number(termId)); }
    if (statusId) { where.push('Status_Course_Id = ?'); params.push(Number(statusId)); }
    if (availabilityId) { where.push('Course_Availability_Id = ?'); params.push(Number(availabilityId)); }

    const sql = `
      SELECT
        CourseID, CourseName, CourseImage,
        StartDate, LastDate, Remark,
        Price, Discount, FullCost, Installments, VideosFree,
        Status_Course_Id, Course_Availability_Id, Term_Id,
        (SELECT COUNT(*) FROM enroll WHERE enroll.CourseID = courses.CourseID) AS StudentCount
      FROM courses
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CourseID DESC
    `;
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('Error in GET /courses (student):', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /courses/:id — ข้อมูลคอร์สเดี่ยว (สำหรับหน้ารายละเอียดคอร์ส)
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid Course ID' });
    }

    const [rows] = await pool.query(
      `SELECT
         c.CourseID, c.CourseName, c.CourseImage,
         c.StartDate, c.LastDate, c.Remark,
         c.Price, c.Discount, c.FullCost, c.Installments, c.VideosFree,
         c.Status_Course_Id, c.Course_Availability_Id, c.Term_Id,
         (SELECT COUNT(*) FROM enroll e WHERE e.CourseID = c.CourseID) AS StudentCount
       FROM courses c
       WHERE c.CourseID = ?`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'ไม่พบคอร์สที่ระบุ' });
    }

    res.json(rows[0]);
  } catch (e) {
    console.error('Error in GET /courses/:id (student):', e);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;