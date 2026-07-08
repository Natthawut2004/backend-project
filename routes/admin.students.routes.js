const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

const valDate = v => {
  if (!v || v.trim() === '') return null;
  return v.slice(0, 10); // ตัดเอาแค่ "YYYY-MM-DD" ทิ้ง timezone ทิ้ง
};

// ─── GET /api/admin/students ──────────────────────────────────────────────────
router.get('/students', async (req, res) => {
  try {
    const sql = `
      SELECT
        u.UserId, u.Firstname, u.Lastname, u.Nickname,
        u.PhoneNo, u.SchoolName, u.LineID, u.BirthOfDate,
        u.GPA, u.GradeLevelId, u.GenderId,
        u.GPA, u.GradeLevelId, u.Created_at, u.Updated_at,
        g.GradeDetail,
        gen.GenderName,
        COUNT(DISTINCT e.CourseID) AS EnrolledCourses,
        GROUP_CONCAT(DISTINCT c.CourseName ORDER BY c.CourseName SEPARATOR ' | ') AS CourseNames
      FROM users u
      LEFT JOIN gradelevel g  ON g.GradeLevelId  = u.GradeLevelId
      LEFT JOIN gender    gen ON gen.GenderId     = u.GenderId
      LEFT JOIN enroll    e   ON e.UserId         = u.UserId
      LEFT JOIN courses   c   ON c.CourseID       = e.CourseID AND c.Deleted_at IS NULL
      WHERE u.Deleted_at IS NULL
      GROUP BY u.UserId
      ORDER BY u.UserId DESC
    `;
    const rows = await q(sql);
    res.json(rows);
  } catch (err) {
    console.error('[GET /students]', err);
    res.status(500).json({ message: 'ดึงข้อมูลนักเรียนไม่สำเร็จ', error: err.message });
  }
});

