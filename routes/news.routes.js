const express = require('express');
const router = express.Router();
const { pool } = require('../db'); 

// GET /api/news (ดึงข้อมูลข่าวทั้งหมด)
router.get('/', async (req, res) => {
  try {
    const sql = `
      SELECT 
        NewsId, 
        Title, 
        Detail, 
        Image, 
        Category, 
        TargetAudience, 
        Created_at 
      FROM news 
      ORDER BY Created_at DESC
    `;

    const [rows] = await pool.query(sql);

    // แปลงข้อมูลจาก Format ใน DB ให้ตรงกับที่ TutorMain.jsx ใช้งาน
    const formattedNews = rows.map(item => ({
      id: item.NewsId,
      title: item.Title,
      sub: item.Detail,      // ใน React ใช้ item.sub
      img: item.Image,      // ใน React ใช้ item.img
      tag: item.Category,    // ใน React ใช้ item.tag
      type: item.TargetAudience, // ใน React ใช้ n.type ในการ filter ('public' หรือ 'tutor')
      date: item.Created_at ? new Date(item.Created_at).toLocaleDateString('th-TH') : ''
    }));

    res.json(formattedNews);

  } catch (e) {
    console.error('Error fetching news:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/news/:id (ดึงข่าวรายชิ้น)
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sql = `SELECT * FROM news WHERE NewsId = ?`;
    
    const [rows] = await pool.query(sql, [id]);

    if (!rows.length) {
      return res.status(404).json({ message: 'News not found' });
    }

    // แปลงข้อมูลเหมือนด้านบน
    const item = rows[0];
    res.json({
      id: item.NewsId,
      title: item.Title,
      sub: item.Detail,
      img: item.Image,
      tag: item.Category,
      type: item.TargetAudience,
      date: new Date(item.Created_at).toLocaleDateString('th-TH')
    });

  } catch (e) {
    console.error('Error fetching news item:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;