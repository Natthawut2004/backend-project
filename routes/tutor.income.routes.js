const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// ─── อัตราค่าสอนตามจำนวนนักเรียนจริง ───────────────────────────
function calculateRate(levelType, actualStudents) {
    const rates = {
        elementary: [
            { max: 4, rate: 180 },
            { max: 10, rate: 210 },
            { max: 15, rate: 240 },
            { max: 20, rate: 270 },
            { max: Infinity, rate: 300 },
        ],
        secondary: [
            { max: 4, rate: 210 },
            { max: 10, rate: 240 },
            { max: 15, rate: 270 },
            { max: 20, rate: 300 },
            { max: Infinity, rate: 330 },
        ],
    };
    const table = rates[levelType] ?? rates.secondary;
    for (const tier of table) {
        if (actualStudents <= tier.max) return tier.rate;
    }
    return table[table.length - 1].rate;
}

/**
 * ตรวจ levelType จากชื่อคอร์ส
 * ป.1-ป.6 = elementary | ม.1-ม.6, Netsat, A-Level = secondary
 */
function getLevelType(courseName = '') {
    // ชื่อคอร์สในฐานข้อมูลมีทั้ง "ป.2", "ป.3", ... "ป.6"
    if (/ป\.\d/.test(courseName)) return 'elementary';
    return 'secondary';
}

function getThaiMonth(date) {
    const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
        'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
    return months[date.getMonth()];
}

