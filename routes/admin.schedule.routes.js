const express = require('express');
const router = express.Router();
const { pool } = require('../db');

async function q(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows;
}

async function getHolidaySet(startDate, endDate) {
    const rows = await q(
        `SELECT DATE_FORMAT(HolidayDate, '%Y-%m-%d') AS d
         FROM holidays
         WHERE HolidayDate BETWEEN ? AND ?`,
        [startDate, endDate]
    );
    // คืนเป็น Set เพื่อ lookup O(1)
    return new Set(rows.map(r => r.d));
}

/*** สร้าง array ของวันที่ตาม DayOfWeek ระหว่าง startDate ถึง endDate * DayOfWeek: 1=อาทิตย์, 2=จันทร์, …, 7=เสาร์ * JS getDay(): 0=อาทิตย์, 1=จันทร์, …, 6=เสาร์ */
function getOccurrenceDates(startDate, endDate, dayOfWeek) {
    const jsDay = dayOfWeek === 1 ? 0 : dayOfWeek - 1;
    const dates = [];
    const cur = new Date(startDate);
    // เลื่อนไปวันแรกที่ตรง dayOfWeek
    while (cur.getDay() !== jsDay) {
        cur.setDate(cur.getDate() + 1);
    }
    const end = new Date(endDate);
    while (cur <= end) {
        dates.push(
            new Date(cur)
                .toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' })
                .slice(0, 10)
        );
        cur.setDate(cur.getDate() + 7);
    }
    return dates;
}

async function detectConflicts({ DayOfWeek, StartTime, EndTime, RoomId, AdminId, excludeDetailId = null }) {
    const conflicts = [];
    const baseWhere = `
    cs.DayOfWeek = ?
    AND cs.Deleted_at IS NULL
    AND TIME(cs.StartTime) < TIME(?)
    AND TIME(cs.EndTime)   > TIME(?)
    AND c.Deleted_at IS NULL
    AND c.LastDate >= CURDATE()
    ${excludeDetailId ? 'AND csd.CourseScheduleDetailId != ?' : ''}
  `;
    const baseParams = excludeDetailId
        ? [DayOfWeek, EndTime, StartTime, excludeDetailId]
        : [DayOfWeek, EndTime, StartTime];

    if (RoomId) {
        const roomRows = await q(
            `SELECT csd.CourseScheduleDetailId, r.RoomDetail,
              TIME_FORMAT(cs.StartTime,'%H:%i') AS st,
              TIME_FORMAT(cs.EndTime,'%H:%i')   AS et
       FROM coursescheduledetails csd
       JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
       JOIN courses c         ON c.CourseID = csd.CourseID
       LEFT JOIN rooms r      ON r.RoomId = csd.RoomId
       WHERE csd.RoomId = ? AND ${baseWhere}`,
            [RoomId, ...baseParams]
        );

        if (roomRows.length) {
            conflicts.push({
                type: 'room',
                message: `ห้อง "${roomRows[0].RoomDetail}" ถูกใช้อยู่ในช่วง ${roomRows[0].st}–${roomRows[0].et} แล้ว`,
            });
        }
    }

    if (AdminId) {
        const tutorRows = await q(
            `SELECT csd.CourseScheduleDetailId, a.Nickname,
              TIME_FORMAT(cs.StartTime,'%H:%i') AS st,
              TIME_FORMAT(cs.EndTime,'%H:%i')   AS et
       FROM coursescheduledetails csd
       JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
       JOIN courses c         ON c.CourseID = csd.CourseID
       LEFT JOIN admin a      ON a.AdminId = csd.AdminId
       WHERE csd.AdminId = ? AND ${baseWhere}`,
            [AdminId, ...baseParams]
        );

        if (tutorRows.length) {
            conflicts.push({
                type: 'tutor',
                message: `ติวเตอร์ "${tutorRows[0].Nickname}" มีคาบสอนอยู่แล้วในช่วง ${tutorRows[0].st}–${tutorRows[0].et}`,
            });
        }
    }

    return conflicts;
}

