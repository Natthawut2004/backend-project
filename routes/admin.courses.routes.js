const express = require('express');
const router = express.Router();
const { pool } = require('../db');
// const multer = require('multer');
// const path = require('path');

// const storage = multer.diskStorage({
//   destination: function (req, file, cb) {
//     cb(null, 'uploads/');
//   },
//   filename: function (req, file, cb) {
//     cb(null, Date.now() + path.extname(file.originalname));
//   }
// });
// const upload = multer({ storage });

const { uploadImage } = require('../middlewares/upload');

async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

router.get("/courses", async (req, res) => {
  try {
    const sql = `
      SELECT
        c.CourseID,
        c.CourseName,
        DATE_FORMAT(c.StartDate, '%Y-%m-%d') AS StartDate,
        DATE_FORMAT(c.LastDate, '%Y-%m-%d') AS LastDate,
        c.Price,
        c.Discount,
        c.FullCost,
        c.Installments,
        c.VideosFree,
        c.Remark,
        c.CourseImage,
        c.Status_Course_Id,
        c.Course_Availability_Id,
        c.Term_Id,
        c.Created_at,
        c.Updated_at,
        sc.Status_Course_Name,
        ca.Course_Availability_Name,
        t.Term_Name,
        GROUP_CONCAT(DISTINCT s.SubjectName ORDER BY s.SubjectId SEPARATOR ',') AS Subjects,
        COUNT(DISTINCT e.EnrollId) AS StudentCount
      FROM courses c
      LEFT JOIN status_course        sc ON sc.Status_Course_Id        = c.Status_Course_Id
      LEFT JOIN course_availability  ca ON ca.Course_Availability_Id  = c.Course_Availability_Id
      LEFT JOIN term                  t ON t.Term_Id                  = c.Term_Id
      LEFT JOIN tutorcoursedetails tcd ON tcd.CourseID = c.CourseID
      LEFT JOIN subjects s ON s.SubjectId = tcd.SubjectId
      LEFT JOIN enroll                e ON e.CourseID                 = c.CourseID
      WHERE c.Deleted_at IS NULL
      GROUP BY c.CourseID
      ORDER BY c.CourseID DESC
    `;
    const courses = await q(sql);
    res.json(courses);
  } catch (err) {
    console.error("[GET /courses]", err);
    res.status(500).json({ message: "ดึงข้อมูลคอร์สไม่สำเร็จ", error: err.message });
  }
});

router.get("/courses/:id", async (req, res) => {
  const { id } = req.params;
  try {
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
    const rows = await q(sql, [id]);
    if (!rows.length) return res.status(404).json({ message: "ไม่พบคอร์สนี้" });
    res.json(rows[0]);
  } catch (err) {
    console.error("[GET /courses/:id]", err);
    res.status(500).json({ message: "ดึงข้อมูลคอร์สไม่สำเร็จ", error: err.message });
  }
});

router.post("/courses", async (req, res) => {
  const {
    CourseName, StartDate, LastDate,
    Price, Discount, Installments, VideosFree,
    Remark, CourseImage,
    Status_Course_Id, Course_Availability_Id, Term_Id,
  } = req.body;

  if (!CourseName?.trim()) return res.status(400).json({ message: "กรุณากรอกชื่อคอร์ส" });
  if (!StartDate || !LastDate) return res.status(400).json({ message: "กรุณากรอกวันเริ่มและวันสิ้นสุด" });
  if (!Price || Number(Price) <= 0) return res.status(400).json({ message: "กรุณากรอกราคาคอร์ส" });

  try {
    const start = StartDate?.slice(0, 10);
    const end = LastDate?.slice(0, 10);
    const fullCost = Math.max(0, Number(Price) - Number(Discount || 0));

    const sql = `
      INSERT INTO courses
        (CourseName, StartDate, LastDate, Price, Discount, FullCost,
         Installments, VideosFree, Remark, CourseImage,
         Status_Course_Id, Course_Availability_Id, Term_Id, Created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `;
    const result = await q(sql, [
      CourseName.trim(), start, end,
      Number(Price), Number(Discount || 0), fullCost,
      Number(Installments || 1), Number(VideosFree || 0),
      Remark || null, CourseImage || null,
      Number(Status_Course_Id || 1),
      Course_Availability_Id ? Number(Course_Availability_Id) : null,
      Number(Term_Id || 1),
    ]);
    res.status(201).json({ message: "สร้างคอร์สสำเร็จ", CourseID: result.insertId });
  } catch (err) {
    console.error("[POST /courses]", err);
    res.status(500).json({ message: "สร้างคอร์สไม่สำเร็จ", error: err.message });
  }
});