// ─── GET /api/admin/students/performance ──────────────────────────────────────
// วางไว้ก่อน route /students/:id !!!
router.get('/students/performance', async (_req, res) => {
  try {
    const rows = await q(`
      SELECT
        u.UserId,
        u.Firstname,
        u.Lastname,
        u.Nickname,
        u.GPA,
        u.GradeLevelId,
        g.GradeDetail,
        u.SchoolName,

        -- ── Attendance ───────────────────────────────────────────────────────
        COUNT(DISTINCT sa.StudentAttendanceId)                          AS TotalClasses,
        SUM(CASE WHEN sa.Status = '1' THEN 1 ELSE 0 END)               AS TotalAttended,
        ROUND(
          SUM(CASE WHEN sa.Status = '1' THEN 1 ELSE 0 END)
          / NULLIF(COUNT(DISTINCT sa.StudentAttendanceId), 0) * 100
        , 1)                                                            AS AttendanceRate,

        -- ── Pre-test (ExamTypeId = 1): ค่าเฉลี่ยเป็น % ─────────────────────
        ROUND(
          AVG(
            CASE WHEN e.ExamTypeId = 1 AND t.MaxScore > 0
            THEN (t.Score / t.MaxScore * 100)
            END
          )
        , 1)                                                            AS PreTestScore,
        COUNT(CASE WHEN e.ExamTypeId = 1 AND t.MaxScore > 0 THEN 1 END) AS PreTestCount,

        -- ── Mid-test (ExamTypeId = 2) ────────────────────────────────────────
        ROUND(
          AVG(
            CASE WHEN e.ExamTypeId = 2 AND t.MaxScore > 0
            THEN (t.Score / t.MaxScore * 100)
            END
          )
        , 1)                                                            AS MidTestScore,
        COUNT(CASE WHEN e.ExamTypeId = 2 AND t.MaxScore > 0 THEN 1 END) AS MidTestCount,

        -- ── Post-test (ExamTypeId = 3) ───────────────────────────────────────
        ROUND(
          AVG(
            CASE WHEN e.ExamTypeId = 3 AND t.MaxScore > 0
            THEN (t.Score / t.MaxScore * 100)
            END
          )
        , 1)                                                            AS PostTestScore,
        COUNT(CASE WHEN e.ExamTypeId = 3 AND t.MaxScore > 0 THEN 1 END) AS PostTestCount

      FROM users u
      LEFT JOIN gradelevel g
        ON g.GradeLevelId = u.GradeLevelId
      LEFT JOIN studentattendance sa
        ON sa.UserId = u.UserId AND sa.Deleted_at IS NULL
      LEFT JOIN exam e
        ON e.UserId = u.UserId AND e.Deleted_at IS NULL
      LEFT JOIN test t
        ON t.TestId = e.TestId AND t.Deleted_at IS NULL
      WHERE u.Deleted_at IS NULL
      GROUP BY u.UserId
      HAVING TotalClasses >= 1
    `);

    // ── คำนวณ PerformanceScore ใน JS ────────────────────────────────────────
    // สูตร: attendance 40% + pre 20% + mid 20% + post 20%
    // ถ้าข้อมูล test ประเภทไหนหายไป → กระจาย weight คืนให้ attendance
    const result = rows.map(r => {
      const att  = Number(r.AttendanceRate) || 0;
      const pre  = r.PreTestScore  !== null ? Number(r.PreTestScore)  : null;
      const mid  = r.MidTestScore  !== null ? Number(r.MidTestScore)  : null;
      const post = r.PostTestScore !== null ? Number(r.PostTestScore) : null;

      const testCount   = [pre, mid, post].filter(v => v !== null).length;
      // base weight: att=40, แต่ถ้าไม่มี test เลย att=100
      const testWeight  = testCount > 0 ? 60 : 0;
      const attWeight   = 100 - testWeight;
      const perTest     = testCount > 0 ? Math.round(testWeight / testCount) : 0;

      let score = att * (attWeight / 100);
      if (pre  !== null) score += pre  * (perTest / 100);
      if (mid  !== null) score += mid  * (perTest / 100);
      if (post !== null) score += post * (perTest / 100);

      // AttendanceScore ใช้แสดงใน breakdown (scale เทียบ weight จริง)
      const attScore   = Math.round(att * (attWeight / 100));
      const preScore   = pre  !== null ? Math.round(pre  * (perTest / 100)) : null;
      const midScore   = mid  !== null ? Math.round(mid  * (perTest / 100)) : null;
      const postScore  = post !== null ? Math.round(post * (perTest / 100)) : null;

      return {
        ...r,
        AttendanceRate:   att,
        PreTestScore:     pre,
        MidTestScore:     mid,
        PostTestScore:    post,
        AttendanceWeight: attWeight,
        TestWeight:       perTest,
        PerformanceScore: Math.min(100, Math.round(score)),
        // สำหรับ breakdown bar
        AttendanceContrib: attScore,
        PreTestContrib:    preScore,
        MidTestContrib:    midScore,
        PostTestContrib:   postScore,
      };
    });

    // เรียงจากคะแนนสูงสุด
    result.sort((a, b) => b.PerformanceScore - a.PerformanceScore);
    res.json(result);
  } catch (err) {
    console.error('[GET /students/performance]', err);
    res.status(500).json({ message: 'ดึงข้อมูลไม่สำเร็จ', error: err.message });
  }
});

