// routes/courses.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
// const { authRequired, requireRole } = require('../middlewares/auth');

// GET /courses  (ดึงทั้งหมด)
router.get('/', async (req, res) => {
  try {
    const { termId, statusId, availabilityId } = req.query;

    const where = [];
    const params = [];

    if (termId) {
      where.push('Term_Id = ?');
      params.push(Number(termId));
    }
    if (statusId) {
      where.push('Status_Course_Id = ?');
      params.push(Number(statusId));
    }
    if (availabilityId) {
      where.push('Course_Availability_Id = ?');
      params.push(Number(availabilityId));
    }

    const sql = `
      SELECT
        CourseID, CourseName, CourseImage,
        StartDate, LastDate, Remark,
        Price, Discount, FullCost, Installments, VideosFree,
        Created_at, Updated_at, Deleted_at,
        Status_Course_Id, Course_Availability_Id, Term_Id
      FROM courses
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CourseID DESC
    `;

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /courses/:id (ดึงรายการเดียว)
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query(
      `
      SELECT
        CourseID, CourseName, CourseImage,
        StartDate, LastDate, Remark,
        Price, Discount, FullCost, Installments, VideosFree,
        Created_at, Updated_at, Deleted_at,
        Status_Course_Id, Course_Availability_Id, Term_Id
      FROM courses
      WHERE CourseID = ?
      `,
      [id]
    );

    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /courses (สร้างคอร์สใหม่)
// body: CourseName (required)
// optional: StartDate, LastDate, Remark, Price, Discount, FullCost,
//          Installments, VideosFree, Status_Course_Id, Course_Availability_Id, Term_Id
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};

    if (!b.CourseName) {
      return res.status(400).json({ message: 'CourseName is required' });
    }

    const payload = {
      CourseName: b.CourseName,
      StartDate: b.StartDate ?? null,
      LastDate: b.LastDate ?? null,
      Remark: b.Remark ?? null,
      Price: b.Price != null ? Number(b.Price) : null,
      Discount: b.Discount != null ? Number(b.Discount) : null,
      FullCost: b.FullCost != null ? Number(b.FullCost) : null,
      Installments: b.Installments != null ? Number(b.Installments) : null,
      VideosFree: b.VideosFree != null ? Number(b.VideosFree) : null,
      Status_Course_Id: b.Status_Course_Id != null ? Number(b.Status_Course_Id) : null,
      Course_Availability_Id: b.Course_Availability_Id != null ? Number(b.Course_Availability_Id) : null,
      Term_Id: b.Term_Id != null ? Number(b.Term_Id) : null,
    };

    const [result] = await pool.query(
      `
      INSERT INTO courses (
        CourseName, StartDate, LastDate, Remark,
        Price, Discount, FullCost, Installments, VideosFree,
        Created_at, Updated_at, Deleted_at,
        Status_Course_Id, Course_Availability_Id, Term_Id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NULL, NULL, ?, ?, ?)
      `,
      [
        payload.CourseName,
        payload.StartDate,
        payload.LastDate,
        payload.Remark,
        payload.Price,
        payload.Discount,
        payload.FullCost,
        payload.Installments,
        payload.VideosFree,
        payload.Status_Course_Id,
        payload.Course_Availability_Id,
        payload.Term_Id,
      ]
    );

    res.status(201).json({
      CourseID: result.insertId,
      ...payload,
    });
  } catch (e) {
    console.error(e);

    if (String(e.message || '').includes('foreign key constraint fails')) {
      return res.status(400).json({
        message: 'Foreign key constraint fails: ตรวจสอบ Status_Course_Id / Course_Availability_Id / Term_Id ว่ามีอยู่จริงในตารางแม่',
        error: e.message,
      });
    }

    res.status(500).json({ message: e.message || 'Server error' });
  }
});

// PUT /courses/:id (อัปเดตคอร์ส)
router.put('/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);

    // เช็คมีคอร์สไหม
    const [oldRows] = await conn.query(
      'SELECT CourseID FROM courses WHERE CourseID = ?',
      [id]
    );
    if (!oldRows.length) return res.status(404).json({ message: 'Not found' });

    const b = req.body || {};

    // ใช้ COALESCE ทำให้ส่งมาเฉพาะบางฟิลด์ได้
    const [result] = await conn.query(
      `
      UPDATE courses SET
        CourseName = COALESCE(?, CourseName),
        StartDate = COALESCE(?, StartDate),
        LastDate = COALESCE(?, LastDate),
        Remark = COALESCE(?, Remark),
        Price = COALESCE(?, Price),
        Discount = COALESCE(?, Discount),
        FullCost = COALESCE(?, FullCost),
        Installments = COALESCE(?, Installments),
        VideosFree = COALESCE(?, VideosFree),
        Status_Course_Id = COALESCE(?, Status_Course_Id),
        Course_Availability_Id = COALESCE(?, Course_Availability_Id),
        Term_Id = COALESCE(?, Term_Id),
        Updated_at = NOW()
      WHERE CourseID = ?
      `,
      [
        b.CourseName ?? null,
        b.StartDate ?? null,
        b.LastDate ?? null,
        b.Remark ?? null,
        b.Price != null ? Number(b.Price) : null,
        b.Discount != null ? Number(b.Discount) : null,
        b.FullCost != null ? Number(b.FullCost) : null,
        b.Installments != null ? Number(b.Installments) : null,
        b.VideosFree != null ? Number(b.VideosFree) : null,
        b.Status_Course_Id != null ? Number(b.Status_Course_Id) : null,
        b.Course_Availability_Id != null ? Number(b.Course_Availability_Id) : null,
        b.Term_Id != null ? Number(b.Term_Id) : null,
        id,
      ]
    );

    if (!result.affectedRows) return res.status(400).json({ message: 'No change' });
    res.json({ message: 'Updated' });
  } catch (e) {
    console.error(e);
    if (String(e.message || '').includes('foreign key constraint fails')) {
      return res.status(400).json({
        message: 'Foreign key constraint fails: ตรวจสอบ Status_Course_Id / Course_Availability_Id / Term_Id ว่ามีอยู่จริงในตารางแม่',
        error: e.message,
      });
    }
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
});

// DELETE /courses/:id (ลบคอร์ส)
// หมายเหตุ: ถ้ามีตารางลูกผูกอยู่ (enroll/courseDetails/...) จะลบไม่ได้ ต้องลบลูกก่อน
router.delete('/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);

    const [rows] = await conn.query('SELECT CourseID FROM courses WHERE CourseID = ?', [id]);
    if (!rows.length) return res.status(404).json({ message: 'Not found' });

    const [result] = await conn.query('DELETE FROM courses WHERE CourseID = ?', [id]);
    if (!result.affectedRows) return res.status(400).json({ message: 'Delete failed' });

    res.json({ message: 'Deleted' });
  } catch (e) {
    console.error(e);

    // ลบไม่ได้เพราะมี FK จากตารางลูก
    if (String(e.message || '').includes('foreign key constraint fails')) {
      return res.status(409).json({
        message: 'Delete blocked by foreign key: มีตารางอื่นอ้างถึงคอร์สนี้ (เช่น enroll/courseDetails/...) ต้องลบข้อมูลลูกก่อน',
        error: e.message,
      });
    }

    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
});

module.exports = router;
