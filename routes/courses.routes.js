// routes/courses.routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// GET /courses (รองรับการกรองด้วย adminId และแยกรายวิชา)
router.get('/', async (req, res) => {
  try {
    const { termId, statusId, availabilityId, adminId } = req.query;
    const where = [];
    const params = [];

    if (termId) { where.push('c.Term_Id = ?'); params.push(Number(termId)); }
    if (statusId) { where.push('c.Status_Course_Id = ?'); params.push(Number(statusId)); }
    if (availabilityId) { where.push('c.Course_Availability_Id = ?'); params.push(Number(availabilityId)); }

    if (adminId) {
      where.push('tcd.AdminId = ?');
      params.push(Number(adminId));

      const sql = `
        SELECT
          c.CourseID, 
          CONCAT(c.CourseName, ' (', s.SubjectName, ')') AS CourseName, 
          c.StartDate, 
          c.LastDate, 
          c.Status_Course_Id,
          s.SubjectId,
          (SELECT COUNT(*) FROM enroll e WHERE e.CourseID = c.CourseID) AS StudentCount,
          (SELECT COUNT(*) FROM course_videos cv 
           WHERE cv.CourseID = c.CourseID AND cv.SubjectId = s.SubjectId) AS VideoCount,
          (SELECT COUNT(*) FROM course_files cf 
           WHERE cf.CourseID = c.CourseID AND cf.SubjectId = s.SubjectId) AS FileCount,
          tcd.TotalHours AS TotalHoursScheduled,
          COALESCE((
            SELECT SUM(TIMESTAMPDIFF(MINUTE, cs.StartDateTime, cs.EndDateTime)) / 60
            FROM (SELECT DISTINCT CourseScheduleDetailId FROM tutorcheckin) tc
            JOIN coursescheduledetails csd ON tc.CourseScheduleDetailId = csd.CourseScheduleDetailId
            JOIN courseschedule cs ON csd.CourseScheduleId = cs.CourseScheduleId
            WHERE csd.CourseID = c.CourseID AND csd.SubjectId = s.SubjectId AND csd.AdminId = tcd.AdminId
          ), 0) AS CompletedHours
        FROM courses c
        JOIN tutorcoursedetails tcd ON c.CourseID = tcd.CourseID
        JOIN subjects s ON tcd.SubjectId = s.SubjectId
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY c.CourseID, s.SubjectId, tcd.AdminId, c.CourseName, s.SubjectName,
         c.StartDate, c.LastDate, c.Status_Course_Id, tcd.TotalHours
        ORDER BY c.CourseID DESC
      `;

      const [rows] = await pool.query(sql, params);
      return res.json(rows);
    }

    const sqlAdmin = `
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
    const [rowsAdmin] = await pool.query(sqlAdmin, params);
    res.json(rowsAdmin);

  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ★ เพิ่ม: GET /courses/:id — คอร์สเดี่ยว สำหรับหน้ารายละเอียดคอร์สฝั่งนักเรียน (public)
// ใช้ join ชุดเดียวกับ router ฝั่งแอดมิน เพื่อให้ Status_Course_Name / Term_Name /
// Course_Availability_Name มาครบ จะได้ตัดสินใจ badge/ปุ่มปิดรับสมัครได้ตรงกัน
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid Course ID' });

    const sql = `
      SELECT
        c.*,
        DATE_FORMAT(c.StartDate, '%Y-%m-%d') AS StartDate,
        DATE_FORMAT(c.LastDate, '%Y-%m-%d') AS LastDate,
        sc.Status_Course_Name,
        ca.Course_Availability_Name,
        t.Term_Name,
        COUNT(DISTINCT e.EnrollId) AS StudentCount
      FROM courses c
      LEFT JOIN status_course        sc ON sc.Status_Course_Id        = c.Status_Course_Id
      LEFT JOIN course_availability  ca ON ca.Course_Availability_Id  = c.Course_Availability_Id
      LEFT JOIN term                  t ON t.Term_Id                  = c.Term_Id
      LEFT JOIN enroll                e ON e.CourseID                 = c.CourseID
      WHERE c.CourseID = ? AND c.Deleted_at IS NULL
      GROUP BY c.CourseID
    `;
    const [rows] = await pool.query(sql, [id]);
    if (!rows.length) return res.status(404).json({ message: 'ไม่พบคอร์สนี้' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[GET /courses/:id]', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ★ เพิ่ม: GET /courses/:id/subjects — วิชา+ติวเตอร์+ชั่วโมง สำหรับหน้าคอร์ส (public,
// เหมือน endpoint ของแอดมินแต่ตัด AdminId ทิ้งเพราะไม่จำเป็นต้องโชว์ฝั่ง public)
router.get('/:id/subjects', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid Course ID' });

    const [rows] = await pool.query(`
      SELECT tcd.TutorCourseDetailId, tcd.SubjectId, tcd.TotalHours,
             s.SubjectName, a.Nickname, a.Firstname, a.Lastname
      FROM tutorcoursedetails tcd
      LEFT JOIN subjects s ON s.SubjectId = tcd.SubjectId
      LEFT JOIN admin a ON a.AdminId = tcd.AdminId
      WHERE tcd.CourseID = ?
      ORDER BY tcd.TutorCourseDetailId
    `, [id]);
    res.json(rows);
  } catch (e) {
    console.error('[GET /courses/:id/subjects]', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ★ เพิ่ม: GET /courses/:id/preview-videos — คลิปตัวอย่างของคอร์ส (public)
// ⚠️ ชื่อตาราง "course_preview_videos" เป็นการเดาจากคอลัมน์ที่หน้าแอดมินส่งไป
// (VideoTitle, VideoUrl, VideoType, Thumbnail, Duration, AdminId) — กรุณาตรวจสอบ
// ชื่อตารางจริงจาก router ที่รับ POST /admin/courses/:id/preview-videos ก่อนใช้งาน
router.get('/:id/preview-videos', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid Course ID' });

    const [rows] = await pool.query(`
      SELECT VideoId, VideoTitle, VideoUrl, VideoType, Thumbnail, Duration
      FROM course_preview_videos
      WHERE CourseID = ?
      ORDER BY VideoId
    `, [id]);
    res.json(rows);
  } catch (e) {
    console.error('[GET /courses/:id/preview-videos]', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// ★ เพิ่ม: GET /courses/:id/schedule — วันเรียน/เวลาเรียนของแต่ละวิชาในคอร์ส (public)
// อิงจาก courseschedule.StartDateTime/EndDateTime ที่ใช้จริงในไฟล์นี้อยู่แล้ว
// (ดู CompletedHours query ด้านบน) — ดึงวัน-เวลาที่ไม่ซ้ำกันของแต่ละวิชา
router.get('/:id/schedule', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Invalid Course ID' });

    const [rows] = await pool.query(`
      SELECT DISTINCT
        csd.SubjectId,
        DAYOFWEEK(cs.StartDateTime) - 1 AS DayOfWeek,
        TIME_FORMAT(cs.StartDateTime, '%H:%i') AS StartTime,
        TIME_FORMAT(cs.EndDateTime, '%H:%i') AS EndTime
      FROM coursescheduledetails csd
      JOIN courseschedule cs ON csd.CourseScheduleId = cs.CourseScheduleId
      WHERE csd.CourseID = ?
      ORDER BY DayOfWeek, StartTime
    `, [id]);
    res.json(rows);
  } catch (e) {
    console.error('[GET /courses/:id/schedule]', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /courses/:id/students
router.get('/:id/students', async (req, res) => {
  try {
    const courseId = Number(req.params.id);

    if (isNaN(courseId)) {
      return res.status(400).json({
        message: 'Invalid Course ID: ค่าที่ส่งมาไม่ใช่ตัวเลข',
        received: req.params.id
      });
    }

    const [courseCheck] = await pool.query(
      'SELECT CourseName FROM courses WHERE CourseID = ?',
      [courseId]
    );

    if (!courseCheck.length) {
      return res.status(404).json({ message: 'ไม่พบคอร์สที่ระบุ' });
    }

    const sql = `
      SELECT 
        u.*,
        e.EnrollId,
        e.Status_Enroll_Id,
        gl.GradeDetail,

        (
          SELECT COUNT(*)
          FROM tutorcheckin tc
          JOIN coursescheduledetails csd ON tc.CourseScheduleDetailId = csd.CourseScheduleDetailId
          LEFT JOIN studentattendance sa 
            ON sa.CourseScheduleDetailId = tc.CourseScheduleDetailId
            AND sa.UserId = u.UserId
          WHERE csd.CourseID = e.CourseID
            AND sa.Status = '1'
        ) AS TotalAttended,

        (
          SELECT COUNT(DISTINCT tc.CourseScheduleDetailId)
          FROM tutorcheckin tc
          JOIN coursescheduledetails csd ON tc.CourseScheduleDetailId = csd.CourseScheduleDetailId
          WHERE csd.CourseID = e.CourseID
        ) AS TotalClassHeld

      FROM enroll e
      JOIN users u ON e.UserId = u.UserId
      LEFT JOIN gradelevel gl ON u.GradeLevelId = gl.GradeLevelId
      WHERE e.CourseID = ?
    `;

    const [students] = await pool.query(sql, [courseId]);

    res.json({
      courseInfo: {
        id: courseId,
        name: courseCheck[0].CourseName,
        studentCount: students.length
      },
      students: students.map(std => ({
        ...std,
        name: `${std.GenderId === 2 ? 'ด.ญ.' : std.GenderId === 1 ? 'ด.ช.' : ''}${std.Firstname || ''} ${std.Lastname || ''}${std.Nickname ? ` (${std.Nickname})` : ''}`,
        lineId: std.LineID || 'ไม่มี Line ID',
        gradeLevel: std.GradeDetail || 'ไม่ระบุชั้น',
        gpa: std.GPA ?? '-',
        birthDate: std.BirthOfDate ?? null,
        totalAttended: std.TotalAttended ?? 0,
        totalClassHeld: std.TotalClassHeld ?? 0,
      }))
    });

  } catch (e) {
    console.error('Error in GET /courses/:id/students:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

//  NEW: GET /courses/:id/students/:studentId/videos
//  รายการคลิปในคอร์ส + สถานะว่านักเรียนดูแล้ว/ยังไม่ดู
router.get('/:id/students/:studentId/videos', async (req, res) => {
  try {
    const courseId = Number(req.params.id);
    const studentId = Number(req.params.studentId);

    if (isNaN(courseId) || isNaN(studentId)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    const sql = `
      SELECT
        cv.VideoId,
        cv.VideoTitle                                         AS title,
        cv.Duration                                           AS durationSec,
        s.SubjectName                                         AS subject,
        CASE WHEN vv.VideoId IS NOT NULL THEN 1 ELSE 0 END   AS watched,
        vv.WatchedAt                                          AS watchedAt,
        COALESCE(vv.Progress, 0)                             AS progress
      FROM course_videos cv
      JOIN subjects s ON cv.SubjectId = s.SubjectId
      LEFT JOIN video_views vv
        ON  vv.VideoId = cv.VideoId
        AND vv.UserId  = ?
      WHERE cv.CourseID = ?
      ORDER BY cv.VideoId ASC
    `;

    const [rows] = await pool.query(sql, [studentId, courseId]);

    const result = rows.map(r => ({
      id: r.VideoId,
      title: r.title,
      duration: r.durationSec ? `${Math.round(r.durationSec / 60)} นาที` : '-',
      subject: r.subject,
      watched: r.watched === 1,
      watchedAt: r.watchedAt ? r.watchedAt.toISOString().slice(0, 10) : null,
      progress: r.progress ?? 0,
    }));

    res.json(result);
  } catch (e) {
    console.error('Error in GET /courses/:id/students/:studentId/videos:', e);
    res.status(500).json({ message: 'Server error' });
  }
});


// POST /courses
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.CourseName) return res.status(400).json({ message: 'CourseName is required' });

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
      `INSERT INTO courses (
        CourseName, StartDate, LastDate, Remark,
        Price, Discount, FullCost, Installments, VideosFree,
        Created_at, Updated_at, Deleted_at,
        Status_Course_Id, Course_Availability_Id, Term_Id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NULL, NULL, ?, ?, ?)`,
      [
        payload.CourseName, payload.StartDate, payload.LastDate, payload.Remark,
        payload.Price, payload.Discount, payload.FullCost, payload.Installments, payload.VideosFree,
        payload.Status_Course_Id, payload.Course_Availability_Id, payload.Term_Id
      ]
    );

    res.status(201).json({ CourseID: result.insertId, ...payload });
  } catch (e) {
    console.error(e);
    if (String(e.message || '').includes('foreign key constraint fails')) {
      return res.status(400).json({ message: 'ตรวจสอบข้อมูลในตารางแม่ (Foreign Key)' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /courses/:id
router.put('/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    const [oldRows] = await conn.query('SELECT CourseID FROM courses WHERE CourseID = ?', [id]);
    if (!oldRows.length) return res.status(404).json({ message: 'Not found' });

    const b = req.body || {};
    await conn.query(
      `UPDATE courses SET
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
      WHERE CourseID = ?`,
      [
        b.CourseName ?? null, b.StartDate ?? null, b.LastDate ?? null, b.Remark ?? null,
        b.Price != null ? Number(b.Price) : null,
        b.Discount != null ? Number(b.Discount) : null,
        b.FullCost != null ? Number(b.FullCost) : null,
        b.Installments != null ? Number(b.Installments) : null,
        b.VideosFree != null ? Number(b.VideosFree) : null,
        b.Status_Course_Id != null ? Number(b.Status_Course_Id) : null,
        b.Course_Availability_Id != null ? Number(b.Course_Availability_Id) : null,
        b.Term_Id != null ? Number(b.Term_Id) : null,
        id
      ]
    );

    res.json({ message: 'Updated' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
});


// DELETE /courses/:id
router.delete('/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    const [rows] = await conn.query('SELECT CourseID FROM courses WHERE CourseID = ?', [id]);
    if (!rows.length) return res.status(404).json({ message: 'Not found' });

    await conn.query('DELETE FROM courses WHERE CourseID = ?', [id]);
    res.json({ message: 'Deleted' });
  } catch (e) {
    console.error(e);
    if (String(e.message || '').includes('foreign key constraint fails')) {
      return res.status(409).json({ message: 'ไม่สามารถลบได้เนื่องจากมีข้อมูลนักเรียนลงทะเบียนอยู่' });
    }
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
});

// GET /courses/:courseId/students/:studentId/attendance
router.get('/:courseId/students/:studentId/attendance', async (req, res) => {
  try {
    const { courseId, studentId } = req.params

    const [rows] = await pool.query(
      `SELECT 
        sa.Status,
        DATE(tc.Created_at) as date,
        s.SubjectName as subject,
        TIME_FORMAT(cs.StartTime, '%H:%i') as startTime,
        TIME_FORMAT(cs.EndTime, '%H:%i') as endTime
      FROM studentattendance sa
      JOIN tutorcheckin tc 
        ON sa.CourseScheduleDetailId = tc.CourseScheduleDetailId
        AND DATE(tc.Created_at) = DATE(sa.Created_at)
      JOIN coursescheduledetails csd 
        ON sa.CourseScheduleDetailId = csd.CourseScheduleDetailId
      JOIN courseschedule cs 
        ON csd.CourseScheduleId = cs.CourseScheduleId
      LEFT JOIN subjects s 
        ON csd.SubjectId = s.SubjectId
      WHERE sa.UserId = ?
        AND csd.CourseID = ?
      ORDER BY tc.Created_at DESC`,
      [studentId, courseId]
    )

    const result = rows.map(row => ({
      date: row.date instanceof Date 
        ? `${row.date.getFullYear()}-${String(row.date.getMonth()+1).padStart(2,'0')}-${String(row.date.getDate()).padStart(2,'0')}`
        : String(row.date),
      subject: row.subject || 'ไม่ระบุวิชา',
      status: row.Status == 1 ? 'present' : 'absent',
      startTime: row.startTime,
      endTime: row.endTime,
    }))

    res.json(result)
  } catch (e) {
    console.error('attendance error:', e)
    res.status(500).json({ message: 'Server error' })
  }
})

module.exports = router;