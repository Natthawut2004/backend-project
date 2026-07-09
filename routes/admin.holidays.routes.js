const express = require('express');
const router  = express.Router();
const { pool } = require('../db');

async function q(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows;
}

// GET /api/admin/holidays?year=2026
router.get('/', async (req, res) => {
    try {
        const year = req.query.year || new Date().getFullYear();
        const rows = await q(
            `SELECT HolidayId, HolidayDate, Name, Created_at
             FROM holidays
             WHERE YEAR(HolidayDate) = ?
             ORDER BY HolidayDate`,
            [year]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /api/admin/holidays
router.post('/', async (req, res) => {
    const { HolidayDate, Name, AdminId } = req.body;
    if (!HolidayDate || !Name) {
        return res.status(400).json({ message: 'กรุณาระบุ HolidayDate และ Name' });
    }
    try {
        const result = await q(
            `INSERT INTO holidays (HolidayDate, Name, Created_by)
             VALUES (?, ?, ?)`,
            [HolidayDate, Name, AdminId || null]
        );
        res.status(201).json({ HolidayId: result.insertId, HolidayDate, Name });
    } catch (err) {
        // duplicate key = วันนี้มีอยู่แล้ว
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: `วันที่ ${HolidayDate} มีอยู่ในระบบแล้ว` });
        }
        res.status(500).json({ message: err.message });
    }
});

// DELETE /api/admin/holidays/:id
router.delete('/:id', async (req, res) => {
    try {
        await q(`DELETE FROM holidays WHERE HolidayId = ?`, [req.params.id]);
        res.json({ message: 'ลบสำเร็จ' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;