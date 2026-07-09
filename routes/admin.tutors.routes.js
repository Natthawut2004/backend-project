const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
// const multer = require('multer');
// const path = require('path');

// const storage = multer.diskStorage({
//   destination: (req, file, cb) => cb(null, 'uploads/'),
//   filename: (req, file, cb) => cb(null, 'tutor_' + Date.now() + path.extname(file.originalname))
// });
// const upload = multer({ storage });

const { uploadImage } = require('../middlewares/upload');

async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

const valDate = v => {
  if (!v || v.trim() === '') return null;
  return v.slice(0, 10); // ตัดเอาแค่ "YYYY-MM-DD" ทิ้ง timezone ทิ้ง
};

// ─── GET /api/admin/tutors ────────────────────────────────────────────────────
// ดึงติวเตอร์ทั้งหมด (RoleId = 2) พร้อมนับนักเรียนและวิชา
router.get('/tutors', async (req, res) => {
  try {
    const sql = `
      SELECT
        a.AdminId, a.Firstname, a.Lastname, a.Nickname,
        a.PhoneNo, a.Occupation, a.BirthOfDate, a.LineID,
        a.Photo, a.RatePerTutors, a.Created_at, a.Updated_at,
        a.Status_Tutor_Id, a.BankName, a.BankAccountNumber, a.BankAccountName,
        a.EmergencyContactName, a.EmergencyContactPhoneNo,
        r.RoleName,
        GREATEST(YEAR(CURDATE()) - YEAR(a.Created_at), 1) AS ExperienceYear,
        (
          SELECT COUNT(DISTINCT e.UserId)
          FROM tutorcoursedetails tcd
          JOIN enroll e ON tcd.CourseID = e.CourseID
          WHERE tcd.AdminId = a.AdminId
        ) AS StudentCount,
        (
          SELECT GROUP_CONCAT(DISTINCT s.SubjectName ORDER BY s.SubjectName SEPARATOR ', ')
          FROM tutorcoursedetails tcd
          JOIN subjects s ON tcd.SubjectId = s.SubjectId
          WHERE tcd.AdminId = a.AdminId
        ) AS Subjects,
        (
          SELECT COUNT(*)
          FROM tutorcheckin tc
          WHERE tc.AdminId = a.AdminId AND tc.Deleted_at IS NULL
        ) AS TotalSessions
      FROM admin a
      LEFT JOIN role r ON r.RoleId = a.RoleId
      WHERE a.RoleId = 2 AND a.Deleted_at IS NULL
      ORDER BY a.AdminId DESC
    `;
    const rows = await q(sql);
    res.json(rows);
  } catch (err) {
    console.error('[GET /tutors]', err);
    res.status(500).json({ message: 'ดึงข้อมูลติวเตอร์ไม่สำเร็จ', error: err.message });
  }
});

// ─── GET /api/admin/tutors/attendance ──────────────────────────────────────────
// ⚠️ route นี้ต้องอยู่ใน tutors.js (admin router) ไม่ใช่ tutor.js
// เพราะ frontend เรียก /api/admin/tutors/attendance
router.get('/tutors/attendance', async (req, res) => {
  const { startDate, endDate } = req.query; // ไม่มี default แล้ว
  const hasDateFilter = startDate && endDate;

  try {
    const rows = await q(
      `SELECT
      a.AdminId, a.Nickname, a.Firstname, a.Lastname, a.RatePerTutors AS RatePerHour,
      COUNT(DISTINCT csd.CourseScheduleDetailId)  AS TotalScheduled,
      COUNT(DISTINCT tc.TutorCheckinId)           AS TotalCheckin,
      COUNT(DISTINCT CASE
        WHEN tc.TutorCheckinId IS NOT NULL AND tc.TutorPaymentId IS NULL
        THEN tc.TutorCheckinId END)               AS UnpaidCheckin,
      COUNT(DISTINCT CASE
        WHEN tc.TutorPaymentId IS NOT NULL
        THEN tc.TutorCheckinId END)               AS PaidCheckin
    FROM admin a
    LEFT JOIN coursescheduledetails csd ON csd.AdminId = a.AdminId
    LEFT JOIN courseschedule cs
      ON cs.CourseScheduleId = csd.CourseScheduleId
      AND cs.Deleted_at IS NULL
      AND cs.StartDateTime <= NOW()
      ${hasDateFilter ? 'AND DATE(cs.StartDateTime) BETWEEN ? AND ?' : ''}
    LEFT JOIN tutorcheckin tc
      ON tc.CourseScheduleDetailId = csd.CourseScheduleDetailId
      AND tc.AdminId = a.AdminId
      AND tc.Deleted_at IS NULL
    WHERE a.RoleId = 2 AND a.Deleted_at IS NULL
    GROUP BY a.AdminId, a.Nickname, a.Firstname, a.Lastname
    HAVING TotalScheduled > 0
    ORDER BY TotalScheduled DESC`,
      hasDateFilter ? [startDate, endDate] : []
    );

    const data = rows.map(r => ({
      ...r,
      AttendanceRate: r.TotalScheduled > 0
        ? Math.round((r.TotalCheckin / r.TotalScheduled) * 100)
        : null,
      // Fix 4: Math.max(0, ...) ป้องกันค่าติดลบในกรณี edge case
      MissedCount: Math.max(0, r.TotalScheduled - r.TotalCheckin),
    }));

    res.json({ startDate, endDate, tutors: data });
  } catch (err) {
    console.error('[GET /tutors/attendance]', err);
    res.status(500).json({ message: err.message });
  }
});

