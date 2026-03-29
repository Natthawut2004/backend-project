const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const multer = require('multer');
const path = require('path');

//const NOW = () => new Date('2026-03-27'); // mock วันศุกร์
const NOW = () => new Date(); // ของจริง — ใช้วันที่ปัจจุบัน

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, 'teaching_' + Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Phase 1 — บันทึกต้นคาบ (รูปเริ่ม + เช็กชื่อ)
router.post('/record-teaching/start', upload.single('photoStart'), async (req, res) => {
  const { adminId, courseScheduleDetailId, remark, attendanceData } = req.body;

  console.log('body:', req.body)
  console.log('file:', req.file)

  const [existing] = await pool.query(
    'SELECT TutorCheckinId FROM tutorcheckin WHERE AdminId = ? AND CourseScheduleDetailId = ? AND DATE(Created_at) = DATE(?)',
    [adminId, courseScheduleDetailId, NOW()]
  );
  if (existing.length) return res.status(409).json({ message: 'บันทึกคาบนี้ไปแล้ว' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const photoStartPath = req.file ? `/uploads/${req.file.filename}` : null;

    const [result] = await conn.query(
      `INSERT INTO tutorcheckin (AdminId, CourseScheduleDetailId, PhotoStart, Remark, Created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [adminId, courseScheduleDetailId, photoStartPath, remark, NOW()]
    );

    if (attendanceData) {
      const students = JSON.parse(attendanceData);
      for (const s of students) {
        await conn.query(
          `INSERT INTO studentattendance (UserId, CourseScheduleDetailId, Status, Created_at)
           VALUES (?, ?, ?, ?)`,
          [s.userId, courseScheduleDetailId, s.status, NOW()]
        );
      }
    }

    await conn.commit();
    res.json({ recordId: result.insertId });
  } catch (e) {
    console.error('DB error:', e)
    await conn.rollback();
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  } finally {
    conn.release();
  }
});

// Phase 2 — ปิดคาบ (รูปจบ)
router.put('/record-teaching/:id/end', upload.single('photoEnd'), async (req, res) => {
  const recordId = Number(req.params.id);
  const photoEndPath = req.file ? `/uploads/${req.file.filename}` : null;

  if (!photoEndPath) return res.status(400).json({ message: 'ไม่พบรูปท้ายคาบ' });

  try {
    const [result] = await pool.query(
      `UPDATE tutorcheckin SET PhotoEnd = ?, Updated_at = NOW() WHERE TutorCheckinId = ?`,
      [photoEndPath, recordId]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'ไม่พบข้อมูลการบันทึก' });
    res.json({ message: 'ปิดคาบสำเร็จ' });
  } catch (e) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// PUT /api/tutor/:id
router.put('/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const [check] = await conn.query('SELECT AdminId FROM admin WHERE AdminId = ?', [id]);
    if (!check.length) return res.status(404).json({ message: 'Tutor not found' });

    const updates = {
      Firstname: b.firstname, Lastname: b.lastname, Nickname: b.nickname,
      PhoneNo: b.phone, LineID: b.lineId, BirthOfDate: b.birthDate || null,
      Occupation: b.occupation, EmergencyContactName: b.emergencyName,
      EmergencyContactPhoneNo: b.emergencyPhone,

      BankName: b.bankName,
      BankAccountNumber: b.bankAccount,
      BankAccountName: b.bankAccountName
    };

    const setClauses = [];
    const params = [];

    for (const [column, value] of Object.entries(updates)) {
      if (value !== undefined) {
        setClauses.push(`${column} = ?`);
        params.push(value);
      }
    }

    if (setClauses.length === 0) return res.status(400).json({ message: 'No data to update' });

    setClauses.push('Updated_at = NOW()');
    params.push(id);

    const [result] = await conn.query(
      `UPDATE admin SET ${setClauses.join(', ')} WHERE AdminId = ?`,
      params
    );
    if (result.affectedRows === 0) return res.status(400).json({ message: 'Update failed' });

    res.json({ message: 'Updated successfully', updatedFields: Object.keys(updates).filter(k => updates[k] !== undefined) });
  } catch (e) {
    console.error('Error updating tutor:', e);
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
});

// GET /api/tutor/:id
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);

    const [rows] = await pool.query(
      `SELECT 
        a.*,
        -- คำนวณปีประสบการณ์: ถ้าปีปัจจุบันลบปีที่เริ่มงานได้ 0 ให้โชว์ 1
        GREATEST(YEAR(CURDATE()) - YEAR(a.Created_at), 1) as ExperienceYear,
        -- นับจำนวนนักเรียนที่ไม่ซ้ำจากทุก Course ที่ Tutor คนนี้สอน
        (SELECT COUNT(DISTINCT e.UserId) 
         FROM tutorcoursedetails tcd 
         JOIN enroll e ON tcd.CourseID = e.CourseID 
         WHERE tcd.AdminId = a.AdminId) as StudentCount,
        -- ดึงรายชื่อวิชา
        (SELECT GROUP_CONCAT(DISTINCT s.SubjectName SEPARATOR ', ')
         FROM tutorcoursedetails tcd
         JOIN subjects s ON tcd.SubjectId = s.SubjectId
         WHERE tcd.AdminId = a.AdminId) as Subjects
       FROM admin a
       WHERE a.AdminId = ? AND a.Deleted_at IS NULL`,
      [id]
    );

    if (!rows.length) return res.status(404).json({ message: 'Tutor not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('Error fetching tutor:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id/schedule', async (req, res) => {
  try {
    const tutorId = Number(req.params.id);
    const [rows] = await pool.query(
      `SELECT 
        csd.CourseScheduleDetailId,
        c.CourseID,
        c.CourseName,
        s.SubjectName,
        r.RoomDetail,
        cs.DayOfWeek as DayIndex,
        TIME_FORMAT(cs.StartTime, '%H:%i') as StartTime,
        TIME_FORMAT(cs.EndTime, '%H:%i') as EndTime,
        (SELECT COUNT(*) FROM enroll WHERE CourseID = c.CourseID) as EnrolledStudents,
        
        tc.TutorCheckinId as recordId,
        CASE 
          WHEN tc.PhotoEnd IS NOT NULL THEN 'completed'
          WHEN tc.TutorCheckinId IS NOT NULL THEN 'phase1_done'
          ELSE NULL
        END as recordPhase
        
       FROM coursescheduledetails csd
       JOIN courseschedule cs ON csd.CourseScheduleId = cs.CourseScheduleId
       JOIN courses c ON csd.CourseID = c.CourseID
       LEFT JOIN subjects s ON csd.SubjectId = s.SubjectId
       LEFT JOIN rooms r ON csd.RoomId = r.RoomId
       
       LEFT JOIN tutorcheckin tc 
         ON tc.CourseScheduleDetailId = csd.CourseScheduleDetailId
         AND tc.AdminId = ?
         AND DATE(tc.Created_at) = CURDATE()
         
       WHERE csd.AdminId = ? 
        AND cs.DayOfWeek IS NOT NULL
        AND c.Status_Course_Id NOT IN (3, 4)
        AND c.LastDate >= CURDATE()
        AND c.StartDate <= CURDATE()`,
      [tutorId, tutorId]  // ส่ง tutorId 2 ครั้ง
    );

    const dayNames = { 1: 'อาทิตย์', 2: 'จันทร์', 3: 'อังคาร', 4: 'พุธ', 5: 'พฤหัสบดี', 6: 'ศุกร์', 7: 'เสาร์' };

    const scheduleData = rows.map(row => ({
      courseScheduleDetailId: row.CourseScheduleDetailId,
      courseId: row.CourseID,
      day: dayNames[row.DayIndex],
      time: `${row.StartTime}-${row.EndTime}`,
      subject: row.SubjectName ? `${row.CourseName} (${row.SubjectName})` : row.CourseName,
      room: row.RoomDetail || 'ไม่ระบุห้อง',
      students: row.EnrolledStudents,
      maxStudents: 30,
      recordId: row.recordId || null, 
      recordPhase: row.recordPhase || null, 
    }));

    res.json(scheduleData);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST อัปโหลดรูป
router.post('/:id/upload-profile', upload.single('profileImage'), async (req, res) => {
  const fileName = req.file ? `/uploads/${req.file.filename}` : null;
  await pool.query('UPDATE admin SET Photo = ? WHERE AdminId = ?', [fileName, req.params.id]);
  res.json({ imageUrl: fileName });
});

// DELETE ลบรูป
router.delete('/:id/delete-profile', async (req, res) => {
  await pool.query('UPDATE admin SET Photo = NULL WHERE AdminId = ?', [req.params.id]);
  res.json({ message: 'Deleted' });
});

module.exports = router;