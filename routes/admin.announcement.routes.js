const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ─── Multer Setup ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/news';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `news_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

// รับทั้ง coverImage (1 รูป) และ extraImages (หลายรูป)
const uploadFields = upload.fields([
  { name: 'coverImage', maxCount: 1 },
  { name: 'extraImages', maxCount: 10 },
]);

// ─── Helper: ลบไฟล์บนดิสก์ ───────────────────────────────────────────────────
function deleteFile(filePath) {
  if (!filePath) return;
  const abs = path.join(__dirname, '..', filePath);
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
}

// ─── GET /stats ───────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) AS total FROM news WHERE IsDeleted = 0'
    );
    const [[{ tutorCount }]] = await pool.query(
      "SELECT COUNT(*) AS tutorCount FROM news WHERE TargetAudience = 'tutor' AND IsDeleted = 0"
    );
    const [[{ studentCount }]] = await pool.query(
      "SELECT COUNT(*) AS studentCount FROM news WHERE TargetAudience = 'public' AND IsDeleted = 0"
    );
    res.json({ total, tutorCount, studentCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── GET / ── รายการข่าว (filter + search + pagination) ──────────────────────
router.get('/', async (req, res) => {
  try {
    const { search = '', category = '', target = '', page = 1, limit = 10 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = ['n.IsDeleted = 0'];

    if (search) {
      conditions.push('(n.Title LIKE ? OR n.Detail LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (category) { conditions.push('n.Category = ?'); params.push(category); }
    if (target)   { conditions.push('n.TargetAudience = ?'); params.push(target); }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM news n ${where}`, params
    );

    // ดึงรายการพร้อม extra images แบบ JSON array
    const [rows] = await pool.query(
        `SELECT n.*,
                GROUP_CONCAT(
                  IF(ni.ImagePath IS NOT NULL,
                     CONCAT(ni.ImageId, '||', ni.ImagePath, '||', ni.SortOrder),
                     NULL)
                  ORDER BY ni.SortOrder
                ) AS ExtraImages
         FROM news n
         LEFT JOIN news_images ni ON ni.NewsId = n.NewsId
         ${where}
         GROUP BY n.NewsId
         ORDER BY n.Created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, parseInt(limit), offset]
      );

    // Parse JSON string → array และกรอง null ออก
    const data = rows.map(r => ({
        ...r,
        ExtraImages: r.ExtraImages
          ? r.ExtraImages.split(',').map(item => {
              const [ImageId, ImagePath, SortOrder] = item.split('||');
              return { ImageId, ImagePath, SortOrder };
            })
          : [],
      }));

    res.json({
      data,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── POST / ── เพิ่มข่าวใหม่ ─────────────────────────────────────────────────
router.post('/', uploadFields, async (req, res) => {
  try {
    const { title, detail, category, targetAudience } = req.body;
    if (!title) return res.status(400).json({ message: 'Title is required' });

    const allowedTargets = ['tutor', 'public'];
    const safeTarget = allowedTargets.includes(targetAudience) ? targetAudience : 'public';

    // รูปหน้าปก
    const coverFile = req.files?.coverImage?.[0];
    const coverPath = coverFile ? `/uploads/news/${coverFile.filename}` : null;

    const [result] = await pool.query(
      `INSERT INTO news (Title, Detail, Image, Category, TargetAudience, IsDeleted, Created_at)
       VALUES (?, ?, ?, ?, ?, 0, NOW())`,
      [title, detail || null, coverPath, category || 'ข่าวประชาสัมพันธ์', safeTarget]
    );

    const newsId = result.insertId;

    // รูปเพิ่มเติม
    const extraFiles = req.files?.extraImages || [];
    if (extraFiles.length > 0) {
      const values = extraFiles.map((f, i) => [newsId, `/uploads/news/${f.filename}`, i]);
      await pool.query(
        'INSERT INTO news_images (NewsId, ImagePath, SortOrder) VALUES ?',
        [values]
      );
    }

    res.status(201).json({ message: 'Created', NewsId: newsId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ─── PUT /:id ── แก้ไขข่าว ───────────────────────────────────────────────────
router.put('/:id', uploadFields, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, detail, category, targetAudience, removedExtraImages } = req.body;
    // removedExtraImages: JSON string ของ array ImageId ที่ต้องการลบ

    const [existing] = await pool.query(
      'SELECT * FROM news WHERE NewsId = ? AND IsDeleted = 0', [id]
    );
    if (!existing.length) return res.status(404).json({ message: 'Not found' });

    const allowedTargets = ['tutor', 'public'];
    const safeTarget = allowedTargets.includes(targetAudience)
      ? targetAudience
      : existing[0].TargetAudience;

    // ── อัปเดตรูปหน้าปก ──
    let coverPath = existing[0].Image;
    const coverFile = req.files?.coverImage?.[0];
    if (coverFile) {
      deleteFile(coverPath); // ลบไฟล์เก่า
      coverPath = `/uploads/news/${coverFile.filename}`;
    }

    await pool.query(
      `UPDATE news SET Title=?, Detail=?, Image=?, Category=?, TargetAudience=?, Updated_at=NOW()
       WHERE NewsId=? AND IsDeleted=0`,
      [title, detail || null, coverPath, category || 'ข่าวประชาสัมพันธ์', safeTarget, id]
    );

    // ── ลบรูปเพิ่มเติมที่เลือกลบ ──
    if (removedExtraImages) {
      let ids = [];
      try { ids = JSON.parse(removedExtraImages); } catch {}
      if (ids.length > 0) {
        const [toDelete] = await pool.query(
          `SELECT ImagePath FROM news_images WHERE ImageId IN (?) AND NewsId = ?`,
          [ids, id]
        );
        toDelete.forEach(r => deleteFile(r.ImagePath));
        await pool.query(
          `DELETE FROM news_images WHERE ImageId IN (?) AND NewsId = ?`,
          [ids, id]
        );
      }
    }

    // ── เพิ่มรูปเพิ่มเติมใหม่ ──
    const extraFiles = req.files?.extraImages || [];
    if (extraFiles.length > 0) {
      // หา SortOrder ต่อท้ายของที่มีอยู่
      const [[{ maxOrder }]] = await pool.query(
        'SELECT IFNULL(MAX(SortOrder), -1) AS maxOrder FROM news_images WHERE NewsId = ?', [id]
      );
      const values = extraFiles.map((f, i) => [id, `/uploads/news/${f.filename}`, maxOrder + 1 + i]);
      await pool.query(
        'INSERT INTO news_images (NewsId, ImagePath, SortOrder) VALUES ?',
        [values]
      );
    }

    res.json({ message: 'Updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ─── DELETE /:id ── Soft Delete ───────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [existing] = await pool.query(
      'SELECT * FROM news WHERE NewsId = ? AND IsDeleted = 0', [id]
    );
    if (!existing.length) return res.status(404).json({ message: 'Not found' });

    await pool.query(
      'UPDATE news SET IsDeleted = 1, DeletedAt = NOW() WHERE NewsId = ?', [id]
    );
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;