// ─── GET /api/admin/students/top-attendance ───────────────────────────────────
router.get('/students/top-attendance', async (_req, res) => {
  try {
    const rows = await q(`
      SELECT
        u.UserId,
        u.Firstname,
        u.Lastname,
        u.Nickname,
        u.GPA,
        u.SchoolName,
        g.GradeDetail,
        COUNT(sa.StudentAttendanceId)                                         AS TotalClasses,
        SUM(CASE WHEN sa.Status = '1' THEN 1 ELSE 0 END)                     AS TotalAttended,
        ROUND(
          SUM(CASE WHEN sa.Status = '1' THEN 1 ELSE 0 END)
          / NULLIF(COUNT(sa.StudentAttendanceId), 0) * 100
        , 1)                                                                  AS AttendanceRate
      FROM users u
      JOIN studentattendance sa
        ON sa.UserId = u.UserId AND sa.Deleted_at IS NULL
      LEFT JOIN gradelevel g ON g.GradeLevelId = u.GradeLevelId
      WHERE u.Deleted_at IS NULL
      GROUP BY u.UserId
      HAVING TotalClasses >= 1
      ORDER BY AttendanceRate DESC, TotalAttended DESC
      LIMIT 5
    `);
    res.json(rows);
  } catch (err) {
    console.error('[GET /students/top-attendance]', err);
    res.status(500).json({ message: 'ดึงข้อมูลไม่สำเร็จ', error: err.message });
  }
});



// ─── GET /api/admin/students/:id ─────────────────────────────────────────────
router.get('/students/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const userRows = await q(`
      SELECT
        u.*,
        g.GradeDetail,
        gen.GenderName
      FROM users u
      LEFT JOIN gradelevel g  ON g.GradeLevelId = u.GradeLevelId
      LEFT JOIN gender    gen ON gen.GenderId    = u.GenderId
      WHERE u.UserId = ? AND u.Deleted_at IS NULL
    `, [id]);
    if (!userRows.length) return res.status(404).json({ message: 'ไม่พบนักเรียน' });

    const courses = await q(`
      SELECT
        e.EnrollId, c.CourseID, c.CourseName, c.StartDate, c.LastDate,
        c.FullCost, sc.Status_Course_Name,
        se.Status_Enroll_Name,
        -- FIX #4: นับ TotalClassHeld จากคาบทั้งหมดในคอร์ส ไม่ใช่จาก attendance ของ user
        (
          SELECT COUNT(*)
          FROM coursescheduledetails csd
          WHERE csd.CourseID = c.CourseID
        ) AS TotalClassHeld,
        COUNT(DISTINCT CASE WHEN sa.Status = '1' THEN sa.CourseScheduleDetailId END) AS TotalAttended
      FROM enroll e
      JOIN courses c ON c.CourseID = e.CourseID AND c.Deleted_at IS NULL
      LEFT JOIN status_course sc ON sc.Status_Course_Id = c.Status_Course_Id
      LEFT JOIN status_enroll se ON se.Status_Enroll_Id = e.Status_Enroll_Id
      LEFT JOIN studentattendance sa
        ON sa.UserId = e.UserId
       AND sa.Deleted_at IS NULL
       AND sa.CourseScheduleDetailId IN (
             SELECT csd.CourseScheduleDetailId
             FROM coursescheduledetails csd
             WHERE csd.CourseID = c.CourseID
           )
      WHERE e.UserId = ?
      GROUP BY e.EnrollId
      ORDER BY e.EnrollId DESC
    `, [id]);

    const attendance = await q(`
      SELECT
        sa.StudentAttendanceId,
        sa.Status,
        sa.Reason,
        sa.Created_at AS AttendanceDate,
        c.CourseName,
        s.SubjectName,
        r.RoomDetail,
        TIME_FORMAT(cs.StartTime, '%H:%i') AS StartTime,
        TIME_FORMAT(cs.EndTime,   '%H:%i') AS EndTime,
        DATE(cs.StartDateTime) AS ClassDate
      FROM studentattendance sa
      JOIN coursescheduledetails csd
        ON csd.CourseScheduleDetailId = sa.CourseScheduleDetailId
      JOIN courseschedule cs
        ON cs.CourseScheduleId = csd.CourseScheduleId
      JOIN courses c
        ON c.CourseID = csd.CourseID
      LEFT JOIN subjects s ON s.SubjectId = csd.SubjectId
      LEFT JOIN rooms    r ON r.RoomId    = csd.RoomId
      WHERE sa.UserId = ? AND sa.Deleted_at IS NULL
      ORDER BY cs.StartDateTime DESC
    `, [id]);

    const videoProgress = await q(`
      SELECT
        svp.StudentVideoProgressId,
        svp.WatchPercent, svp.LastWatchTime, svp.WatchDate, svp.WatchRound,
        v.VideoId, v.VideoTitle, v.VideoUrl, v.Duration,
        c.CourseName,
        s.SubjectName
      FROM studentvideoprogress svp
      JOIN videos v ON v.VideoId = svp.VideoId
      JOIN courses c ON c.CourseID = v.CourseID
      LEFT JOIN subjects s ON s.SubjectId = v.SubjectId
      WHERE svp.UserId = ?
      ORDER BY svp.WatchDate DESC
    `, [id]);

    res.json({
      student: userRows[0],
      courses,
      attendance,
      videoProgress
    });
  } catch (err) {
    console.error('[GET /students/:id]', err);
    res.status(500).json({ message: 'ดึงข้อมูลไม่สำเร็จ', error: err.message });
  }
});

// ─── POST /api/admin/students ─────────────────────────────────────────────────
router.post('/students', async (req, res) => {
  const {
    firstname, lastname, nickname, phoneNo, schoolName,
    lineId, birthOfDate, remark, username, password,
    gpa, gradeLevelId, genderId
  } = req.body;

  if (!firstname?.trim() || !lastname?.trim())
    return res.status(400).json({ message: 'กรุณากรอกชื่อ-นามสกุล' });
  if (!username?.trim() || !password?.trim())
    return res.status(400).json({ message: 'กรุณากรอก Username และ Password' });

  try {
    const existing = await q('SELECT UserId FROM users WHERE Username = ? AND Deleted_at IS NULL', [username]);
    if (existing.length) return res.status(400).json({ message: 'Username นี้ถูกใช้งานแล้ว' });

    const val = v => (v === '' || v === undefined ? null : v);
    const hashed = await bcrypt.hash(password, 10);

    const result = await q(
      `INSERT INTO users (
        Firstname, Lastname, Nickname, PhoneNo, SchoolName,
        LineID, BirthOfDate, Remark, Username, Password,
        GPA, GradeLevelId, GenderId, Created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        firstname.trim(), lastname.trim(), val(nickname), val(phoneNo), val(schoolName),
        val(lineId), val(birthOfDate), val(remark), username.trim(), hashed,
        val(gpa), val(gradeLevelId), val(genderId)
      ]
    );
    res.status(201).json({ message: 'เพิ่มนักเรียนสำเร็จ', UserId: result.insertId });
  } catch (err) {
    console.error('[POST /students]', err);
    res.status(500).json({ message: 'เพิ่มนักเรียนไม่สำเร็จ', error: err.message });
  }
});

