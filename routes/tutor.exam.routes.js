const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// ─── Helper: สร้าง Session ID แบบสุ่ม 8 ตัว ──────────────────
function generateSessionId() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

// ══════════════════════════════════════════════════════════════
// GET /api/exam/status?courseId=X&subjectId=Y&adminId=Z
// ดึง status ของ pre/mid/post ทั้ง 3 ว่าใครเปิด/ปิดอยู่
// ══════════════════════════════════════════════════════════════
router.get('/status', async (req, res) => {
  const { courseId, subjectId, adminId } = req.query;

  if (!courseId || !subjectId || !adminId) {
    return res.status(400).json({ message: 'ต้องระบุ courseId, subjectId, adminId' });
  }

  try {
    // ดึง examtype ทั้งหมด
    const [types] = await pool.query(
      `SELECT ExamTypeId, ExamTypeName, Description FROM examtype WHERE Deleted_at IS NULL ORDER BY ExamTypeId ASC`
    );

    // ดึง exam sessions ของคอร์ส+วิชา+ติวเตอร์นี้
    const [sessions] = await pool.query(
      `SELECT e.ExamId, e.ExamTypeId, e.Status, e.ExamLink, e.ExamDate, e.Created_at
       FROM exam e
       WHERE e.CourseID = ? AND e.UserId = ?
         AND e.Deleted_at IS NULL
       ORDER BY e.Created_at DESC`,
      [courseId, adminId]
    );

    // map ผลลัพธ์: แต่ละ type จะรู้ว่า status เป็นอะไร
    const result = types.map(type => {
      const session = sessions.find(s => s.ExamTypeId === type.ExamTypeId);
      return {
        examTypeId: type.ExamTypeId,
        name: type.ExamTypeName,
        description: type.Description,
        status: session ? session.Status : 'inactive', // inactive | active | closed
        examId: session ? session.ExamId : null,
        sessionId: session && session.Status === 'active' ? session.ExamLink : null,
        openedAt: session ? session.ExamDate : null,
      };
    });

    res.json(result);
  } catch (e) {
    console.error('[exam status error]:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/exam/open
// ติวเตอร์เปิดสอบ — สร้าง session ใหม่
// Body: { courseId, subjectId, adminId, examTypeId }
// ══════════════════════════════════════════════════════════════
router.post('/open', async (req, res) => {
  const { courseId, subjectId, adminId, examTypeId } = req.body;

  if (!courseId || !adminId || !examTypeId) {
    return res.status(400).json({ message: 'ต้องระบุ courseId, adminId, examTypeId' });
  }

  try {
    // ตรวจว่ามี exam ที่ยัง active อยู่ไหม (ป้องกันเปิดซ้ำ)
    const [existing] = await pool.query(
      `SELECT ExamId FROM exam
       WHERE CourseID = ? AND UserId = ? AND ExamTypeId = ?
         AND Status = 'active' AND Deleted_at IS NULL`,
      [courseId, adminId, examTypeId]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        message: 'มีการสอบประเภทนี้ที่เปิดอยู่แล้ว',
        examId: existing[0].ExamId,
      });
    }

    // ตรวจว่าเคยปิดไปแล้วหรือยัง (closed) — ถ้าปิดแล้วไม่ให้เปิดอีก
    const [closed] = await pool.query(
      `SELECT ExamId FROM exam
       WHERE CourseID = ? AND UserId = ? AND ExamTypeId = ?
         AND Status = 'closed' AND Deleted_at IS NULL`,
      [courseId, adminId, examTypeId]
    );

    if (closed.length > 0) {
      return res.status(409).json({ message: 'การสอบประเภทนี้ถูกปิดไปแล้ว ไม่สามารถเปิดซ้ำได้' });
    }

    const sessionId = generateSessionId();

    // TestId ใช้ 0 เป็น placeholder ก่อน (ยังไม่มีระบบข้อสอบ)
    const [result] = await pool.query(
      `INSERT INTO exam (ExamLink, ExamDate, CourseID, TestId, UserId, ExamTypeId, Status, Created_at)
       VALUES (?, CURDATE(), ?, 0, ?, ?, 'active', NOW())`,
      [sessionId, courseId, adminId, examTypeId]
    );

    res.status(201).json({
      examId: result.insertId,
      sessionId,
      message: 'เปิดสอบสำเร็จ',
    });
  } catch (e) {
    console.error('[exam open error]:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════
// PUT /api/exam/close/:examId
// ติวเตอร์ปิดสอบ
// ══════════════════════════════════════════════════════════════
router.put('/close/:examId', async (req, res) => {
  const examId = Number(req.params.examId);

  if (isNaN(examId)) {
    return res.status(400).json({ message: 'examId ไม่ถูกต้อง' });
  }

  try {
    const [check] = await pool.query(
      `SELECT ExamId, Status FROM exam WHERE ExamId = ? AND Deleted_at IS NULL`,
      [examId]
    );

    if (!check.length) {
      return res.status(404).json({ message: 'ไม่พบการสอบนี้' });
    }

    if (check[0].Status === 'closed') {
      return res.status(409).json({ message: 'ปิดสอบไปแล้ว' });
    }

    await pool.query(
      `UPDATE exam SET Status = 'closed', Updated_at = NOW() WHERE ExamId = ?`,
      [examId]
    );

    res.json({ message: 'ปิดสอบสำเร็จ' });
  } catch (e) {
    console.error('[exam close error]:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/exam/join/:sessionId
// นักเรียนเข้าหน้าสอบด้วย sessionId — ตรวจว่า session ยังเปิดอยู่
// ══════════════════════════════════════════════════════════════
router.get('/join/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  try {
    const [rows] = await pool.query(
      `SELECT
         e.ExamId,
         e.Status,
         e.CourseID,
         et.ExamTypeName,
         et.Description,
         c.CourseName
       FROM exam e
       JOIN examtype et ON e.ExamTypeId = et.ExamTypeId
       JOIN courses c ON e.CourseID = c.CourseID
       WHERE e.ExamLink = ? AND e.Deleted_at IS NULL`,
      [sessionId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'ไม่พบห้องสอบนี้' });
    }

    const exam = rows[0];

    if (exam.Status !== 'active') {
      return res.status(403).json({ message: 'ห้องสอบนี้ปิดแล้ว ไม่สามารถเข้าได้' });
    }

    res.json({
      examId: exam.ExamId,
      courseName: exam.CourseName,
      examTypeName: exam.ExamTypeName,
      description: exam.Description,
      status: exam.Status,
    });
  } catch (e) {
    console.error('[exam join check error]:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/exam/join/:examId
// นักเรียนกด "เข้าสอบ" — บันทึกว่า join แล้ว
// Body: { userId }  (userId ของนักเรียน)
// ══════════════════════════════════════════════════════════════
router.post('/join/:examId', async (req, res) => {
  const examId = Number(req.params.examId);
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ message: 'ต้องระบุ userId' });
  }

  try {
    // ตรวจว่า exam ยังเปิดอยู่
    const [examRows] = await pool.query(
      `SELECT ExamId, Status, CourseID FROM exam WHERE ExamId = ? AND Deleted_at IS NULL`,
      [examId]
    );

    if (!examRows.length) {
      return res.status(404).json({ message: 'ไม่พบการสอบนี้' });
    }

    if (examRows[0].Status !== 'active') {
      return res.status(403).json({ message: 'ห้องสอบปิดแล้ว' });
    }

    // ตรวจว่าลงทะเบียนคอร์สนี้อยู่จริง
    const [enrollCheck] = await pool.query(
      `SELECT EnrollId FROM enroll WHERE UserId = ? AND CourseID = ? AND Deleted_at IS NULL`,
      [userId, examRows[0].CourseID]
    );

    if (!enrollCheck.length) {
      return res.status(403).json({ message: 'คุณไม่ได้ลงทะเบียนคอร์สนี้' });
    }

    // ตรวจว่า join ไปแล้วหรือยัง (ป้องกัน join ซ้ำ)
    const [alreadyJoined] = await pool.query(
      `SELECT ExamId FROM exam_join
       WHERE ExamId = ? AND UserId = ?`,
      [examId, userId]
    );

    if (alreadyJoined.length > 0) {
      return res.json({ message: 'เข้าสอบแล้ว', alreadyJoined: true });
    }

    // บันทึก join
    await pool.query(
      `INSERT INTO exam_join (ExamId, UserId, JoinedAt) VALUES (?, ?, NOW())`,
      [examId, userId]
    );

    res.status(201).json({ message: 'เข้าสอบสำเร็จ' });
  } catch (e) {
    console.error('[exam join error]:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/exam/:examId/students
// ติวเตอร์ดูว่านักเรียนคนไหน join แล้วบ้าง (polling)
// ══════════════════════════════════════════════════════════════
router.get('/:examId/students', async (req, res) => {
  const examId = Number(req.params.examId);

  try {
    // ดึงนักเรียนทั้งหมดที่ enroll คอร์สนี้
    const [examRow] = await pool.query(
      `SELECT CourseID FROM exam WHERE ExamId = ? AND Deleted_at IS NULL`,
      [examId]
    );

    if (!examRow.length) {
      return res.status(404).json({ message: 'ไม่พบการสอบนี้' });
    }

    const courseId = examRow[0].CourseID;

    const [students] = await pool.query(
      `SELECT
         u.UserId,
         CONCAT(u.Firstname, ' ', u.Lastname) AS name,
         u.Nickname,
         ej.JoinedAt
       FROM enroll e
       JOIN users u ON e.UserId = u.UserId
       LEFT JOIN exam_join ej ON ej.ExamId = ? AND ej.UserId = u.UserId
       WHERE e.CourseID = ? AND e.Deleted_at IS NULL
       ORDER BY u.Firstname ASC`,
      [examId, courseId]
    );

    const result = students.map(s => ({
      id: s.UserId,
      name: `${s.name}${s.Nickname ? ` (${s.Nickname})` : ''}`,
      status: s.JoinedAt ? 'joined' : 'not-joined',
      joinedAt: s.JoinedAt
        ? new Date(s.JoinedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
        : null,
    }));

    res.json({
      total: result.length,
      joinedCount: result.filter(s => s.status === 'joined').length,
      students: result,
    });
  } catch (e) {
    console.error('[exam students error]:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;