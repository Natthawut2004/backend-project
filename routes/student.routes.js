// routes/student.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

// ─── Middleware ───────────────────────────────────────────────────────────────

function authStudent(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ message: 'Token invalid or expired' });
  }
}

// ─── POST /api/student/login ─────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ message: 'กรุณากรอก Username และ Password' });
    }

    const [rows] = await pool.query(
      `SELECT u.UserId, u.Firstname, u.Lastname, u.Nickname,
              u.Username, u.Password, u.PhoneNo, u.SchoolName,
              u.LineID, u.BirthOfDate, u.GPA,
              g.GradeDetail, ge.GenderName
       FROM users u
       LEFT JOIN gradelevel g ON g.GradeLevelId = u.GradeLevelId
       LEFT JOIN gender ge ON ge.GenderId = u.GenderId
       WHERE u.Username = ? AND u.Deleted_at IS NULL`,
      [username]
    );

    if (!rows.length || rows[0].Password !== password) {
      return res.status(401).json({ message: 'Username หรือ Password ไม่ถูกต้อง' });
    }

    const user = rows[0];
    const token = jwt.sign({ userId: user.UserId }, JWT_SECRET, { expiresIn: '7d' });

    const { Password, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/student/profile ─────────────────────────────────────────────────

router.get('/profile', authStudent, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT 
         u.UserId, u.Firstname, u.Lastname, u.Nickname,
         u.PhoneNo, u.SchoolName, u.LineID, u.BirthOfDate,
         u.GPA, u.Remark, u.Username, u.Created_at,

         g.GradeDetail,
         ge.GenderName,

         pp.ParentId,
         pp.Firstname AS ParentFirstname,
         pp.Lastname AS ParentLastname,
         pp.Nickname AS ParentNickname,
         pp.PhoneNo AS ParentPhoneNo,
         pp.LineID AS ParentLineID,
         pp.BirthOfDate AS ParentBirthOfDate,
         pp.Relationship AS ParentRelationship,

         ppt.ParentProfilesType_Name AS ParentType

       FROM users u
       LEFT JOIN gradelevel g ON g.GradeLevelId = u.GradeLevelId
       LEFT JOIN gender ge ON ge.GenderId = u.GenderId
       LEFT JOIN ParentProfiles pp ON pp.ParentId = u.ParentId
       LEFT JOIN ParentProfilesType ppt 
              ON ppt.ParentProfilesType_Id = pp.ParentProfilesType_Id

       WHERE u.UserId = ? AND u.Deleted_at IS NULL`,
      [req.userId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Not found' });
    }

    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── PUT /api/student/profile ─────────────────────────────────────────────────

router.put('/profile', authStudent, async (req, res) => {
  try {
    const b = req.body || {};
    await pool.query(
      `UPDATE users SET
         PhoneNo    = COALESCE(?, PhoneNo),
         SchoolName = COALESCE(?, SchoolName),
         LineID     = COALESCE(?, LineID),
         Remark     = COALESCE(?, Remark),
         Updated_at = NOW()
       WHERE UserId = ?`,
      [
        b.PhoneNo ?? null,
        b.SchoolName ?? null,
        b.LineID ?? null,
        b.Remark ?? null,
        req.userId,
      ]
    );
    res.json({ message: 'Updated' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/student/courses ────────────────────────────────────────────────
// คอร์สที่นักเรียน enroll อยู่ พร้อม progress ข้อมูลตารางสอน

router.get('/courses', authStudent, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         e.EnrollId,
         c.CourseID, c.CourseName, c.StartDate, c.LastDate,
         c.Price, c.Discount, c.FullCost, c.CourseImage,
         sc.Status_Course_Name,
         ca.Course_Availability_Name,
         se.Status_Enroll_Name,
         -- นับจำนวน schedule ทั้งหมดของคอร์ส
         (SELECT COUNT(*)
          FROM coursescheduledetails csd
          JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
          WHERE csd.CourseID = c.CourseID AND cs.Deleted_at IS NULL
         ) AS TotalSessions,
         -- นับ session ที่ผ่านมาแล้ว (ใช้ estimate progress)
         (SELECT COUNT(*)
          FROM coursescheduledetails csd
          JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
          WHERE csd.CourseID = c.CourseID
            AND cs.Deleted_at IS NULL
            AND cs.StartDateTime <= NOW()
         ) AS CompletedSessions,
         -- นับ video ทั้งหมดในคอร์ส
         (SELECT COUNT(*) FROM course_videos cv WHERE cv.CourseID = c.CourseID) AS TotalVideos,
         -- นับ video ที่นักเรียนดูแล้ว (>= 80%)
         (SELECT COUNT(*)
          FROM studentvideoprogress svp
          JOIN course_videos cv ON cv.VideoId = svp.VideoId
          WHERE cv.CourseID = c.CourseID
            AND svp.UserId = e.UserId
            AND svp.WatchPercent >= 80
         ) AS WatchedVideos,
         -- นับเอกสาร
         (SELECT COUNT(*) FROM course_files cf WHERE cf.CourseID = c.CourseID) AS TotalFiles
       FROM enroll e
       JOIN courses c ON c.CourseID = e.CourseID
       LEFT JOIN status_course sc ON sc.Status_Course_Id = c.Status_Course_Id
       LEFT JOIN course_availability ca ON ca.Course_Availability_Id = c.Course_Availability_Id
       LEFT JOIN status_enroll se ON se.Status_Enroll_Id = e.Status_Enroll_Id
       WHERE e.UserId = ?
       ORDER BY c.StartDate DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/student/schedule ───────────────────────────────────────────────
// ตารางเรียนของนักเรียน (เฉพาะคอร์สที่ enroll)

router.get('/schedule', authStudent, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         csd.CourseScheduleDetailId,
         cs.CourseScheduleId,
         cs.StartDateTime,
         cs.EndDateTime,
         cs.DayOfWeek,
         cs.StartTime,
         cs.EndTime,
         c.CourseID,
         c.CourseName,
         c.CourseImage,
         s.SubjectId,
         s.SubjectName,
         a.AdminId,
         CONCAT(a.Firstname, ' ', a.Lastname) AS TutorName,
         a.Nickname AS TutorNickname,
         a.Photo AS TutorPhoto,
         r.RoomId,
         r.RoomDetail,
         r.Floor,
         -- เช็คการเข้าเรียนของนักเรียนคนนี้
         sa.Status AS AttendanceStatus
       FROM enroll e
       JOIN coursescheduledetails csd ON csd.CourseID = e.CourseID
       JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
       JOIN courses c ON c.CourseID = e.CourseID
       LEFT JOIN subjects s ON s.SubjectId = csd.SubjectId
       LEFT JOIN admin a ON a.AdminId = csd.AdminId
       LEFT JOIN rooms r ON r.RoomId = csd.RoomId
       LEFT JOIN studentattendance sa ON sa.CourseScheduleDetailId = csd.CourseScheduleDetailId
         AND sa.UserId = e.UserId
       WHERE e.UserId = ?
         AND cs.Deleted_at IS NULL
       ORDER BY cs.StartDateTime ASC`,
      [req.userId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/student/courses/:courseId/videos ───────────────────────────────

router.get('/courses/:courseId/videos', authStudent, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);

    // ตรวจว่า enroll คอร์สนี้ไหม
    const [enrolled] = await pool.query(
      'SELECT EnrollId FROM enroll WHERE UserId = ? AND CourseID = ?',
      [req.userId, courseId]
    );
    if (!enrolled.length) {
      return res.status(403).json({ message: 'คุณไม่ได้ลงทะเบียนคอร์สนี้' });
    }

    const [rows] = await pool.query(
      `SELECT
         cv.VideoId, cv.VideoTitle, cv.VideoUrl, cv.Duration, cv.Created_at,
         s.SubjectName,
         svp.WatchPercent, svp.LastWatchTime, svp.WatchDate, svp.WatchRound
       FROM course_videos cv
       LEFT JOIN subjects s ON s.SubjectId = cv.SubjectId
       LEFT JOIN studentvideoprogress svp ON svp.VideoId = cv.VideoId
         AND svp.UserId = ?
       WHERE cv.CourseID = ?
       ORDER BY cv.Created_at ASC`,
      [req.userId, courseId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── PUT /api/student/videos/:videoId/progress ───────────────────────────────

router.put('/videos/:videoId/progress', authStudent, async (req, res) => {
  try {
    const videoId = Number(req.params.videoId);
    const { WatchPercent, LastWatchTime } = req.body || {};

    // upsert
    await pool.query(
      `INSERT INTO studentvideoprogress
         (VideoId, UserId, WatchPercent, LastWatchTime, WatchDate, WatchRound, Created_at)
       VALUES (?, ?, ?, ?, CURDATE(), 1, NOW())
       ON DUPLICATE KEY UPDATE
         WatchPercent  = GREATEST(WatchPercent, VALUES(WatchPercent)),
         LastWatchTime = VALUES(LastWatchTime),
         WatchRound    = WatchRound + 1,
         Updated_at    = NOW()`,
      [videoId, req.userId, WatchPercent ?? 0, LastWatchTime ?? '00:00']
    );
    res.json({ message: 'Progress saved' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/student/courses/:courseId/files ────────────────────────────────

router.get('/courses/:courseId/files', authStudent, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);

    const [enrolled] = await pool.query(
      'SELECT EnrollId FROM enroll WHERE UserId = ? AND CourseID = ?',
      [req.userId, courseId]
    );
    if (!enrolled.length) {
      return res.status(403).json({ message: 'คุณไม่ได้ลงทะเบียนคอร์สนี้' });
    }

    const [rows] = await pool.query(
      `SELECT cf.FileId, cf.FileName, cf.FilePath, cf.FileSize, cf.Created_at,
              s.SubjectName
       FROM course_files cf
       LEFT JOIN subjects s ON s.SubjectId = cf.SubjectId
       WHERE cf.CourseID = ?
       ORDER BY cf.Created_at DESC`,
      [courseId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/student/attendance ─────────────────────────────────────────────

router.get('/attendance', authStudent, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         sa.StudentAttendanceId,
         sa.Status,
         sa.Reason,
         sa.Created_at,
         cs.StartDateTime,
         cs.EndDateTime,
         c.CourseName,
         s.SubjectName
       FROM studentattendance sa
       JOIN coursescheduledetails csd ON csd.CourseScheduleDetailId = sa.CourseScheduleDetailId
       JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
       JOIN courses c ON c.CourseID = csd.CourseID
       LEFT JOIN subjects s ON s.SubjectId = csd.SubjectId
       WHERE sa.UserId = ? AND sa.Deleted_at IS NULL
       ORDER BY cs.StartDateTime DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/student/payments ───────────────────────────────────────────────

router.get('/payments', authStudent, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         sp.StudentPaymentId,
         sp.Price,
         sp.PaymentCost,
         sp.PaymentDate,
         sp.BillNo,
         sp.PaymentType,
         sp.PaymentPicture,
         sp.Created_at,
         sp2.Status_Payment_Name,
         c.CourseName,
         e.EnrollId
       FROM studentpayment sp
       JOIN enroll e ON e.EnrollId = sp.EnrollId
       JOIN courses c ON c.CourseID = e.CourseID
       LEFT JOIN status_payment sp2 ON sp2.Status_Payment_Id = sp.Status_Payment_Id
       WHERE e.UserId = ? AND sp.Deleted_at IS NULL
       ORDER BY sp.Created_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET /api/student/notifications ─────────────────────────────────────────
// ดึง news ที่เปิดให้ public + แจ้งเตือนระบบ (schedule ใกล้, ค้างชำระ)

router.get('/notifications', authStudent, async (req, res) => {
  try {
    // 1. ข่าว/ประกาศ
    const [news] = await pool.query(
      `SELECT NewsId AS id, Title AS title, Detail AS message,
              Category AS type, Created_at AS time
       FROM news
       WHERE TargetAudience = 'public' OR TargetAudience IS NULL
       ORDER BY Created_at DESC
       LIMIT 20`
    );

    // 2. ตารางเรียนพรุ่งนี้
    const [schedules] = await pool.query(
      `SELECT
         cs.CourseScheduleId AS id,
         CONCAT('เตือน: ', s.SubjectName, ' ', c.CourseName) AS title,
         CONCAT('วันที่ ', DATE_FORMAT(cs.StartDateTime,'%d/%m/%Y'),
                ' เวลา ', TIME_FORMAT(cs.StartTime,'%H:%i'),
                '-', TIME_FORMAT(cs.EndTime,'%H:%i'),
                ' ห้อง ', COALESCE(r.RoomDetail,'?')) AS message,
         'schedule' AS type,
         cs.StartDateTime AS time
       FROM enroll e
       JOIN coursescheduledetails csd ON csd.CourseID = e.CourseID
       JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
       JOIN courses c ON c.CourseID = e.CourseID
       LEFT JOIN subjects s ON s.SubjectId = csd.SubjectId
       LEFT JOIN rooms r ON r.RoomId = csd.RoomId
       WHERE e.UserId = ?
         AND cs.Deleted_at IS NULL
         AND cs.StartDateTime BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 2 DAY)
       ORDER BY cs.StartDateTime ASC
       LIMIT 10`,
      [req.userId]
    );

    // 3. ประวัติการชำระเงิน (confirmed)
    const [payments] = await pool.query(
      `SELECT
         sp.StudentPaymentId AS id,
         'ยืนยันการชำระเงินแล้ว' AS title,
         CONCAT('ชำระ ', FORMAT(sp.PaymentCost,0), ' บาท สำหรับ ', c.CourseName) AS message,
         'payment' AS type,
         sp.Created_at AS time
       FROM studentpayment sp
       JOIN enroll e ON e.EnrollId = sp.EnrollId
       JOIN courses c ON c.CourseID = e.CourseID
       WHERE e.UserId = ?
         AND sp.Status_Payment_Id = 2
         AND sp.Deleted_at IS NULL
       ORDER BY sp.Created_at DESC
       LIMIT 5`,
      [req.userId]
    );

    const all = [
      ...news.map(n => ({ ...n, source: 'news' })),
      ...schedules.map(s => ({ ...s, source: 'schedule' })),
      ...payments.map(p => ({ ...p, source: 'payment' })),
    ].sort((a, b) => new Date(b.time) - new Date(a.time));

    res.json(all);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