// ─── PUT /api/admin/students/:id ─────────────────────────────────────────────
router.put('/students/:id', async (req, res) => {
  const { id } = req.params;
  const {
    firstname, lastname, nickname, phoneNo, schoolName,
    lineId, birthOfDate, remark, gpa, gradeLevelId, genderId
  } = req.body;

  if (!firstname?.trim() || !lastname?.trim())
    return res.status(400).json({ message: 'กรุณากรอกชื่อ-นามสกุล' });

  try {
    const exists = await q('SELECT UserId FROM users WHERE UserId = ? AND Deleted_at IS NULL', [id]);
    if (!exists.length) return res.status(404).json({ message: 'ไม่พบนักเรียน' });

    const val = v => (v === '' || v === undefined ? null : v);
    await q(
      `UPDATE users SET
        Firstname = ?, Lastname = ?, Nickname = ?, PhoneNo = ?, SchoolName = ?,
        LineID = ?, BirthOfDate = ?, Remark = ?, GPA = ?,
        GradeLevelId = ?, GenderId = ?, Updated_at = NOW()
      WHERE UserId = ?`,
      [
        firstname.trim(), lastname.trim(), val(nickname), val(phoneNo), val(schoolName),
        val(lineId), valDate(birthOfDate),
        val(remark), val(gpa),
        val(gradeLevelId), val(genderId), id
      ]
    );
    res.json({ message: 'แก้ไขข้อมูลสำเร็จ' });
  } catch (err) {
    console.error('[PUT /students/:id]', err);
    res.status(500).json({ message: 'แก้ไขไม่สำเร็จ', error: err.message });
  }
});