router.get('/tutors/:id/sessions', async (req, res) => {
  const { id } = req.params;
  const now = new Date();
  const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString().slice(0, 10);
  const defaultEnd = now.toISOString().slice(0, 10);
  const rawStart = req.query.startDate;
  const rawEnd = req.query.endDate;
  const startDate = (rawStart && rawStart.trim()) ? rawStart.trim() : defaultStart;
  const endDate = (rawEnd && rawEnd.trim()) ? rawEnd.trim() : defaultEnd;

  try {
    const sessions = await q(`
      SELECT
        tc.TutorCheckinId,
        tc.PhotoStart,
        tc.PhotoEnd,
        tc.Remark,
        tc.Created_at,
        tc.TutorPaymentId,
        a.AdminId,
        a.Nickname,
        a.Firstname,
        a.Lastname,
        c.CourseName,
        s.SubjectName,
        r.RoomDetail,
        csd.CourseScheduleDetailId,
        TIME_FORMAT(cs.StartTime, '%H:%i') AS StartTime,
        TIME_FORMAT(cs.EndTime,   '%H:%i') AS EndTime,
        DATE(cs.StartDateTime)             AS ClassDate,
        TIMESTAMPDIFF(MINUTE,
  ADDTIME('2000-01-01', cs.StartTime),
  ADDTIME('2000-01-01', cs.EndTime)
) AS PlannedMinutes
      FROM tutorcheckin tc
      JOIN admin a   ON a.AdminId = tc.AdminId
      JOIN coursescheduledetails csd
                     ON csd.CourseScheduleDetailId = tc.CourseScheduleDetailId
      JOIN courseschedule cs
                     ON cs.CourseScheduleId = csd.CourseScheduleId
      JOIN courses c ON c.CourseID = csd.CourseID
      LEFT JOIN subjects s ON s.SubjectId = csd.SubjectId
      LEFT JOIN rooms r    ON r.RoomId    = csd.RoomId
      WHERE tc.AdminId    = ?
        AND tc.Deleted_at IS NULL
        AND DATE(cs.StartDateTime) BETWEEN ? AND ?
      ORDER BY cs.StartDateTime DESC
    `, [id, startDate, endDate]);

    for (const session of sessions) {
      session.students = await q(`
        SELECT
          u.UserId,
          u.Nickname,
          u.Firstname,
          u.Lastname,
          sa.Status,
          sa.Reason
        FROM studentattendance sa
        JOIN users u ON u.UserId = sa.UserId
        WHERE sa.CourseScheduleDetailId = ?
          AND DATE(sa.Created_at)       = ?
          AND sa.Deleted_at IS NULL
        ORDER BY u.Firstname
      `, [session.CourseScheduleDetailId, session.ClassDate]);
    }

    res.json({ startDate, endDate, sessions });
  } catch (err) {
    console.error('[GET /tutors/:id/sessions]', err);
    res.status(500).json({ message: err.message });
  }
});