// ── helper ใหม่: ตรวจ conflict ทุก occurrence พร้อมกันใน 2 query ──
async function detectConflictsBulk({ DayOfWeek, StartTime, EndTime, RoomId, AdminId, excludeDetailIds = [] }) {
    const results = {}; // { detailId: [conflicts] }

    const excludeClause = excludeDetailIds.length
        ? `AND csd.CourseScheduleDetailId NOT IN (?)`
        : '';
    const excludeParam = excludeDetailIds.length ? [excludeDetailIds] : [];

    const baseWhere = `
        cs.DayOfWeek = ?
        AND cs.Deleted_at IS NULL
        AND TIME(cs.StartTime) < TIME(?)
        AND TIME(cs.EndTime)   > TIME(?)
        AND c.Deleted_at IS NULL
        AND c.LastDate >= CURDATE()
        ${excludeClause}
    `;
    const baseParams = [DayOfWeek, EndTime, StartTime, ...excludeParam];

    // ── Query 1: ตรวจ room ทั้งหมดพร้อมกัน ──
    if (RoomId) {
        const roomRows = await q(
            `SELECT csd.CourseScheduleDetailId AS conflictWith,
                    r.RoomDetail,
                    TIME_FORMAT(cs.StartTime,'%H:%i') AS st,
                    TIME_FORMAT(cs.EndTime,'%H:%i')   AS et
             FROM coursescheduledetails csd
             JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
             JOIN courses c         ON c.CourseID = csd.CourseID
             LEFT JOIN rooms r      ON r.RoomId = csd.RoomId
             WHERE csd.RoomId = ? AND ${baseWhere}`,
            [RoomId, ...baseParams]
        );

        roomRows.forEach(row => {
            if (!results[row.conflictWith]) results[row.conflictWith] = [];
            results[row.conflictWith].push({
                type: 'room',
                message: `ห้อง "${row.RoomDetail}" ถูกใช้อยู่ในช่วง ${row.st}–${row.et} แล้ว`,
            });
        });
    }

    // ── Query 2: ตรวจ tutor ทั้งหมดพร้อมกัน ──
    if (AdminId) {
        const tutorRows = await q(
            `SELECT csd.CourseScheduleDetailId AS conflictWith,
                    a.Nickname,
                    TIME_FORMAT(cs.StartTime,'%H:%i') AS st,
                    TIME_FORMAT(cs.EndTime,'%H:%i')   AS et
             FROM coursescheduledetails csd
             JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
             JOIN courses c         ON c.CourseID = csd.CourseID
             LEFT JOIN admin a      ON a.AdminId = csd.AdminId
             WHERE csd.AdminId = ? AND ${baseWhere}`,
            [AdminId, ...baseParams]
        );

        tutorRows.forEach(row => {
            if (!results[row.conflictWith]) results[row.conflictWith] = [];
            results[row.conflictWith].push({
                type: 'tutor',
                message: `ติวเตอร์ "${row.Nickname}" มีคาบสอนอยู่แล้วในช่วง ${row.st}–${row.et}`,
            });
        });
    }

    return results; // { detailId: [conflicts], ... } — ถ้าว่างหมด = ไม่มี conflict
}

