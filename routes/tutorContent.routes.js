const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// --- ตั้งค่า multer ---
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// 1. GET: ดึงข้อมูล
router.get('/', async (req, res) => {
  try {
    const { courseId, subjectId } = req.query;
    const [videos] = await pool.query(
      `SELECT VideoId, VideoTitle, VideoUrl, Duration, 
       DATE_FORMAT(Created_at, '%d %b %Y') as date 
       FROM course_videos WHERE CourseID = ? AND SubjectId = ? ORDER BY Created_at DESC`,
      [Number(courseId), Number(subjectId)]
    );
    const [files] = await pool.query(
      `SELECT FileId, FileName, FilePath, FileSize, 
       DATE_FORMAT(Created_at, '%d %b %Y') as date 
       FROM course_files WHERE CourseID = ? AND SubjectId = ? ORDER BY Created_at DESC`,
      [Number(courseId), Number(subjectId)]
    );
    res.json({ videos, files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. POST: เพิ่มวิดีโอ
router.post('/video', async (req, res) => {
  try {
    const { CourseID, SubjectId, AdminId, VideoTitle, VideoUrl, Duration } = req.body;
    await pool.query(
      `INSERT INTO course_videos (CourseID, SubjectId, AdminId, VideoTitle, VideoUrl, Duration, Created_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [CourseID, SubjectId, AdminId, VideoTitle, VideoUrl, Duration]
    );
    res.status(201).json({ message: 'Success' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. PUT: แก้ไขวิดีโอ
router.put('/video/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { VideoTitle, VideoUrl, Duration } = req.body;
    const [check] = await pool.query('SELECT VideoId FROM course_videos WHERE VideoId = ?', [id]);
    if (!check.length) return res.status(404).json({ message: 'ไม่พบวิดีโอที่ต้องการแก้ไข' });
    await pool.query(
      `UPDATE course_videos SET VideoTitle = ?, VideoUrl = ?, Duration = ?, Updated_at = NOW() WHERE VideoId = ?`,
      [VideoTitle, VideoUrl, Duration || null, id]
    );
    res.json({ message: 'แก้ไขวิดีโอเรียบร้อยแล้ว' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. POST: อัปโหลดไฟล์ใหม่
// ✅ รองรับ DisplayName — ถ้าส่งมาจะใช้เป็นชื่อที่แสดง ไม่งั้นใช้ชื่อไฟล์จากเครื่อง
router.post('/file', upload.single('file'), async (req, res) => {
  try {
    const { CourseID, SubjectId, AdminId, DisplayName } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ message: 'No file uploaded' });

    const fileName = DisplayName?.trim() || file.originalname;
    const fileSize = (file.size / (1024 * 1024)).toFixed(2) + ' MB';

    await pool.query(
      `INSERT INTO course_files (CourseID, SubjectId, AdminId, FileName, FilePath, FileSize, Created_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [CourseID, SubjectId, AdminId, fileName, `/uploads/${file.filename}`, fileSize]
    );
    res.status(201).json({ message: 'Success' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. PUT: แก้ไขไฟล์เอกสาร
// ✅ รองรับ 2 กรณี:
//    - ส่งแค่ FileName → แก้เฉพาะชื่อที่แสดง
//    - ส่งไฟล์ใหม่ (+ FileName ถ้าอยากตั้งชื่อใหม่) → อัปไฟล์ใหม่แทนของเดิม + ลบไฟล์เก่าออก disk
router.put('/file/:id', upload.single('file'), async (req, res) => {
  try {
    const id = req.params.id;
    const { FileName } = req.body;
    const newFile = req.file;

    const [rows] = await pool.query('SELECT FileId, FilePath FROM course_files WHERE FileId = ?', [id]);
    if (!rows.length) return res.status(404).json({ message: 'ไม่พบไฟล์ที่ต้องการแก้ไข' });

    if (newFile) {
      // กรณีอัปไฟล์ใหม่แทนของเดิม
      const displayName = FileName?.trim() || newFile.originalname;
      const fileSize = (newFile.size / (1024 * 1024)).toFixed(2) + ' MB';

      await pool.query(
        `UPDATE course_files SET FileName = ?, FilePath = ?, FileSize = ?, Updated_at = NOW() WHERE FileId = ?`,
        [displayName, `/uploads/${newFile.filename}`, fileSize, id]
      );

      // ลบไฟล์เก่าออกจาก disk
      const oldPath = path.join(__dirname, '..', rows[0].FilePath);
      fs.unlink(oldPath, (err) => {
        if (err) console.warn(`ลบไฟล์เก่าไม่สำเร็จ: ${oldPath}`, err.message);
      });
    } else {
      // กรณีแก้แค่ชื่อที่แสดง
      if (!FileName?.trim()) return res.status(400).json({ message: 'กรุณาระบุชื่อไฟล์' });
      await pool.query(
        `UPDATE course_files SET FileName = ?, Updated_at = NOW() WHERE FileId = ?`,
        [FileName.trim(), id]
      );
    }

    res.json({ message: 'แก้ไขไฟล์เรียบร้อยแล้ว' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. DELETE: ลบวิดีโอ
router.delete('/video/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [result] = await pool.query('DELETE FROM course_videos WHERE VideoId = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'ไม่พบวิดีโอที่ต้องการลบ' });
    res.json({ message: 'ลบวิดีโอเรียบร้อยแล้ว' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7. DELETE: ลบไฟล์เอกสาร + ลบไฟล์จริงออกจาก disk
router.delete('/file/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [rows] = await pool.query('SELECT FilePath FROM course_files WHERE FileId = ?', [id]);
    if (!rows.length) return res.status(404).json({ message: 'ไม่พบไฟล์ที่ต้องการลบ' });

    await pool.query('DELETE FROM course_files WHERE FileId = ?', [id]);

    const absolutePath = path.join(__dirname, '..', rows[0].FilePath);
    fs.unlink(absolutePath, (err) => {
      if (err) console.warn(`ลบไฟล์ไม่สำเร็จ: ${absolutePath}`, err.message);
    });

    res.json({ message: 'ลบไฟล์เรียบร้อยแล้ว' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 8. POST: บันทึก Video Progress
router.post('/video-progress', async (req, res) => {
  try {
    const { userId, videoId, watchPercent, lastWatchTime } = req.body;
    const [existing] = await pool.query(
      'SELECT StudentVideoProgressId FROM studentvideoprogress WHERE UserId = ? AND VideoId = ?',
      [userId, videoId]
    );
    if (existing.length > 0) {
      await pool.query(
        `UPDATE studentvideoprogress 
         SET WatchPercent = ?, LastWatchTime = ?, WatchDate = CURDATE(), Updated_at = NOW()
         WHERE UserId = ? AND VideoId = ?`,
        [watchPercent, lastWatchTime, userId, videoId]
      );
    } else {
      await pool.query(
        `INSERT INTO studentvideoprogress 
         (UserId, VideoId, WatchPercent, LastWatchTime, WatchDate, WatchRound, Created_at)
         VALUES (?, ?, ?, ?, CURDATE(), 1, NOW())`,
        [userId, videoId, watchPercent, lastWatchTime]
      );
    }
    res.json({ message: 'บันทึก progress สำเร็จ' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;