// GET /api/tutor/income/:adminId
router.get('/income/:adminId', async (req, res) => {
    const { adminId } = req.params;

    try {
        // 1. ดึงข้อมูล admin/tutor
        const [adminRows] = await pool.query(
            `SELECT AdminId, Firstname, Lastname, Nickname, RatePerTutors
       FROM admin WHERE AdminId = ? AND Deleted_at IS NULL`,
            [adminId]
        );
        if (!adminRows || adminRows.length === 0) {
            return res.status(404).json({ error: 'ไม่พบข้อมูลติวเตอร์ในระบบ' });
        }
        const admin = adminRows[0];

        // 2. ดึง sessions ที่ติวเตอร์ check-in แล้ว
        //    - sessionDate ใช้ cs.StartDateTime (วันที่สอนจริง) ไม่ใช่ tc.Created_at
        //    - duration คำนวณจาก StartDateTime/EndDateTime (DATETIME) ที่ถูกต้อง
        //    - actualStudents = จำนวนนักเรียนที่ Status='1' (มาเรียน)
        const [sessions] = await pool.query(`
      SELECT
        tc.TutorCheckinId,
        tc.TutorPaymentId,
        tc.Created_at AS sessionDate,
        ROUND(
          TIMESTAMPDIFF(MINUTE, cs.StartDateTime, cs.EndDateTime) / 60.0, 2
        ) AS durationHours,
        c.CourseID,
        c.CourseName,
        subj.SubjectName,
        COUNT(CASE WHEN sa.Status = '1' THEN 1 END) AS actualStudents
      FROM tutorcheckin tc
      JOIN coursescheduledetails csd
        ON tc.CourseScheduleDetailId = csd.CourseScheduleDetailId
      JOIN courseschedule cs
        ON csd.CourseScheduleId = cs.CourseScheduleId
      JOIN courses c
        ON csd.CourseID = c.CourseID
      LEFT JOIN subjects subj
        ON csd.SubjectId = subj.SubjectId
      LEFT JOIN studentattendance sa
        ON  sa.CourseScheduleDetailId = csd.CourseScheduleDetailId
        AND sa.Deleted_at IS NULL
      WHERE tc.AdminId = ?
        AND tc.Deleted_at IS NULL
        AND cs.Deleted_at IS NULL
      GROUP BY tc.TutorCheckinId, tc.TutorPaymentId, tc.Created_at, 
         cs.StartDateTime, cs.EndDateTime, c.CourseID, c.CourseName, subj.SubjectName
      ORDER BY cs.StartDateTime DESC
    `, [adminId]);

        // 3. ดึงประวัติการรับเงิน
        const [payments] = await pool.query(`
      SELECT
        tp.TutorPaymentId,
        tp.PaymentCost,
        tp.PaymentDate,
        tp.BillNo,
        tp.PaymentPicture,
        GROUP_CONCAT(DISTINCT c.CourseName ORDER BY c.CourseName SEPARATOR '||') AS courseNames
      FROM tutorpayment tp
      JOIN tutorcheckin tc
        ON tc.TutorPaymentId = tp.TutorPaymentId
      JOIN coursescheduledetails csd
        ON tc.CourseScheduleDetailId = csd.CourseScheduleDetailId
      JOIN courses c
        ON csd.CourseID = c.CourseID
      WHERE tc.AdminId = ?
        AND tp.Deleted_at IS NULL
      GROUP BY tp.TutorPaymentId
      ORDER BY tp.PaymentDate DESC
    `, [adminId]);

        // ─── คำนวณรายได้แต่ละ session ───────────────────────────────
        const sessionResults = (sessions || []).map(s => {
            const levelType = getLevelType(s.CourseName);
            const studentCount = Number(s.actualStudents) || 0;
            const ratePerSession = calculateRate(levelType, studentCount);

            // duration จาก DB เป็น DATETIME จริง → ถูกต้อง
            // ถ้า duration = 0 หรือ NULL (ข้อมูลผิดพลาด) ให้ใช้ 1.5 ชม. เป็น fallback
            const duration = Number(s.durationHours) > 0 ? Number(s.durationHours) : 1.5;
            const durationFactor = duration / 1.5;
            const earnedAmount = Math.round(ratePerSession * durationFactor);

            return {
                tutorCheckinId: s.TutorCheckinId,
                sessionDate: s.sessionDate,
                courseId: s.CourseID,
                courseName: s.CourseName,
                subjectName: s.SubjectName || null,
                levelType,
                actualStudents: studentCount,
                durationHours: duration,
                ratePerSession,
                earnedAmount,
                isPaid: !!s.TutorPaymentId,
                tutorPaymentId: s.TutorPaymentId || null,
            };
        });

        // ─── Summary ─────────────────────────────────────────────────
        const totalEarned = sessionResults.reduce((sum, s) => sum + s.earnedAmount, 0);
        const paidSessions = sessionResults.filter(s => s.isPaid);
        const unpaidSessions = sessionResults.filter(s => !s.isPaid);
        const totalPaid = paidSessions.reduce((sum, s) => sum + s.earnedAmount, 0);
        const totalPending = unpaidSessions.reduce((sum, s) => sum + s.earnedAmount, 0);

        const now = new Date();
        const thisMonth = sessionResults.filter(s => {
            const d = new Date(s.sessionDate);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });
        const thisMonthEarned = thisMonth.reduce((sum, s) => sum + s.earnedAmount, 0);

        const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthEarned = sessionResults
            .filter(s => {
                const d = new Date(s.sessionDate);
                return d.getMonth() === lastMonthDate.getMonth()
                    && d.getFullYear() === lastMonthDate.getFullYear();
            })
            .reduce((sum, s) => sum + s.earnedAmount, 0);

        const growth = lastMonthEarned > 0
            ? Math.round(((thisMonthEarned - lastMonthEarned) / lastMonthEarned) * 100)
            : (thisMonthEarned > 0 ? 100 : 0);

        // ─── Monthly breakdown (ครอบคลุมทุกเดือนที่มีข้อมูล) ─────────
        const monthlyMap = {};

        // หาเดือนแรกสุดจาก session จริง
        const allDates = sessionResults.map(s => new Date(s.sessionDate));
        const minDate = allDates.length > 0 ? new Date(Math.min(...allDates)) : new Date(now.getFullYear(), now.getMonth() - 5, 1);

        // สร้าง map ตั้งแต่เดือนแรกสุด → เดือนปัจจุบัน
        let cursor = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
        const endMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        while (cursor <= endMonth) {
            const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
            monthlyMap[key] = {
                month: getThaiMonth(cursor),
                year: cursor.getFullYear(),
                total: 0,
                elementary: 0,
                secondary: 0,
                sessions: 0,
            };
            cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
        }

        sessionResults.forEach(s => {
            const d = new Date(s.sessionDate);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            if (monthlyMap[key]) {
                monthlyMap[key].total += s.earnedAmount;
                monthlyMap[key][s.levelType] += s.earnedAmount;
                monthlyMap[key].sessions += 1;
            }
        });

        // ─── Course summary ──────────────────────────────────────────
        const courseMap = {};
        sessionResults.forEach(s => {
            if (!courseMap[s.courseId]) {
                courseMap[s.courseId] = {
                    courseId: s.courseId,
                    courseName: s.courseName,
                    levelType: s.levelType,
                    sessions: 0,
                    totalEarned: 0,
                    paidEarned: 0,
                    pendingEarned: 0,
                    lastSession: s.sessionDate,
                };
            }
            const c = courseMap[s.courseId];
            c.sessions += 1;
            c.totalEarned += s.earnedAmount;
            if (s.isPaid) c.paidEarned += s.earnedAmount;
            else c.pendingEarned += s.earnedAmount;
            // อัปเดต lastSession ถ้าใหม่กว่า
            if (new Date(s.sessionDate) > new Date(c.lastSession)) {
                c.lastSession = s.sessionDate;
            }
        });

        // ─── Response ────────────────────────────────────────────────
        res.json({
            admin: {
                adminId: admin.AdminId,
                nickname: admin.Nickname || `${admin.Firstname} ${admin.Lastname}`,
                customRate: admin.RatePerTutors,
            },
            summary: {
                thisMonthEarned,
                lastMonthEarned,
                growth,
                totalEarned,
                totalPaid,
                totalPending,
                pendingSessionCount: unpaidSessions.length,
                totalSessions: sessionResults.length,
            },
            monthly: Object.values(monthlyMap),
            courses: Object.values(courseMap),
            sessions: sessionResults,
            payments: (payments || []).map(p => ({
                tutorPaymentId: p.TutorPaymentId,
                paymentCost: Number(p.PaymentCost),
                paymentDate: p.PaymentDate,
                billNo: p.BillNo,
                paymentPicture: p.PaymentPicture,
                courses: p.courseNames ? p.courseNames.split('||') : [],
            })),
        });

    } catch (err) {
        console.error('[tutor income error]:', err);
        res.status(500).json({ error: 'Internal server error', detail: err.message });
    }
});

module.exports = router;