router.put("/courses/:id", async (req, res) => {
  const { id } = req.params;
  const {
    CourseName, StartDate, LastDate,
    Price, Discount, Installments, VideosFree,
    Remark, CourseImage,
    Status_Course_Id, Course_Availability_Id, Term_Id,
  } = req.body;

  if (!CourseName?.trim()) return res.status(400).json({ message: "กรุณากรอกชื่อคอร์ส" });

  try {
    const exists = await q("SELECT CourseID FROM courses WHERE CourseID = ? AND Deleted_at IS NULL", [id]);
    if (!exists.length) return res.status(404).json({ message: "ไม่พบคอร์สนี้" });

    const start = StartDate?.slice(0, 10);
    const end = LastDate?.slice(0, 10);
    const fullCost = Math.max(0, Number(Price) - Number(Discount || 0));

    const sql = `
      UPDATE courses SET
        CourseName            = ?,
        StartDate             = ?,
        LastDate              = ?,
        Price                 = ?,
        Discount              = ?,
        FullCost              = ?,
        Installments          = ?,
        VideosFree            = ?,
        Remark                = ?,
        CourseImage           = ?,
        Status_Course_Id      = ?,
        Course_Availability_Id = ?,
        Term_Id               = ?,
        Updated_at            = NOW()
      WHERE CourseID = ?
    `;
    await q(sql, [
      CourseName.trim(), start, end,
      Number(Price), Number(Discount || 0), fullCost,
      Number(Installments || 1), Number(VideosFree || 0),
      Remark || null, CourseImage || null,
      Number(Status_Course_Id || 1),
      Course_Availability_Id ? Number(Course_Availability_Id) : null,
      Number(Term_Id || 1),
      id,
    ]);
    res.json({ message: "แก้ไขคอร์สสำเร็จ" });
  } catch (err) {
    console.error("[PUT /courses/:id]", err);
    res.status(500).json({ message: "แก้ไขคอร์สไม่สำเร็จ", error: err.message });
  }
});

router.patch("/courses/:id/status", async (req, res) => {
  const { id } = req.params;
  const { Status_Course_Id } = req.body;
  if (!Status_Course_Id) return res.status(400).json({ message: "กรุณาระบุ Status_Course_Id" });
  try {
    await q(
      "UPDATE courses SET Status_Course_Id = ?, Updated_at = NOW() WHERE CourseID = ? AND Deleted_at IS NULL",
      [Number(Status_Course_Id), id]
    );
    res.json({ message: "อัปเดตสถานะสำเร็จ" });
  } catch (err) {
    console.error("[PATCH /courses/:id/status]", err);
    res.status(500).json({ message: "อัปเดตสถานะไม่สำเร็จ", error: err.message });
  }
});

router.delete("/courses/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const exists = await q("SELECT CourseID FROM courses WHERE CourseID = ? AND Deleted_at IS NULL", [id]);
    if (!exists.length) return res.status(404).json({ message: "ไม่พบคอร์สนี้" });

    const enrolled = await q("SELECT COUNT(*) AS cnt FROM enroll WHERE CourseID = ?", [id]);
    if (enrolled[0].cnt > 0) {
      return res.status(409).json({
        message: `ไม่สามารถลบได้ เนื่องจากมีนักเรียนลงทะเบียนแล้ว ${enrolled[0].cnt} คน`,
      });
    }

    await q("DELETE FROM tutorcoursedetails WHERE CourseID = ?", [id]);
    
    await q("UPDATE courses SET Deleted_at = NOW() WHERE CourseID = ?", [id]);
    res.json({ message: "ลบคอร์สสำเร็จ" });
  } catch (err) {
    console.error("[DELETE /courses/:id]", err);
    res.status(500).json({ message: "ลบคอร์สไม่สำเร็จ", error: err.message });
  }
});

