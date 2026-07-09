const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db'); // ตรวจสอบ path ให้ถูกต้อง
const router = express.Router();

// -----------------------------------------------------------------
// 1. REGISTER (สมัครสมาชิก)
// -----------------------------------------------------------------
router.post('/register', async (req, res) => {
    try {
        // รับค่าจาก Frontend (ชื่อตัวแปรตาม React state)
        const {
            firstname, lastname, nickname, phoneNo, schoolName,
            lineId, birthOfDate, remark, username, password,
            gpa, parentId, gradeLevelId, genderId
        } = req.body;

        // 1. เช็คว่า Username ซ้ำไหม
        const [existing] = await pool.query('SELECT UserId FROM users WHERE Username = ?', [username]);
        if (existing.length > 0) {
            return res.status(400).json({ message: 'ชื่อผู้ใช้นี้ (Username) ถูกใช้งานแล้ว' });
        }

        // 2. เข้ารหัส Password
        const hashedPassword = await bcrypt.hash(password, 10);

        // 3. เตรียมข้อมูลลง DB (ต้องแปลงค่าว่าง "" ให้เป็น NULL ในบางฟิลด์ที่เป็นตัวเลข/วันที่)
        // Helper function เล็กๆ เพื่อแปลงค่าว่างเป็น null
        const val = (v) => (v === '' || v === undefined ? null : v);

        const sql = `
            INSERT INTO users (
                Firstname, Lastname, Nickname, PhoneNo, SchoolName, 
                LineID, BirthOfDate, Remark, Username, Password, 
                GPA, Created_at, ParentId, GradeLevelId, GenderId
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)
        `;

        const values = [
            firstname, 
            lastname, 
            val(nickname), 
            val(phoneNo), 
            val(schoolName),
            val(lineId), 
            val(birthOfDate), 
            val(remark), 
            username, 
            hashedPassword,
            val(gpa), 
            val(parentId), 
            val(gradeLevelId), 
            val(genderId)
        ];

        const [result] = await pool.query(sql, values);

        res.status(201).json({ 
            message: 'ลงทะเบียนสำเร็จ', 
            userId: result.insertId 
        });

    } catch (err) {
        console.error("Register Error:", err);
        res.status(500).json({ message: 'เกิดข้อผิดพลาดในการลงทะเบียน', error: err.message });
    }
});

// -----------------------------------------------------------------
// 2. LOGIN (เข้าสู่ระบบ)
// -----------------------------------------------------------------
router.post('/login', async (req, res) => {
    try {
        // รับค่า username และ password (ใน DB ไม่มี email ใช้ username แทน)
        const { username, password } = req.body;

        // 1. ค้นหา User จาก Username
        const [rows] = await pool.query('SELECT * FROM users WHERE Username = ?', [username]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'ไม่พบชื่อผู้ใช้นี้' });
        }

        const user = rows[0];

        // 2. ตรวจสอบรหัสผ่าน
        const isMatch = await bcrypt.compare(password, user.Password);
        if (!isMatch) {
            return res.status(401).json({ message: 'รหัสผ่านไม่ถูกต้อง' });
        }

        // 3. สร้าง Token
        // หมายเหตุ: ใน DB ไม่มีคอลัมน์ Role ชัดเจน ผมจึงไม่ได้ใส่ไป 
        // หรือถ้าจะใช้ Remark เป็น Role ก็เปลี่ยนเป็น role: user.Remark
        const payload = {
            userId: user.UserId,        // ใช้ UserId ตาม DB
            username: user.Username,
            firstname: user.Firstname,
            lastname: user.Lastname
        };

        const token = jwt.sign(
            payload,
            process.env.JWT_SECRET || 'secret_key_change_me', // ควรตั้งใน .env
            { expiresIn: '1d' }
        );

        // 4. บันทึก Token ลงตาราง tokens (ต้องมีตารางนี้ใน DB)
        // ตรวจสอบว่าตาราง tokens ของคุณใช้ user_id หรือ UserId
        await pool.query('INSERT INTO tokens (user_id, token) VALUES (?, ?)', [user.UserId, token]);

        res.json({ 
            message: 'เข้าสู่ระบบสำเร็จ', 
            token,
            user: payload 
        });

    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ message: 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ' });
    }
});