// GET /api/admin/schedule/weekly?week=2026-04-14 ดึงตารางสอนแบบ weekly grid (GROUP BY เพื่อไม่ซ้ำ) week = วันจันทร์ของสัปดาห์นั้น (ISO date)
router.get('/weekly', async (req, res) => {
    try {
        // คำนวณช่วงสัปดาห์จาก query param
        let weekStart;
        if (req.query.week) {
            weekStart = new Date(req.query.week);
        } else {
            weekStart = new Date();
            const day = weekStart.getDay(); // 0=อา
            // เลื่อนไปวันจันทร์
            const diff = day === 0 ? -6 : 1 - day;
            weekStart.setDate(weekStart.getDate() + diff);
        }
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        weekEnd.setHours(23, 59, 59, 999);

        const weekStartStr = weekStart
            .toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' })
            .slice(0, 10);

        const weekEndStr = weekEnd
            .toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' })
            .slice(0, 10);

        // ── Query หลัก: GROUP BY เพื่อไม่ซ้ำ + เฉพาะสัปดาห์ที่เลือก ──
        const sql = `
      SELECT
        MIN(csd.CourseScheduleDetailId)     AS CourseScheduleDetailId,
        MIN(cs.CourseScheduleId)            AS CourseScheduleId,
        cs.DayOfWeek,
        TIME_FORMAT(cs.StartTime, '%H:%i')  AS StartTime,
        TIME_FORMAT(cs.EndTime,   '%H:%i')  AS EndTime,
        csd.CourseID,
        csd.SubjectId,
        csd.AdminId,
        csd.RoomId,
        c.CourseName,
        s.SubjectName,
        a.Nickname                          AS TutorNickname,
        r.RoomDetail,
        r.Capacity                          AS MaxStudents,
        COUNT(DISTINCT e.EnrollId)          AS StudentCount,
        COUNT(DISTINCT cs.CourseScheduleId) AS TotalOccurrences,
        -- สถานะ tutorcheckin ของสัปดาห์นี้
        SUM(
          CASE WHEN tc.TutorCheckinId IS NOT NULL
            AND DATE(cs.StartDateTime) BETWEEN ? AND ?
          THEN 1 ELSE 0 END
        )                                   AS CheckinCount,
        -- occurrence ที่ตรงกับสัปดาห์ที่ดูอยู่
        MIN(CASE
          WHEN DATE(cs.StartDateTime) BETWEEN ? AND ?
          THEN csd.CourseScheduleDetailId
        END)                                AS WeekDetailId,
        MIN(CASE
          WHEN DATE(cs.StartDateTime) BETWEEN ? AND ?
          THEN DATE(cs.StartDateTime)
        END)                                AS WeekDate
      FROM coursescheduledetails csd
      JOIN  courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
      JOIN  courses        c  ON c.CourseID          = csd.CourseID
      LEFT JOIN subjects   s  ON s.SubjectId         = csd.SubjectId
      LEFT JOIN admin      a  ON a.AdminId           = csd.AdminId
      LEFT JOIN rooms      r  ON r.RoomId            = csd.RoomId
      LEFT JOIN enroll     e  ON e.CourseID          = csd.CourseID
      LEFT JOIN tutorcheckin tc ON tc.CourseScheduleDetailId = csd.CourseScheduleDetailId
                                AND tc.Deleted_at IS NULL
      WHERE cs.Deleted_at IS NULL
        AND c.Deleted_at  IS NULL
      GROUP BY
        cs.DayOfWeek,
        cs.StartTime,
        cs.EndTime,
        csd.CourseID,
        csd.SubjectId,
        csd.AdminId,
        csd.RoomId
      HAVING COUNT(CASE WHEN DATE(cs.StartDateTime) BETWEEN ? AND ? THEN 1 END) > 0
      ORDER BY cs.DayOfWeek, cs.StartTime
    `;

        const holidayRows = await q(
            `SELECT DATE_FORMAT(HolidayDate,'%Y-%m-%d') AS date, Name
     FROM holidays
     WHERE HolidayDate BETWEEN ? AND ?`,
            [weekStartStr, weekEndStr]
        );

        const rows = await q(sql, [
            weekStartStr, weekEndStr,
            weekStartStr, weekEndStr,
            weekStartStr, weekEndStr,
            weekStartStr, weekEndStr,   
        ]);

        res.json({
            weekStart: weekStartStr,
            weekEnd: weekEndStr,
            holidays: holidayRows,
            schedule: rows,
        });
    } catch (err) {
        console.error('[GET /schedule/weekly]', err);
        res.status(500).json({ message: 'ดึงตารางสอนไม่สำเร็จ', error: err.message });
    }
});

router.get('/meta', async (req, res) => {
    try {
        const [rooms, tutors, subjects, courses] = await Promise.all([
            q(`SELECT RoomId, RoomDetail, Capacity
               FROM rooms
               WHERE Deleted_at IS NULL
               ORDER BY RoomId`),

            q(`SELECT AdminId, Nickname, Firstname, Lastname
               FROM admin
               WHERE Deleted_at IS NULL
                 AND RoleId = 2
               ORDER BY Nickname`),

            q(`SELECT SubjectId, SubjectName
               FROM subjects
               ORDER BY SubjectId`),

            q(`SELECT CourseID, CourseName,
                      DATE_FORMAT(StartDate,'%Y-%m-%d') AS StartDate,
                      DATE_FORMAT(LastDate, '%Y-%m-%d') AS LastDate
               FROM courses
               WHERE Deleted_at IS NULL
                 AND LastDate >= CURDATE()
               ORDER BY CourseID DESC`),
        ]);

        res.json({ rooms, tutors, subjects, courses });
    } catch (err) {
        console.error('[GET /schedule/meta]', err);
        res.status(500).json({ message: 'ดึง meta ไม่สำเร็จ', error: err.message });
    }
});