// ─── PATCH /api/admin/students/:id/reset-password ────────────────────────────
// FIX #2: เช็คว่า user มีอยู่จริงก่อน UPDATE
router.patch('/students/:id/reset-password', async (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body;
  if (!newPassword?.trim()) return res.status(400).json({ message: 'กรุณากรอกรหัสผ่านใหม่' });
  try {
    const exists = await q('SELECT UserId FROM users WHERE UserId = ? AND Deleted_at IS NULL', [id]);
    if (!exists.length) return res.status(404).json({ message: 'ไม่พบนักเรียน' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await q('UPDATE users SET Password = ?, Updated_at = NOW() WHERE UserId = ?', [hashed, id]);
    res.json({ message: 'รีเซ็ตรหัสผ่านสำเร็จ' });
  } catch (err) {
    res.status(500).json({ message: 'รีเซ็ตรหัสผ่านไม่สำเร็จ', error: err.message });
  }
});

// ─── DELETE /api/admin/students/:id ──────────────────────────────────────────
// FIX #1: เพิ่มเช็ค attendance และ videoProgress ก่อน soft delete
router.delete('/students/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const exists = await q('SELECT UserId FROM users WHERE UserId = ? AND Deleted_at IS NULL', [id]);
    if (!exists.length) return res.status(404).json({ message: 'ไม่พบนักเรียน' });

    const enrolled = await q('SELECT COUNT(*) AS cnt FROM enroll WHERE UserId = ?', [id]);
    if (enrolled[0].cnt > 0) {
      return res.status(409).json({
        message: `ไม่สามารถลบได้ เนื่องจากมีประวัติลงทะเบียนคอร์ส ${enrolled[0].cnt} รายการ`
      });
    }

    // FIX #1: ตรวจ attendance และ videoProgress ก่อน soft delete
    const [attRows, vidRows] = await Promise.all([
      q('SELECT COUNT(*) AS cnt FROM studentattendance WHERE UserId = ? AND Deleted_at IS NULL', [id]),
      q('SELECT COUNT(*) AS cnt FROM studentvideoprogress WHERE UserId = ?', [id]),
    ]);
    if (attRows[0].cnt > 0 || vidRows[0].cnt > 0) {
      return res.status(409).json({
        message: `ไม่สามารถลบได้ เนื่องจากมีประวัติเข้าเรียน (${attRows[0].cnt} รายการ) หรือประวัติวิดีโอ (${vidRows[0].cnt} รายการ)`
      });
    }

    await q('UPDATE users SET Deleted_at = NOW() WHERE UserId = ?', [id]);
    res.json({ message: 'ลบนักเรียนสำเร็จ' });
  } catch (err) {
    console.error('[DELETE /students/:id]', err);
    res.status(500).json({ message: 'ลบไม่สำเร็จ', error: err.message });
  }
});

// ─── Lookup endpoints ─────────────────────────────────────────────────────────
router.get('/grade-levels', async (_req, res) => {
  try {
    const rows = await q('SELECT GradeLevelId, GradeDetail FROM gradelevel WHERE Deleted_at IS NULL ORDER BY GradeLevelId');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/genders', async (_req, res) => {
  try {
    const rows = await q('SELECT GenderId, GenderName FROM gender WHERE Deleted_at IS NULL ORDER BY GenderId');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;