router.get("/status-course", async (_req, res) => {
  try {
    const rows = await q(
      "SELECT Status_Course_Id, Status_Course_Name FROM status_course WHERE Deleted_at IS NULL ORDER BY Status_Course_Id"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/course-availability", async (_req, res) => {
  try {
    const rows = await q(
      "SELECT Course_Availability_Id, Course_Availability_Name FROM course_availability WHERE Deleted_at IS NULL ORDER BY Course_Availability_Id"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/term", async (_req, res) => {
  try {
    const rows = await q(
      "SELECT Term_Id, Term_Name FROM term WHERE Deleted_at IS NULL ORDER BY Term_Id"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/courses/:id/duplicate", async (req, res) => {
  const { id } = req.params;
  try {
    const rows = await q("SELECT * FROM courses WHERE CourseID = ? AND Deleted_at IS NULL", [id]);
    if (!rows.length) return res.status(404).json({ message: "ไม่พบคอร์สนี้" });
    const c = rows[0];
    const result = await q(`
      INSERT INTO courses
        (CourseName, StartDate, LastDate, Price, Discount, FullCost,
         Installments, VideosFree, Remark, CourseImage,
         Status_Course_Id, Term_Id, Created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW())
    `, [
      `${c.CourseName} (สำเนา)`,
      String(c.StartDate).slice(0, 10),
      String(c.LastDate).slice(0, 10),
      c.Price, c.Discount, c.FullCost,
      c.Installments, c.VideosFree,
      c.Remark, c.CourseImage,
      c.Term_Id,
    ]);
    res.status(201).json({ message: "ทำสำเนาคอร์สสำเร็จ", CourseID: result.insertId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// router.post("/upload/image", upload.single("image"), (req, res) => {
//   if (!req.file) return res.status(400).json({ message: "ไม่พบไฟล์" });
//   res.json({ path: `/uploads/${req.file.filename}` });
// });

router.post("/upload/image", uploadImage.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "ไม่พบไฟล์" });
  res.json({ path: req.file.path });  // req.file.path คือ URL เต็มจาก Cloudinary
});

// ดึงวิชาทั้งหมด
router.get("/subjects", async (_req, res) => {
  try {
    const rows = await q("SELECT SubjectId, SubjectName FROM subjects ORDER BY SubjectId");
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ดึงวิชา+ติวเตอร์ที่ผูกกับคอร์สนี้
router.get("/courses/:id/subjects", async (req, res) => {
  try {
    const rows = await q(`
      SELECT tcd.TutorCourseDetailId, tcd.SubjectId, tcd.AdminId, tcd.TotalHours,
             s.SubjectName, a.Nickname, a.Firstname, a.Lastname
      FROM tutorcoursedetails tcd
      LEFT JOIN subjects s ON s.SubjectId = tcd.SubjectId
      LEFT JOIN admin a ON a.AdminId = tcd.AdminId
      WHERE tcd.CourseID = ?
      ORDER BY tcd.TutorCourseDetailId
    `, [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// เพิ่มวิชาในคอร์ส
router.post("/courses/:id/subjects", async (req, res) => {
  const { SubjectId, AdminId, TotalHours } = req.body;
  if (!SubjectId || !AdminId) return res.status(400).json({ message: "กรุณาระบุวิชาและติวเตอร์" });
  try {
    const result = await q(
      "INSERT INTO tutorcoursedetails (AdminId, CourseID, SubjectId, TotalHours) VALUES (?, ?, ?, ?)",
      [Number(AdminId), Number(req.params.id), Number(SubjectId), Number(TotalHours || 0)]
    );
    res.status(201).json({ message: "เพิ่มวิชาสำเร็จ", TutorCourseDetailId: result.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ลบวิชาออกจากคอร์ส
router.delete("/tutorcoursedetails/:id", async (req, res) => {
  try {
    await q("DELETE FROM tutorcoursedetails WHERE TutorCourseDetailId = ?", [req.params.id]);
    res.json({ message: "ลบวิชาสำเร็จ" });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;