router.post('/', async (req, res) => {
    const {
        CourseID, SubjectId, AdminId, RoomId,
        DayOfWeek, StartTime, EndTime,
        TermStartDate, TermEndDate,
    } = req.body;

    if (!CourseID || !DayOfWeek || !StartTime || !EndTime || !TermStartDate || !TermEndDate) {
        return res.status(400).json({
            message: 'กรุณาระบุ CourseID, DayOfWeek, StartTime, EndTime, TermStartDate, TermEndDate',
        });
    }

    try {
        // ── 0. ตรวจว่าคอร์สยังเปิดอยู่จริง ──
        const courseRows = await q(
            `SELECT CourseID, CourseName, LastDate, Deleted_at
             FROM courses
             WHERE CourseID = ?
               AND Deleted_at IS NULL
               AND LastDate >= CURDATE()`,
            [Number(CourseID)]
        );

        if (!courseRows.length) {
            return res.status(400).json({
                message: 'คอร์สนี้ปิดแล้วหรือหมดช่วงเวลาเรียนแล้ว ไม่สามารถเพิ่มตารางเรียนได้',
            });
        }

        // ── 1. ตรวจ conflict ──
        const conflicts = await detectConflicts({
            DayOfWeek: Number(DayOfWeek),
            StartTime,
            EndTime,
            RoomId: RoomId ? Number(RoomId) : null,
            AdminId: AdminId ? Number(AdminId) : null,
        });

        if (conflicts.length) {
            return res.status(409).json({
                message: 'พบ conflict ในตารางสอน',
                conflicts,
            });
        }

        // ── 2. คำนวณวันที่ทั้งหมดในเทอม (กรองวันหยุดออก) ──
        const allDates = getOccurrenceDates(new Date(TermStartDate), new Date(TermEndDate), Number(DayOfWeek));
        const holidaySet = await getHolidaySet(TermStartDate, TermEndDate);

        // แยกออกเป็น 2 กลุ่มให้ชัดเจน
        const dates = allDates.filter(d => !holidaySet.has(d));
        const skippedHolidays = allDates.filter(d => holidaySet.has(d));

        if (!dates.length) {
            return res.status(400).json({
                message: `ไม่มีวัน${['', 'อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'][DayOfWeek]}ในช่วง ${TermStartDate} – ${TermEndDate} (หลังหักวันหยุด)`,
                skippedHolidays,
            });
        }

        // ── 3. INSERT เฉพาะวันที่ไม่ใช่วันหยุด ──
        const insertedIds = [];
        for (const dateStr of dates) {
            const startDT = `${dateStr} ${StartTime}:00`;
            const endDT = `${dateStr} ${EndTime}:00`;

            const csResult = await q(
                `INSERT INTO courseschedule
                 (StartDateTime, EndDateTime, DayOfWeek, StartTime, EndTime, Created_at)
                 VALUES (?, ?, ?, ?, ?, NOW())`,
                [startDT, endDT, Number(DayOfWeek), `${StartTime}:00`, `${EndTime}:00`]
            );

            const csdResult = await q(
                `INSERT INTO coursescheduledetails
                 (CourseScheduleId, CourseID, SubjectId, AdminId, RoomId)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    csResult.insertId,
                    Number(CourseID),
                    SubjectId ? Number(SubjectId) : null,
                    AdminId ? Number(AdminId) : null,
                    RoomId ? Number(RoomId) : null,
                ]
            );

            insertedIds.push(csdResult.insertId);
        }

        res.status(201).json({
            message: `สร้างคาบสอนสำเร็จ ${dates.length} occurrence${skippedHolidays.length ? ` (ข้ามวันหยุด ${skippedHolidays.length} วัน)` : ''}`,
            occurrences: dates.length,
            skippedHolidays,   // ← ส่งกลับให้ frontend แสดงได้
            firstDetailId: insertedIds[0],
        });
    } catch (err) {
        console.error('[POST /schedule]', err);
        res.status(500).json({ message: 'สร้างคาบสอนไม่สำเร็จ', error: err.message });
    }
});

// PUT /api/admin/schedule/:id , แก้ไขคาบสอน
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const {
        CourseID, SubjectId, AdminId, RoomId,
        DayOfWeek, StartTime, EndTime,
        scope = 'this',
    } = req.body;

    if (!CourseID || !DayOfWeek || !StartTime || !EndTime) {
        return res.status(400).json({ message: 'กรุณาระบุข้อมูลให้ครบถ้วน' });
    }

    // ── 0. ตรวจว่าคอร์สปลายทางยังเปิดอยู่จริง ──
    const courseRows = await q(
        `SELECT CourseID, CourseName, LastDate, Deleted_at
         FROM courses
         WHERE CourseID = ?
           AND Deleted_at IS NULL
           AND LastDate >= CURDATE()`,
        [Number(CourseID)]
    );

    if (!courseRows.length) {
        return res.status(400).json({
            message: 'คอร์สนี้ปิดแล้วหรือหมดช่วงเวลาเรียนแล้ว ไม่สามารถแก้ไขตารางเรียนให้คอร์สนี้ได้',
        });
    }

    try {
        // ── หา occurrence ปัจจุบัน ──
        const current = await q(
            `SELECT csd.CourseScheduleDetailId, csd.CourseScheduleId,
                    csd.CourseID AS OldCourseID, csd.SubjectId AS OldSubjectId,
                    csd.AdminId  AS OldAdminId,  csd.RoomId    AS OldRoomId,
                    cs.DayOfWeek AS OldDayOfWeek,
                    TIME_FORMAT(cs.StartTime,'%H:%i') AS OldStartTime,
                    TIME_FORMAT(cs.EndTime,'%H:%i')   AS OldEndTime,
                    cs.StartDateTime
             FROM coursescheduledetails csd
             JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
             WHERE csd.CourseScheduleDetailId = ?`,
            [id]
        );

        if (!current.length) {
            return res.status(404).json({ message: 'ไม่พบคาบสอนนี้' });
        }

        const cur = current[0];

        // ── fast-fail conflict check ตัวแรก ──
        const firstConflicts = await detectConflicts({
            DayOfWeek: Number(DayOfWeek),
            StartTime,
            EndTime,
            RoomId: RoomId ? Number(RoomId) : null,
            AdminId: AdminId ? Number(AdminId) : null,
            excludeDetailId: Number(id),
        });

        if (firstConflicts.length) {
            return res.status(409).json({
                message: 'พบ conflict',
                conflicts: firstConflicts,
            });
        }

        // ── หา targetIds ตาม scope ──
        let targetIds = [];

        if (scope === 'this') {
            targetIds = [Number(id)];

        } else if (scope === 'future') {
            const futureRows = await q(
                `SELECT csd.CourseScheduleDetailId
                 FROM coursescheduledetails csd
                 JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
                 WHERE csd.CourseID   = ?
                   AND csd.SubjectId  <=> ?
                   AND csd.AdminId    <=> ?
                   AND csd.RoomId     <=> ?
                   AND cs.DayOfWeek   = ?
                   AND cs.StartTime   = ?
                   AND cs.StartDateTime >= ?
                   AND cs.Deleted_at IS NULL`,
                [
                    cur.OldCourseID,
                    cur.OldSubjectId,
                    cur.OldAdminId,
                    cur.OldRoomId,
                    cur.OldDayOfWeek,
                    `${cur.OldStartTime}:00`,
                    cur.StartDateTime,
                ]
            );
            targetIds = futureRows.map(r => r.CourseScheduleDetailId);

        } else {
            const allRows = await q(
                `SELECT csd.CourseScheduleDetailId
                 FROM coursescheduledetails csd
                 JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
                 WHERE csd.CourseID  = ?
                   AND csd.SubjectId <=> ?
                   AND csd.AdminId   <=> ?
                   AND csd.RoomId    <=> ?
                   AND cs.DayOfWeek  = ?
                   AND cs.StartTime  = ?
                   AND cs.Deleted_at IS NULL`,
                [
                    cur.OldCourseID,
                    cur.OldSubjectId,
                    cur.OldAdminId,
                    cur.OldRoomId,
                    cur.OldDayOfWeek,
                    `${cur.OldStartTime}:00`,
                ]
            );
            targetIds = allRows.map(r => r.CourseScheduleDetailId);
        }

        // ── ถ้า future/all ให้ตรวจ conflict ทุก occurrence ──
        if (scope !== 'this' && targetIds.length > 1) {

            const otherIds = targetIds.filter(d => d !== Number(id));
        
            // ✅ ส่ง otherIds ทั้งหมดเป็น excludeDetailIds
            // → ตรวจทุก occurrence ใน 2 query แทน N*2 query
            const bulkResults = await detectConflictsBulk({
                DayOfWeek: Number(DayOfWeek),
                StartTime,
                EndTime,
                RoomId:  RoomId  ? Number(RoomId)  : null,
                AdminId: AdminId ? Number(AdminId) : null,
                excludeDetailIds: otherIds,
            });
        
            if (Object.keys(bulkResults).length > 0) {
                // ดึงวันที่ของ occurrence ที่ conflict ใน 1 query
                const conflictIds = Object.keys(bulkResults).map(Number);
        
                const dateRows = await q(
                    `SELECT csd.CourseScheduleDetailId,
                            DATE(cs.StartDateTime) AS d
                     FROM coursescheduledetails csd
                     JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
                     WHERE csd.CourseScheduleDetailId IN (?)`,
                    [conflictIds]
                );
        
                const dateMap = {};
                dateRows.forEach(r => { dateMap[r.CourseScheduleDetailId] = r.d; });
        
                const occurrenceConflicts = conflictIds.map(detailId => ({
                    detailId,
                    date: dateMap[detailId]
                        ? new Date(dateMap[detailId]).toLocaleDateString('th-TH')
                        : `DetailId ${detailId}`,
                    conflicts: bulkResults[detailId],
                }));
        
                return res.status(409).json({
                    message: `พบ conflict ใน ${occurrenceConflicts.length} คาบ`,
                    occurrenceConflicts,
                    cleanCount: targetIds.length - occurrenceConflicts.length,
                });
            }
        }

        // ── เขียนข้อมูลแบบ transaction ──
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            for (const detailId of targetIds) {
                const [csRow] = await conn.query(
                    `SELECT csd.CourseScheduleId, cs.StartDateTime
                     FROM coursescheduledetails csd
                     JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
                     WHERE csd.CourseScheduleDetailId = ?`,
                    [detailId]
                );

                if (!csRow.length) {
                    throw new Error(`ไม่พบ CourseScheduleDetailId: ${detailId}`);
                }

                const { CourseScheduleId, StartDateTime } = csRow[0];
                const dateStr = new Date(StartDateTime)
                    .toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' })
                    .slice(0, 10);

                await conn.query(
                    `UPDATE courseschedule
                     SET DayOfWeek     = ?,
                         StartTime     = ?,
                         EndTime       = ?,
                         StartDateTime = ?,
                         EndDateTime   = ?,
                         Updated_at    = NOW()
                     WHERE CourseScheduleId = ?`,
                    [
                        Number(DayOfWeek),
                        `${StartTime}:00`,
                        `${EndTime}:00`,
                        `${dateStr} ${StartTime}:00`,
                        `${dateStr} ${EndTime}:00`,
                        CourseScheduleId,
                    ]
                );

                await conn.query(
                    `UPDATE coursescheduledetails
                     SET CourseID  = ?,
                         SubjectId = ?,
                         AdminId   = ?,
                         RoomId    = ?
                     WHERE CourseScheduleDetailId = ?`,
                    [
                        Number(CourseID),
                        SubjectId ? Number(SubjectId) : null,
                        AdminId ? Number(AdminId) : null,
                        RoomId ? Number(RoomId) : null,
                        detailId,
                    ]
                );
            }

            await conn.commit();

            return res.json({
                message: `แก้ไขสำเร็จ ${targetIds.length} occurrence`,
                updated: targetIds.length,
            });
        } catch (err) {
            await conn.rollback();
            console.error('[PUT /schedule/:id] tx error:', err);

            return res.status(500).json({
                message: 'แก้ไขคาบสอนไม่สำเร็จ',
                error: err.message,
            });
        } finally {
            conn.release();
        }
    } catch (err) {
        console.error('[PUT /schedule/:id]', err);
        return res.status(500).json({
            message: 'แก้ไขคาบสอนไม่สำเร็จ',
            error: err.message,
        });
    }
});

router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const { scope = 'this' } = req.body;

    try {
        const current = await q(
            `SELECT csd.CourseScheduleDetailId, csd.CourseScheduleId,
                    csd.CourseID, csd.SubjectId, csd.AdminId, csd.RoomId,
                    cs.DayOfWeek, cs.StartTime, cs.StartDateTime
             FROM coursescheduledetails csd
             JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
             WHERE csd.CourseScheduleDetailId = ?`,
            [id]
        );

        if (!current.length) {
            return res.status(404).json({ message: 'ไม่พบคาบสอนนี้' });
        }

        const cur = current[0];
        let targetIds = [];

        if (scope === 'this') {
            targetIds = [Number(id)];
        } else if (scope === 'future') {
            const rows = await q(
                `SELECT csd.CourseScheduleDetailId
                 FROM coursescheduledetails csd
                 JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
                 WHERE csd.CourseID  = ? AND csd.SubjectId <=> ?
                   AND csd.AdminId   <=> ? AND csd.RoomId  <=> ?
                   AND cs.DayOfWeek  = ? AND cs.StartTime  = ?
                   AND cs.StartDateTime >= ? AND cs.Deleted_at IS NULL`,
                [cur.CourseID, cur.SubjectId, cur.AdminId, cur.RoomId,
                cur.DayOfWeek, cur.StartTime, cur.StartDateTime]
            );
            targetIds = rows.map(r => r.CourseScheduleDetailId);
        } else {
            const rows = await q(
                `SELECT csd.CourseScheduleDetailId
                 FROM coursescheduledetails csd
                 JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
                 WHERE csd.CourseID  = ? AND csd.SubjectId <=> ?
                   AND csd.AdminId   <=> ? AND csd.RoomId  <=> ?
                   AND cs.DayOfWeek  = ? AND cs.StartTime  = ?
                   AND cs.Deleted_at IS NULL`,
                [cur.CourseID, cur.SubjectId, cur.AdminId, cur.RoomId,
                cur.DayOfWeek, cur.StartTime]
            );
            targetIds = rows.map(r => r.CourseScheduleDetailId);
        }

        // ── ตรวจ tutorcheckin ที่จ่ายเงินไปแล้ว ──
        const paidCheckins = await q(
            `SELECT tc.TutorCheckinId, tc.CourseScheduleDetailId,
                    tc.TutorPaymentId, a.Nickname,
                    DATE(cs.StartDateTime) AS ClassDate
             FROM tutorcheckin tc
             JOIN coursescheduledetails csd
               ON csd.CourseScheduleDetailId = tc.CourseScheduleDetailId
             JOIN courseschedule cs
               ON cs.CourseScheduleId = csd.CourseScheduleId
             LEFT JOIN admin a ON a.AdminId = tc.AdminId
             WHERE tc.CourseScheduleDetailId IN (?)
               AND tc.TutorPaymentId IS NOT NULL
               AND tc.Deleted_at IS NULL`,
            [targetIds]
        );

        if (paidCheckins.length) {
            return res.status(409).json({
                message: `ไม่สามารถลบได้ มีคาบที่จ่ายเงินให้ติวเตอร์ไปแล้ว ${paidCheckins.length} คาบ`,
                paidCheckins: paidCheckins.map(c => ({
                    date: c.ClassDate,
                    tutor: c.Nickname,
                    paymentId: c.TutorPaymentId,
                })),
                hint: 'กรุณายกเลิก TutorPayment ก่อน แล้วค่อยลบคาบสอน',
            });
        }

        // ── Transaction: soft-delete schedule + checkin ──
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            for (const detailId of targetIds) {
                const [csRows] = await conn.query(
                    `SELECT csd.CourseScheduleId
                     FROM coursescheduledetails csd
                     WHERE csd.CourseScheduleDetailId = ?`,
                    [detailId]
                );

                if (!csRows.length) continue;

                // soft-delete schedule
                await conn.query(
                    `UPDATE courseschedule
                     SET Deleted_at = NOW()
                     WHERE CourseScheduleId = ?`,
                    [csRows[0].CourseScheduleId]
                );

                // ✅ ใหม่: soft-delete tutorcheckin ที่ยังไม่จ่ายเงิน
                await conn.query(
                    `UPDATE tutorcheckin
                     SET Deleted_at = NOW()
                     WHERE CourseScheduleDetailId = ?
                       AND TutorPaymentId IS NULL
                       AND Deleted_at IS NULL`,
                    [detailId]
                );
            }

            await conn.commit();

            return res.json({
                message: `ลบสำเร็จ ${targetIds.length} occurrence`,
                deleted: targetIds.length,
            });
        } catch (err) {
            await conn.rollback();
            console.error('[DELETE /schedule/:id] tx error:', err);
            return res.status(500).json({
                message: 'ลบคาบสอนไม่สำเร็จ',
                error: err.message,
            });
        } finally {
            conn.release();
        }
    } catch (err) {
        console.error('[DELETE /schedule/:id]', err);
        return res.status(500).json({
            message: 'ลบคาบสอนไม่สำเร็จ',
            error: err.message,
        });
    }
});

router.post('/copy-week', async (req, res) => {
    const { fromWeek, toWeek } = req.body;
    if (!fromWeek || !toWeek) {
        return res.status(400).json({ message: 'กรุณาระบุ fromWeek และ toWeek' });
    }

    try {
        const from = new Date(fromWeek);
        const to = new Date(toWeek);
        const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));

        // ดึง detail ทั้งหมดของสัปดาห์ต้นทาง
        const fromEnd = new Date(from);
        fromEnd.setDate(from.getDate() + 6);

        // ใช้ชื่อต่างออกไปเพื่อไม่ซ้ำกับตัวแปรในลูป
        const fromStartStr = from.toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 10);
        const fromEndStr = fromEnd.toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 10);

        const sources = await q(
            `SELECT csd.CourseScheduleDetailId, csd.CourseID, csd.SubjectId,
                    csd.AdminId, csd.RoomId,
                    cs.DayOfWeek, cs.StartTime, cs.EndTime,
                    cs.StartDateTime, cs.EndDateTime
             FROM coursescheduledetails csd
             JOIN courseschedule cs ON cs.CourseScheduleId = csd.CourseScheduleId
             WHERE DATE(cs.StartDateTime) BETWEEN ? AND ?
               AND cs.Deleted_at IS NULL`,
            [fromStartStr, fromEndStr]
        );

        if (!sources.length) {
            return res.status(404).json({ message: 'ไม่มีคาบสอนในสัปดาห์ต้นทาง' });
        }

        let copied = 0;
        const skipped = [];

        for (const src of sources) {
            const newStartDT = new Date(src.StartDateTime);
            newStartDT.setDate(newStartDT.getDate() + diffDays);
            const newEndDT = new Date(src.EndDateTime);
            newEndDT.setDate(newEndDT.getDate() + diffDays);

            // ประกาศ newDateStr ก่อนใช้
            const newDateStr = newStartDT.toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).slice(0, 10);
            const newStartDTStr = `${newDateStr} ${src.StartTime.slice(0, 5)}:00`;
            const newEndDTStr = `${newDateStr} ${src.EndTime.slice(0, 5)}:00`;

            const conflicts = await detectConflicts({
                DayOfWeek: src.DayOfWeek,
                StartTime: src.StartTime.slice(0, 5),
                EndTime: src.EndTime.slice(0, 5),
                RoomId: src.RoomId,
                AdminId: src.AdminId,
            });

            if (conflicts.length) {
                // newDateStr มีค่าแล้ว ไม่ crash
                skipped.push({ date: newDateStr, reason: conflicts[0].message });
                continue;
            }

            const csResult = await q(
                `INSERT INTO courseschedule
                 (StartDateTime, EndDateTime, DayOfWeek, StartTime, EndTime, Created_at)
                 VALUES (?, ?, ?, ?, ?, NOW())`,
                [newStartDTStr, newEndDTStr, src.DayOfWeek, src.StartTime, src.EndTime]
            );

            await q(
                `INSERT INTO coursescheduledetails
                 (CourseScheduleId, CourseID, SubjectId, AdminId, RoomId)
                 VALUES (?, ?, ?, ?, ?)`,
                [csResult.insertId, src.CourseID, src.SubjectId, src.AdminId, src.RoomId]
            );

            copied++;
        }

        res.status(201).json({
            message: `คัดลอกสำเร็จ ${copied} คาบ${skipped.length ? ` (ข้าม ${skipped.length} คาบ เพราะ conflict)` : ''}`,
            copied,
            skipped,
        });
    } catch (err) {
        console.error('[POST /schedule/copy-week]', err);
        res.status(500).json({ message: 'คัดลอกตารางไม่สำเร็จ', error: err.message });
    }
});

// GET /api/admin/schedule/conflicts?dayOfWeek=2&startTime=09:00&endTime=10:30
// ตรวจ conflict แบบ real-time (ใช้ใน frontend ตอนกรอก form)
router.get('/conflicts', async (req, res) => {
    const { dayOfWeek, startTime, endTime, roomId, adminId, excludeId } = req.query;
    if (!dayOfWeek || !startTime || !endTime) {
        return res.status(400).json({ message: 'กรุณาระบุ dayOfWeek, startTime, endTime' });
    }
    try {
        const conflicts = await detectConflicts({
            DayOfWeek: Number(dayOfWeek),
            StartTime: startTime,
            EndTime: endTime,
            RoomId: roomId ? Number(roomId) : null,
            AdminId: adminId ? Number(adminId) : null,
            excludeDetailId: excludeId ? Number(excludeId) : null,
        });
        res.json({ conflicts });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;