const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// GET /api/news?role=tutor  หรือ  /api/news?role=student
router.get('/', async (req, res) => {
  try {
    const { role } = req.query;

    // ✅ tutor / admin  → เห็นข่าวของติวเตอร์ (tutor) + ข่าวสาธารณะ (public)
    // ✅ student / user → เห็นแค่ข่าวสาธารณะ (public)
    // ✅ ผู้ใช้ทั่วไปที่ไม่ได้ล็อกอิน (ไม่ส่ง role มา หรือ role ไม่ตรงกับที่กำหนด)
    //    → ถือเป็น public เห็นแค่ข่าวสาธารณะเช่นกัน
    const audienceMap = {
      tutor:   ['tutor', 'public'],
      admin:   ['tutor', 'public'],
      student: ['public'],
      user:    ['public'],
      public:  ['public'],
    };

    // default เป็น public เสมอถ้าไม่มี role หรือ role ที่ส่งมาไม่ตรงกับที่กำหนดไว้
    // (เช่น guest ที่ไม่ได้ล็อกอิน)
    const allowed = audienceMap[role] || audienceMap.public;

    const placeholders = allowed.map(() => '?').join(', ');
    const sql = `
      SELECT NewsId, Title, Detail, Image, Category, TargetAudience, Created_at
      FROM news
      WHERE TargetAudience IN (${placeholders})
        AND IsDeleted = 0
      ORDER BY Created_at DESC
    `;

    const [rows] = await pool.query(sql, allowed);

    const formattedNews = rows.map(item => ({
      id:    item.NewsId,
      title: item.Title,
      sub:   item.Detail,
      img:   item.Image,
      tag:   item.Category,
      type:  item.TargetAudience,
      date:  item.Created_at
        ? new Date(item.Created_at).toLocaleDateString('th-TH')
        : '',
    }));

    res.json(formattedNews);
  } catch (e) {
    console.error('Error fetching news:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/news/:id — ดึงข่าวรายชิ้น
// GET /api/news/:id
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query(
      'SELECT * FROM news WHERE NewsId = ? AND IsDeleted = 0',
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: 'News not found' });

    const item = rows[0];

    // ดึงรูปเพิ่มเติม
    const [extraImages] = await pool.query(
      'SELECT ImageId, ImagePath, SortOrder FROM news_images WHERE NewsId = ? ORDER BY SortOrder',
      [id]
    );

    res.json({
      id:          item.NewsId,
      title:       item.Title,
      sub:         item.Detail,
      img:         item.Image,
      tag:         item.Category,
      type:        item.TargetAudience,
      date:        new Date(item.Created_at).toLocaleDateString('th-TH'),
      extraImages, // [{ImageId, ImagePath, SortOrder}]
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;