// ── helper: สร้างทุกสัปดาห์ในช่วงวันที่ ────────────────────────────────────
function getISOYearWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const wn = 1 + Math.round(
    ((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7
  );
  return d.getFullYear() * 100 + wn;
}

function generateAllWeeks(startStr, endStr) {
  const weeks = [];
  const end = new Date(endStr);
  const cur = new Date(startStr);
  // ถอยไปหาวันจันทร์ของสัปดาห์แรก
  const dow = cur.getDay();
  cur.setDate(cur.getDate() + (dow === 0 ? -6 : 1 - dow));

  let idx = 1;
  while (cur <= end) {
    const ws = cur.toISOString().slice(0, 10);
    const we = new Date(cur);
    we.setDate(we.getDate() + 6);
    weeks.push({
      YearWeek: getISOYearWeek(cur),
      WeekStart: ws,
      WeekEnd: we.toISOString().slice(0, 10),
      weekIndex: idx++,
    });
    cur.setDate(cur.getDate() + 7);
  }
  return weeks;
}

// ─── GET /api/admin/tutors/absence-heatmap ────────────────────────────────────
router.get('/tutors/absence-heatmap', async (req, res) => {
  const now = new Date();
  const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const defaultEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  const rangeStart = req.query.startDate || defaultStart;
  const rangeEnd = req.query.endDate || defaultEnd;

  try {
    // สร้างทุกสัปดาห์ก่อน (รวมสัปดาห์ที่ไม่มีการขาด)
    const allWeeks = generateAllWeeks(rangeStart, rangeEnd);

    const rows = await q(`
      SELECT
        a.AdminId, a.Nickname, a.Firstname, a.Lastname,
        YEARWEEK(cs.StartDateTime, 1)  AS YearWeek,
        DAYOFWEEK(cs.StartDateTime)    AS DayOfWeek,
        SUM(CASE WHEN tc.TutorCheckinId IS NULL THEN 1 ELSE 0 END) AS MissedSlots
      FROM coursescheduledetails csd
      JOIN courseschedule cs
        ON cs.CourseScheduleId = csd.CourseScheduleId
        AND cs.Deleted_at IS NULL
        AND cs.StartDateTime <= NOW()
        AND DATE(cs.StartDateTime) BETWEEN ? AND ?
      JOIN admin a
        ON a.AdminId = csd.AdminId
        AND a.RoleId = 2
        AND a.Deleted_at IS NULL
      LEFT JOIN tutorcheckin tc
        ON tc.CourseScheduleDetailId = csd.CourseScheduleDetailId
        AND tc.AdminId = csd.AdminId
        AND tc.Deleted_at IS NULL
      GROUP BY a.AdminId, a.Nickname, a.Firstname, a.Lastname, YearWeek, DayOfWeek
      HAVING MissedSlots > 0
    `, [rangeStart, rangeEnd]);

    // build tutor map
    const tutorMap = {};
    for (const row of rows) {
      if (!tutorMap[row.AdminId]) {
        tutorMap[row.AdminId] = {
          AdminId: row.AdminId, Nickname: row.Nickname,
          Firstname: row.Firstname, Lastname: row.Lastname,
          weeks: {}, totalMissed: 0,
        };
      }
      const t = tutorMap[row.AdminId];
      if (!t.weeks[row.YearWeek]) t.weeks[row.YearWeek] = {};
      t.weeks[row.YearWeek][row.DayOfWeek] = Number(row.MissedSlots);
      t.totalMissed += Number(row.MissedSlots);
    }

    // daySummary: รวมต่อวันในสัปดาห์ (2=จ ... 1=อา)
    const daySummary = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
    for (const t of Object.values(tutorMap)) {
      for (const days of Object.values(t.weeks)) {
        for (const [d, cnt] of Object.entries(days)) {
          daySummary[d] += cnt;
        }
      }
    }

    // weekSummary: รวมต่อสัปดาห์
    const weekSummary = {};
    for (const t of Object.values(tutorMap)) {
      for (const [yw, days] of Object.entries(t.weeks)) {
        weekSummary[yw] = (weekSummary[yw] || 0) +
          Object.values(days).reduce((s, v) => s + v, 0);
      }
    }

    res.json({
      weeks: allWeeks,
      tutors: Object.values(tutorMap).sort((a, b) => b.totalMissed - a.totalMissed),
      daySummary,
      weekSummary,
    });
  } catch (err) {
    console.error('[GET /tutors/absence-heatmap]', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/tutors/missed-session-detail ──────────────────────────────
// drill down: คาบที่ขาดของติวเตอร์คนนั้น ในสัปดาห์+วันที่เลือก
router.get('/tutors/missed-session-detail', async (req, res) => {
  const { adminId, weekStart, weekEnd, dayOfWeek } = req.query;
  if (!adminId || !weekStart || !weekEnd || !dayOfWeek)
    return res.status(400).json({ message: 'ขาด parameter' });

  try {
    const rows = await q(`
      SELECT
        a.Nickname, a.Firstname, a.Lastname,
        c.CourseName,
        s.SubjectName,
        DATE(cs.StartDateTime)             AS ClassDate,
        TIME_FORMAT(cs.StartTime, '%H:%i') AS StartTime,
        TIME_FORMAT(cs.EndTime,   '%H:%i') AS EndTime,
        r.RoomDetail
      FROM coursescheduledetails csd
      JOIN courseschedule cs
        ON cs.CourseScheduleId = csd.CourseScheduleId
        AND cs.Deleted_at IS NULL
        AND cs.StartDateTime <= NOW()
        AND DATE(cs.StartDateTime) BETWEEN ? AND ?
        AND DAYOFWEEK(cs.StartDateTime)    = ?
      JOIN admin a  ON a.AdminId = csd.AdminId AND a.AdminId = ?
      JOIN courses c ON c.CourseID = csd.CourseID
      LEFT JOIN subjects s ON s.SubjectId = csd.SubjectId
      LEFT JOIN rooms r    ON r.RoomId    = csd.RoomId
      LEFT JOIN tutorcheckin tc
        ON tc.CourseScheduleDetailId = csd.CourseScheduleDetailId
        AND tc.AdminId = csd.AdminId
        AND tc.Deleted_at IS NULL
      WHERE tc.TutorCheckinId IS NULL
      ORDER BY cs.StartDateTime ASC
    `, [weekStart, weekEnd, dayOfWeek, adminId]);

    res.json(rows);
  } catch (err) {
    console.error('[GET /tutors/missed-session-detail]', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/tutors/performance ───────────────────────────────────────
router.get('/tutors/performance', async (req, res) => {
  const now = new Date();
  const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString().slice(0, 10);
  const defaultEnd = now.toISOString().slice(0, 10);
  const startDate = req.query.startDate || defaultStart;
  const endDate = req.query.endDate || defaultEnd;

  try {
    const rows = await q(`
      SELECT
        a.AdminId,
        a.Nickname,
        a.Firstname,
        a.Lastname,
        a.Photo,
        a.RatePerTutors,

        -- A: อัตราเช็กอิน (0–100)
        ROUND(
          IFNULL(
            COUNT(DISTINCT tc.TutorCheckinId)
            / NULLIF(COUNT(DISTINCT csd.CourseScheduleDetailId), 0) * 100
          , 0)
        , 1) AS CheckinRate,

        -- B: ความสม่ำเสมอ (0–100) — stddev น้อย = สม่ำเสมอมาก
        GREATEST(0, ROUND(
          100 - IFNULL(
            STDDEV(weekly.cnt) / NULLIF(AVG(weekly.cnt), 0) * 100
          , 0)
        , 1)) AS ConsistencyScore,

        -- C: ชั่วโมงสอนสะสม (นาที) — เอาไป normalize ทีหลังใน Node
        IFNULL(
          SUM(DISTINCT TIMESTAMPDIFF(MINUTE,
            ADDTIME('2000-01-01', cs.StartTime),
            ADDTIME('2000-01-01', cs.EndTime)
          ))
        , 0) AS TotalMinutes,

        COUNT(DISTINCT tc.TutorCheckinId)          AS TotalCheckin,
        COUNT(DISTINCT csd.CourseScheduleDetailId) AS TotalScheduled

      FROM admin a
      LEFT JOIN coursescheduledetails csd ON csd.AdminId = a.AdminId
      LEFT JOIN courseschedule cs
        ON cs.CourseScheduleId = csd.CourseScheduleId
        AND cs.Deleted_at IS NULL
        AND cs.StartDateTime <= NOW()
        AND DATE(cs.StartDateTime) BETWEEN ? AND ?
      LEFT JOIN tutorcheckin tc
        ON tc.CourseScheduleDetailId = csd.CourseScheduleDetailId
        AND tc.AdminId = a.AdminId
        AND tc.Deleted_at IS NULL
      LEFT JOIN (
        SELECT
          csd2.AdminId,
          YEARWEEK(cs2.StartDateTime, 1) AS yw,
          COUNT(tc2.TutorCheckinId)      AS cnt
        FROM coursescheduledetails csd2
        JOIN courseschedule cs2
          ON cs2.CourseScheduleId = csd2.CourseScheduleId
          AND cs2.Deleted_at IS NULL
          AND cs2.StartDateTime <= NOW()
          AND DATE(cs2.StartDateTime) BETWEEN ? AND ?
        LEFT JOIN tutorcheckin tc2
          ON tc2.CourseScheduleDetailId = csd2.CourseScheduleDetailId
          AND tc2.Deleted_at IS NULL
        GROUP BY csd2.AdminId, yw
      ) weekly ON weekly.AdminId = a.AdminId

      WHERE a.RoleId = 2 AND a.Deleted_at IS NULL
      GROUP BY a.AdminId
      HAVING TotalScheduled > 0
      ORDER BY CheckinRate DESC
    `, [startDate, endDate, startDate, endDate]);

    // ── Normalize ชั่วโมงสะสม (0–100) เทียบกับคนที่สอนมากสุด ──
    const maxMinutes = Math.max(...rows.map(r => r.TotalMinutes), 1);

    const data = rows.map(r => {
      const checkinScore = r.CheckinRate;                                    // 40%
      const consistScore = r.ConsistencyScore;                               // 30%
      const workloadScore = Math.round(r.TotalMinutes / maxMinutes * 100);   // 30%

      const performanceScore = Math.round(
        checkinScore * 0.40 +
        consistScore * 0.30 +
        workloadScore * 0.30
      );

      return {
        ...r,
        WorkloadScore: workloadScore,
        TotalHours: +(r.TotalMinutes / 60).toFixed(1),
        PerformanceScore: performanceScore,
        Badge: getBadgeLabel(performanceScore),
      };
    }).sort((a, b) => b.PerformanceScore - a.PerformanceScore)
      .map((r, i) => ({ ...r, Rank: i + 1 }));

    res.json({ startDate, endDate, tutors: data });
  } catch (err) {
    console.error('[GET /tutors/performance]', err);
    res.status(500).json({ message: err.message });
  }
});

// helper — วางนอก router ได้เลย หรือจะวางท้ายไฟล์ก่อน module.exports ก็ได้
function getBadgeLabel(score) {
  if (score >= 90) return 'ดีเด่น';
  if (score >= 80) return 'เยี่ยม';
  if (score >= 70) return 'ดี';
  if (score >= 55) return 'พอใช้';
  return 'ต้องปรับปรุง';
}

// ─── GET /api/admin/tutors/:id ────────────────────────────────────────────────
router.get('/tutors/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const sql = `
      SELECT
        a.*,
        r.RoleName,
        GREATEST(YEAR(CURDATE()) - YEAR(a.Created_at), 1) AS ExperienceYear,
        (
          SELECT COUNT(DISTINCT e.UserId)
          FROM tutorcoursedetails tcd
          JOIN enroll e ON tcd.CourseID = e.CourseID
          WHERE tcd.AdminId = a.AdminId
        ) AS StudentCount,
        (
          SELECT GROUP_CONCAT(DISTINCT s.SubjectName ORDER BY s.SubjectName SEPARATOR ', ')
          FROM tutorcoursedetails tcd
          JOIN subjects s ON tcd.SubjectId = s.SubjectId
          WHERE tcd.AdminId = a.AdminId
        ) AS Subjects
      FROM admin a
      LEFT JOIN role r ON r.RoleId = a.RoleId
      WHERE a.AdminId = ? AND a.Deleted_at IS NULL
    `;
    const rows = await q(sql, [id]);
    if (!rows.length) return res.status(404).json({ message: 'ไม่พบติวเตอร์' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[GET /tutors/:id]', err);
    res.status(500).json({ message: 'ดึงข้อมูลไม่สำเร็จ', error: err.message });
  }
});

// ─── POST /api/admin/tutors ────────────────────────────────────────────────────
router.post('/tutors', async (req, res) => {
  const {
    firstname, lastname, nickname, phoneNo, occupation,
    birthOfDate, remark, username, password,
    ratePerTutors, emergencyContactName, emergencyContactPhoneNo,
    lineId, bankName, bankAccountNumber, bankAccountName
  } = req.body;

  if (!firstname?.trim() || !lastname?.trim())
    return res.status(400).json({ message: 'กรุณากรอกชื่อ-นามสกุล' });
  if (!username?.trim() || !password?.trim())
    return res.status(400).json({ message: 'กรุณากรอก Username และ Password' });

  try {
    const existing = await q('SELECT AdminId FROM admin WHERE Username = ? AND Deleted_at IS NULL', [username]);
    if (existing.length) return res.status(400).json({ message: 'Username นี้ถูกใช้งานแล้ว' });

    const val = v => (v === '' || v === undefined ? null : v);
    const hashed = await bcrypt.hash(password, 10);

    const result = await q(
      `INSERT INTO admin (
        Firstname, Lastname, Nickname, PhoneNo, Occupation,
        BirthOfDate, Remark, Username, Password,
        RatePerTutors, EmergencyContactName, EmergencyContactPhoneNo,
        LineID, BankName, BankAccountNumber, BankAccountName,
        RoleId, Created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,2,NOW())`,
      [
        firstname.trim(), lastname.trim(), val(nickname), val(phoneNo), val(occupation),
        val(birthOfDate), val(remark), username.trim(), hashed,
        val(ratePerTutors), val(emergencyContactName), val(emergencyContactPhoneNo),
        val(lineId), val(bankName), val(bankAccountNumber), val(bankAccountName)
      ]
    );
    res.status(201).json({ message: 'สร้างติวเตอร์สำเร็จ', AdminId: result.insertId });
  } catch (err) {
    console.error('[POST /tutors]', err);
    res.status(500).json({ message: 'สร้างติวเตอร์ไม่สำเร็จ', error: err.message });
  }
});

// ─── PUT /api/admin/tutors/:id ────────────────────────────────────────────────
router.put('/tutors/:id', async (req, res) => {
  const { id } = req.params;
  const {
    firstname, lastname, nickname, phoneNo, occupation,
    birthOfDate, remark, ratePerTutors,
    emergencyContactName, emergencyContactPhoneNo, lineId,
    bankName, bankAccountNumber, bankAccountName
  } = req.body;

  if (!firstname?.trim() || !lastname?.trim())
    return res.status(400).json({ message: 'กรุณากรอกชื่อ-นามสกุล' });

  try {
    const exists = await q('SELECT AdminId FROM admin WHERE AdminId = ? AND Deleted_at IS NULL', [id]);
    if (!exists.length) return res.status(404).json({ message: 'ไม่พบติวเตอร์' });

    const val = v => (v === '' || v === undefined ? null : v);
    await q(
      `UPDATE admin SET
        Firstname = ?, Lastname = ?, Nickname = ?, PhoneNo = ?, Occupation = ?,
        BirthOfDate = ?, Remark = ?, RatePerTutors = ?,
        EmergencyContactName = ?, EmergencyContactPhoneNo = ?, LineID = ?,
        BankName = ?, BankAccountNumber = ?, BankAccountName = ?,
        Updated_at = NOW()
      WHERE AdminId = ?`,
      [
        firstname, lastname, val(nickname), val(phoneNo), val(occupation),
        valDate(birthOfDate),
        val(remark), val(ratePerTutors),
        val(emergencyContactName), val(emergencyContactPhoneNo), val(lineId),
        val(bankName), val(bankAccountNumber), val(bankAccountName),
        id
      ]
    );
    res.json({ message: 'แก้ไขข้อมูลสำเร็จ' });
  } catch (err) {
    console.error('[PUT /tutors/:id]', err);
    res.status(500).json({ message: 'แก้ไขไม่สำเร็จ', error: err.message });
  }
});

// ─── PATCH /api/admin/tutors/:id/photo ───────────────────────────────────────
// router.patch('/tutors/:id/photo', upload.single('photo'), async (req, res) => {
//   const { id } = req.params;
//   const photoPath = req.file ? `/uploads/${req.file.filename}` : null;
router.patch('/tutors/:id/photo', uploadImage.single('photo'), async (req, res) => {
  const { id } = req.params;
  const photoPath = req.file ? req.file.path : null;
  if (!photoPath) return res.status(400).json({ message: 'ไม่พบไฟล์รูปภาพ' });
  try {
    await q('UPDATE admin SET Photo = ?, Updated_at = NOW() WHERE AdminId = ?', [photoPath, id]);
    res.json({ message: 'อัปเดตรูปภาพสำเร็จ', photo: photoPath });
  } catch (err) {
    res.status(500).json({ message: 'อัปเดตรูปภาพไม่สำเร็จ', error: err.message });
  }
});

// ─── PATCH /api/admin/tutors/:id/reset-password ──────────────────────────────
router.patch('/tutors/:id/reset-password', async (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body;
  if (!newPassword?.trim()) return res.status(400).json({ message: 'กรุณากรอกรหัสผ่านใหม่' });
  try {
    const hashed = await bcrypt.hash(newPassword, 10);
    await q('UPDATE admin SET Password = ?, Updated_at = NOW() WHERE AdminId = ?', [hashed, id]);
    res.json({ message: 'รีเซ็ตรหัสผ่านสำเร็จ' });
  } catch (err) {
    res.status(500).json({ message: 'รีเซ็ตรหัสผ่านไม่สำเร็จ', error: err.message });
  }
});

// ─── DELETE /api/admin/tutors/:id ────────────────────────────────────────────
router.delete('/tutors/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const exists = await q('SELECT AdminId FROM admin WHERE AdminId = ? AND Deleted_at IS NULL', [id]);
    if (!exists.length) return res.status(404).json({ message: 'ไม่พบติวเตอร์' });

    // เช็คว่ามีการ checkin ยังไม่จ่ายเงินไหม
    const unpaid = await q(
      'SELECT COUNT(*) AS cnt FROM tutorcheckin WHERE AdminId = ? AND TutorPaymentId IS NULL AND Deleted_at IS NULL',
      [id]
    );
    if (unpaid[0].cnt > 0) {
      return res.status(409).json({
        message: `ไม่สามารถลบได้ เนื่องจากมีค่าสอนค้างจ่าย ${unpaid[0].cnt} คาบ`
      });
    }

    await q('UPDATE admin SET Deleted_at = NOW() WHERE AdminId = ?', [id]);
    res.json({ message: 'ลบติวเตอร์สำเร็จ' });
  } catch (err) {
    console.error('[DELETE /tutors/:id]', err);
    res.status(500).json({ message: 'ลบไม่สำเร็จ', error: err.message });
  }
});

// ─── GET /api/admin/tutors/:id/unpaid-sessions ────────────────────────────────
// ดึง session ที่ยังไม่จ่ายเงินของติวเตอร์คนนั้น
router.get('/tutors/:id/unpaid-sessions', async (req, res) => {
  const { id } = req.params;
  try {
    const sessions = await q(`
      SELECT
        tc.TutorCheckinId,
        tc.PhotoStart,
        tc.PhotoEnd,
        tc.Remark,
        c.CourseName,
        s.SubjectName,
        DATE(cs.StartDateTime)             AS ClassDate,
        TIME_FORMAT(cs.StartTime, '%H:%i') AS StartTime,
        TIME_FORMAT(cs.EndTime,   '%H:%i') AS EndTime,
        TIMESTAMPDIFF(MINUTE,
          ADDTIME('2000-01-01', cs.StartTime),
          ADDTIME('2000-01-01', cs.EndTime)
        ) AS PlannedMinutes,
        a.RatePerTutors
      FROM tutorcheckin tc
      JOIN admin a    ON a.AdminId = tc.AdminId
      JOIN coursescheduledetails csd
                      ON csd.CourseScheduleDetailId = tc.CourseScheduleDetailId
      JOIN courseschedule cs
                      ON cs.CourseScheduleId = csd.CourseScheduleId
      JOIN courses c  ON c.CourseID = csd.CourseID
      LEFT JOIN subjects s ON s.SubjectId = csd.SubjectId
      WHERE tc.AdminId         = ?
        AND tc.TutorPaymentId  IS NULL
        AND tc.Deleted_at      IS NULL
      ORDER BY cs.StartDateTime ASC
    `, [id]);
    res.json(sessions);
  } catch (err) {
    console.error('[GET /tutors/:id/unpaid-sessions]', err);
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/admin/tutor-payments ──────────────────────────────────────────
// บันทึกการจ่ายเงิน + อัปโหลดสลิป
// router.post('/tutor-payments', upload.single('slip'), async (req, res) => {
//   const { adminId, checkinIds, paymentDate, billNo, remark } = req.body;
//   const slipPath = req.file ? `/uploads/${req.file.filename}` : null;
router.post('/tutor-payments', uploadImage.single('slip'), async (req, res) => {
  const { adminId, checkinIds, paymentDate, billNo, remark } = req.body;
  const slipPath = req.file ? req.file.path : null;

  let ids;
  try {
    ids = JSON.parse(checkinIds);
  } catch {
    return res.status(400).json({ message: 'checkinIds format ไม่ถูกต้อง' });
  }

  if (!ids?.length) return res.status(400).json({ message: 'กรุณาเลือก session อย่างน้อย 1 รายการ' });
  if (!adminId) return res.status(400).json({ message: 'ไม่พบ adminId' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ── 1. ตรวจสอบว่า session ทุกตัวยังไม่ถูกจ่าย (ป้องกัน race condition) ──
    const [sessions] = await conn.query(`
      SELECT
        tc.TutorCheckinId,
        a.RatePerTutors,
        TIMESTAMPDIFF(MINUTE,
          ADDTIME('2000-01-01', cs.StartTime),
          ADDTIME('2000-01-01', cs.EndTime)
        ) AS PlannedMinutes
      FROM tutorcheckin tc
      JOIN admin a ON a.AdminId = tc.AdminId
      JOIN coursescheduledetails csd
        ON csd.CourseScheduleDetailId = tc.CourseScheduleDetailId
      JOIN courseschedule cs
        ON cs.CourseScheduleId = csd.CourseScheduleId
      WHERE tc.TutorCheckinId IN (?)
        AND tc.TutorPaymentId IS NULL
        AND tc.Deleted_at     IS NULL
    `, [ids]);

    // ถ้า session ที่หาได้น้อยกว่าที่ส่งมา แสดงว่าบางตัวถูกจ่ายไปแล้ว
    if (sessions.length !== ids.length) {
      await conn.rollback();
      return res.status(409).json({
        message: 'บางรายการถูกจ่ายไปแล้ว กรุณารีเฟรชและลองใหม่'
      });
    }

    // ── 2. คำนวณยอดรวม (rate/ชม × ชั่วโมงที่สอน) ──────────────────────────
    const totalAmount = sessions.reduce((sum, s) => {
      return sum + (s.RatePerTutors * s.PlannedMinutes / 60);
    }, 0);

    // ── 3. INSERT tutorpayment ──────────────────────────────────────────────
    const [result] = await conn.query(`
      INSERT INTO tutorpayment
        (PaymentCost, PaymentDate, BillNo, PaymentPicture, Created_at)
      VALUES (?, ?, ?, ?, NOW())
    `, [
      totalAmount.toFixed(2),
      paymentDate || null,
      billNo || null,
      slipPath
    ]);

    const paymentId = result.insertId;

    // ── 4. UPDATE tutorcheckin ทุกตัวที่เลือก ──────────────────────────────
    await conn.query(
      `UPDATE tutorcheckin SET TutorPaymentId = ? WHERE TutorCheckinId IN (?)`,
      [paymentId, ids]
    );

    await conn.commit();
    res.status(201).json({
      message: 'บันทึกการจ่ายเงินสำเร็จ',
      TutorPaymentId: paymentId,
      TotalAmount: parseFloat(totalAmount.toFixed(2)),
      SessionCount: ids.length,
    });
  } catch (err) {
    await conn.rollback();
    console.error('[POST /tutor-payments]', err);
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;