// -----------------------------------------------------------------
// 3. LOGOUT (ออกจากระบบ)
// -----------------------------------------------------------------
router.post('/logout', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'ไม่พบ Token' });
        }

        const token = authHeader.split(' ')[1];

        // ลบ Token ออกจากฐานข้อมูล
        await pool.query('DELETE FROM tokens WHERE token = ?', [token]);

        res.json({ message: 'ออกจากระบบสำเร็จ' });

    } catch (err) {
        console.error("Logout Error:", err);
        res.status(500).json({ message: 'เกิดข้อผิดพลาดในการออกจากระบบ' });
    }
});


// 5. REGISTER TUTOR
router.post('/register-tutor', async (req, res) => {
    try {
        const {
            firstname, lastname, nickname, phoneNo, occupation,
            birthOfDate, remark, username, password,
            ratePerTutors, emergencyContactName, emergencyContactPhoneNo,
            lineId, roleId
        } = req.body;

        if (!firstname || !lastname || !username || !password) {
            return res.status(400).json({ message: 'กรุณากรอกข้อมูลที่จำเป็น' });
        }

        const [existing] = await pool.query(
            'SELECT AdminId FROM admin WHERE Username = ?', [username]
        );
        if (existing.length > 0) {
            return res.status(400).json({ message: 'Username นี้ถูกใช้งานแล้ว' });
        }

        const val = (v) => (v === '' || v === undefined ? null : v);
        const hashedPassword = await bcrypt.hash(password, 10);

        await pool.query(
            `INSERT INTO admin (
                Firstname, Lastname, Nickname, PhoneNo, Occupation,
                BirthOfDate, Remark, Username, Password,
                RatePerTutors, EmergencyContactName, EmergencyContactPhoneNo,
                LineID, RoleId, Created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [
                firstname, lastname, val(nickname), val(phoneNo), val(occupation),
                val(birthOfDate), val(remark), username, hashedPassword,
                val(ratePerTutors), val(emergencyContactName),
                val(emergencyContactPhoneNo), val(lineId), roleId ?? 2
            ]
        );

        res.status(201).json({ message: 'สร้างบัญชี Tutor สำเร็จ' });
    } catch (err) {
        console.error('Register Tutor Error:', err);
        res.status(500).json({ message: 'เกิดข้อผิดพลาด', error: err.message });
    }
});

// ==========================================
// 4. ADMIN & TUTOR LOGIN (สำหรับเจ้าหน้าที่)
// ==========================================
router.post('/login-admin', async (req, res) => {
    try {
        const { username, password } = req.body;

        // 1. ค้นหาในตาราง admin (ไม่ใช่ users)
        const [rows] = await pool.query('SELECT * FROM admin WHERE Username = ?', [username]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'ไม่พบชื่อผู้ดูแลระบบนี้' });
        }

        const admin = rows[0];

        // 2. ตรวจสอบรหัสผ่าน
        const isMatch = await bcrypt.compare(password, admin.Password);
        if (!isMatch) {
            return res.status(401).json({ message: 'รหัสผ่านไม่ถูกต้อง' });
        }

        // 3. สร้าง Token (ระบุ role ให้ชัดเจน)
        // RoleId: 1 = Superadmin, 2 = Tutor
        const payload = {
            id: admin.AdminId,
            username: admin.Username,
            roleId: admin.RoleId, // สำคัญ! ส่งกลับไปบอกหน้าบ้าน
            type: 'admin' // แปะป้ายว่าเป็นกลุ่ม admin
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET || 'secret', { expiresIn: '1d' });

        res.json({
            message: 'เข้าสู่ระบบสำเร็จ',
            token,
            user: {
                id: admin.AdminId,
                username: admin.Username,
                roleId: admin.RoleId, // ส่งกลับไปให้ React ใช้ตัดสินใจ
                firstname: admin.Firstname,
                photo: admin.Photo
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
});

module.exports = router;