// routes/tutor/analytics.js
// ─────────────────────────────────────────────────────────────
//  Analytics & Reporting — Backend Routes
//  Base: /api/tutor/analytics
//  Auth: ต้องผ่าน authMiddleware (req.user = { AdminId, RoleId, ... })
// ─────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { pool } = require('../db');   // adjust path as needed
const XLSX     = require('xlsx');

// ── Helpers ──────────────────────────────────────────────────

/** ดึงรายการ ExamId ที่ติวเตอร์นี้เป็นเจ้าของ */
async function getTutorExamIds(tutorId) {
  const [rows] = await pool.execute(
    'SELECT ExamId FROM exam WHERE UserId = ? AND Deleted_at IS NULL',
    [tutorId]
  );
  return rows.map(r => r.ExamId);
}

/** ตรวจสอบว่า exam นี้เป็นของติวเตอร์นี้ */
async function assertExamOwner(examId, tutorId, res) {
  const [[exam]] = await pool.execute(
    'SELECT ExamId FROM exam WHERE ExamId = ? AND UserId = ? AND Deleted_at IS NULL',
    [examId, tutorId]
  );
  if (!exam) {
    res.status(403).json({ error: 'Access denied or exam not found' });
    return false;
  }
  return true;
}

/** คำนวณ D-index ใน JS (cross-student, ทำใน DB ยาก) */
function calcDIndex(allAnswers, questionId, upperUserIds, lowerUserIds) {
  const qRows = allAnswers.filter(r => r.QuestionId === questionId);
  const uLen  = upperUserIds.length;
  const lLen  = lowerUserIds.length;
  if (!uLen || !lLen) return 0;
  const uC = qRows.filter(r => upperUserIds.includes(r.UserId) && r.IsCorrect).length;
  const lC = qRows.filter(r => lowerUserIds.includes(r.UserId) && r.IsCorrect).length;
  return Math.round(((uC / uLen) - (lC / lLen)) * 10000) / 10000;
}

// ─────────────────────────────────────────────────────────────
//  GET /exams
//  ดึงรายการ exam ที่ติวเตอร์สร้าง (สำหรับ Selector)
//  Query: courseId?, subjectId?
// ─────────────────────────────────────────────────────────────
router.get('/exams', async (req, res) => {
  const { courseId, subjectId } = req.query;
  const tutorId = req.user.AdminId;

  try {
    const params = [tutorId];
    let extra = '';
    if (courseId)   { extra += ' AND e.CourseID = ?';   params.push(courseId); }
    if (subjectId)  { extra += ' AND e.SubjectId = ?';  params.push(subjectId); }

    const [rows] = await pool.execute(`
      SELECT
        e.ExamId,
        e.ExamDate,
        e.CourseID,
        e.SubjectId,
        e.PassPct,
        e.TotalMaxScore,
        et.ExamTypeId,
        et.ExamTypeName,
        c.CourseName,
        s.SubjectName,
        COUNT(DISTINCT ej.UserId)                                      AS studentJoined,
        COUNT(DISTINCT CASE WHEN ej.Status = 'submitted' THEN ej.UserId END) AS studentSubmitted,
        ROUND(AVG(CASE WHEN ej.Status='submitted' THEN ej.Score/ej.MaxScore*100 END), 2) AS avgPct
      FROM exam e
      JOIN examtype et ON e.ExamTypeId = et.ExamTypeId
      JOIN courses  c  ON e.CourseID   = c.CourseID
      LEFT JOIN subjects s ON e.SubjectId = s.SubjectId
      LEFT JOIN exam_join ej ON ej.ExamId = e.ExamId
      WHERE e.UserId = ?
        AND e.Deleted_at IS NULL
        ${extra}
      GROUP BY e.ExamId
      ORDER BY e.ExamDate DESC, et.ExamTypeId ASC
    `, params);

    res.json({ exams: rows });
  } catch (err) {
    console.error('[analytics/exams]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /overview
//  ภาพรวม: stat cards, histogram, topic stats, student heatmap
//  Query: examId (required), passPct?
// ─────────────────────────────────────────────────────────────
router.get('/overview', async (req, res) => {
  const { examId, passPct = 60 } = req.query;
  const tutorId = req.user.AdminId;

  if (!examId) return res.status(400).json({ error: 'examId is required' });
  if (!await assertExamOwner(examId, tutorId, res)) return;

  try {
    // ── 1. Summary stats ──────────────────────────────────────
    const [[summary]] = await pool.execute(`
      SELECT
        COUNT(*)                                                     AS totalStudents,
        ROUND(AVG(ej.Score / ej.MaxScore * 100), 2)                  AS avgPct,
        ROUND(STDDEV(ej.Score / ej.MaxScore * 100), 2)               AS stdDev,
        ROUND(MAX(ej.Score), 2)                                       AS maxScore,
        ROUND(MIN(ej.Score), 2)                                       AS minScore,
        ROUND(MAX(ej.Score / ej.MaxScore * 100), 2)                  AS maxPct,
        ROUND(MIN(ej.Score / ej.MaxScore * 100), 2)                  AS minPct,
        SUM(ej.IsPassed)                                              AS passCount,
        ROUND(SUM(ej.IsPassed) / COUNT(*) * 100, 2)                  AS passRate,
        ROUND(AVG(ej.TimeTakenSec), 0)                               AS avgTimeSec,
        MAX(ej.MaxScore)                                              AS maxScoreTotal
      FROM exam_join ej
      WHERE ej.ExamId = ? AND ej.Status = 'submitted' AND ej.MaxScore > 0
    `, [examId]);

    // ── 2. Score Histogram (10 buckets 0-9) ───────────────────
    const [histRaw] = await pool.execute(`
      SELECT
        LEAST(FLOOR(ej.Score / ej.MaxScore * 10), 9) AS bucket,
        COUNT(*) AS count
      FROM exam_join ej
      WHERE ej.ExamId = ? AND ej.Status = 'submitted' AND ej.MaxScore > 0
      GROUP BY bucket
      ORDER BY bucket
    `, [examId]);

    const RANGES = ['0–10%','10–20%','20–30%','30–40%','40–50%','50–60%','60–70%','70–80%','80–90%','90–100%'];
    const histogram = RANGES.map((range, i) => ({
      range,
      count: (histRaw.find(r => r.bucket === i) || { count: 0 }).count
    }));

    // ── 3. Topic stats (ถ้ามี exam_questions + exam_student_answers) ─
    let topicStats = [];
    try {
      const [tRows] = await pool.execute(`
        SELECT
          q.Topic,
          ROUND(
            SUM(a.IsCorrect * q.Score) / SUM(q.Score) * 100
          , 2) AS avgPct,
          SUM(q.Score) / COUNT(DISTINCT a.UserId) AS maxScore
        FROM exam_student_answers a
        JOIN exam_questions q ON a.QuestionId = q.QuestionId
        WHERE a.ExamId = ?
        GROUP BY q.Topic
        ORDER BY q.Topic
      `, [examId]);
      topicStats = tRows;
    } catch (_) { /* ตารางอาจยังไม่มีข้อมูล */ }

    // ── 4. Student heatmap ────────────────────────────────────
    let studentHeatmap = [];
    try {
      const [hmRows] = await pool.execute(`
        SELECT
          u.UserId,
          CONCAT(u.Firstname, ' ', u.Lastname) AS name,
          u.Nickname,
          ej.Score,
          ej.MaxScore,
          ROUND(ej.Score / ej.MaxScore * 100, 2)  AS totalPct,
          ej.IsPassed                               AS passed,
          q.Topic,
          ROUND(SUM(a.IsCorrect * q.Score) / SUM(q.Score) * 100, 2) AS topicPct
        FROM exam_join ej
        JOIN users u ON ej.UserId = u.UserId
        LEFT JOIN exam_student_answers a ON a.ExamId = ej.ExamId AND a.UserId = ej.UserId
        LEFT JOIN exam_questions q ON a.QuestionId = q.QuestionId
        WHERE ej.ExamId = ? AND ej.Status = 'submitted'
        GROUP BY ej.UserId, q.Topic
        ORDER BY totalPct DESC
      `, [examId]);

      // group by student → pivot topic
      const byStudent = {};
      hmRows.forEach(r => {
        if (!byStudent[r.UserId]) {
          byStudent[r.UserId] = {
            userId: r.UserId, name: r.name, nickname: r.Nickname,
            totalPct: r.totalPct, passed: r.passed, topics: {}
          };
        }
        if (r.Topic) byStudent[r.UserId].topics[r.Topic] = r.topicPct;
      });
      studentHeatmap = Object.values(byStudent);
    } catch (_) {
      // fallback: ดึง student list ไม่มี topic breakdown
      const [simpleRows] = await pool.execute(`
        SELECT
          u.UserId,
          CONCAT(u.Firstname, ' ', u.Lastname) AS name,
          u.Nickname,
          ROUND(ej.Score / ej.MaxScore * 100, 2) AS totalPct,
          ej.IsPassed AS passed
        FROM exam_join ej
        JOIN users u ON ej.UserId = u.UserId
        WHERE ej.ExamId = ? AND ej.Status = 'submitted'
        ORDER BY totalPct DESC
      `, [examId]);
      studentHeatmap = simpleRows.map(r => ({ ...r, topics: {} }));
    }

    res.json({ summary, histogram, topicStats, studentHeatmap });
  } catch (err) {
    console.error('[analytics/overview]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /items
//  วิเคราะห์ข้อสอบ: P-value, D-index, option distribution
//  Query: examId (required), topic?, level?
// ─────────────────────────────────────────────────────────────
router.get('/items', async (req, res) => {
  const { examId, topic, level } = req.query;
  const tutorId = req.user.AdminId;

  if (!examId) return res.status(400).json({ error: 'examId is required' });
  if (!await assertExamOwner(examId, tutorId, res)) return;

  try {
    // ── รายข้อ + option distribution + P-value ────────────────
    const params = [examId, examId];
    let extra = '';
    if (topic) { extra += ' AND q.Topic = ?';           params.push(topic); }
    if (level) { extra += ' AND q.DifficultyLevel = ?'; params.push(level); }

    const [questions] = await pool.execute(`
      SELECT
        q.QuestionId,
        q.QuestionNo,
        q.QuestionText  AS text,
        q.Topic,
        q.DifficultyLevel AS level,
        q.Score,
        q.CorrectOption,
        q.OptionA, q.OptionB, q.OptionC, q.OptionD,
        q.Explanation,
        COUNT(a.AnswerId)                                             AS totalAnswers,
        COALESCE(SUM(a.IsCorrect), 0)                                AS correctCount,
        COALESCE(ROUND(SUM(a.IsCorrect) / NULLIF(COUNT(*),0), 4), 0) AS pValue,
        COALESCE(ROUND(AVG(a.TimeTakenSec), 1), 0)                  AS avgTimeSec,
        COALESCE(SUM(CASE WHEN a.ChosenOption = 0 THEN 1 ELSE 0 END), 0) AS optA,
        COALESCE(SUM(CASE WHEN a.ChosenOption = 1 THEN 1 ELSE 0 END), 0) AS optB,
        COALESCE(SUM(CASE WHEN a.ChosenOption = 2 THEN 1 ELSE 0 END), 0) AS optC,
        COALESCE(SUM(CASE WHEN a.ChosenOption = 3 THEN 1 ELSE 0 END), 0) AS optD
      FROM exam_questions q
      LEFT JOIN exam_student_answers a ON a.QuestionId = q.QuestionId AND a.ExamId = ?
      WHERE q.ExamId = ? AND q.Deleted_at IS NULL
        ${extra}
      GROUP BY q.QuestionId
      ORDER BY q.QuestionNo
    `, params);

    if (!questions.length) {
      return res.json({ items: [], summary: { totalQuestions: 0, flaggedCount: 0, avgPValue: 0, avgDIndex: 0 } });
    }

    // ── คำนวณ D-index (upper 27% vs lower 27%) ───────────────
    const [allAnswers] = await pool.execute(`
      SELECT a.UserId, a.QuestionId, a.IsCorrect, ej.Score, ej.MaxScore
      FROM exam_student_answers a
      JOIN exam_join ej ON ej.ExamId = a.ExamId AND ej.UserId = a.UserId
      WHERE a.ExamId = ? AND ej.Status = 'submitted'
      ORDER BY ej.Score DESC
    `, [examId]);

    const distinctUsers = [...new Set(allAnswers.map(r => r.UserId))];
    const n     = distinctUsers.length;
    const upper = distinctUsers.slice(0, Math.ceil(n * 0.27));
    const lower = distinctUsers.slice(Math.floor(n * 0.73));

    const items = questions.map(q => {
      const dIndex  = calcDIndex(allAnswers, q.QuestionId, upper, lower);
      const flag    = q.pValue < 0.25 || q.pValue > 0.92 || dIndex < 0.15;
      const reasons = [];
      if (q.pValue < 0.25) reasons.push('P-value ต่ำมาก — ข้อนี้อาจยากเกินไปหรือโจทย์ไม่ชัดเจน');
      if (q.pValue > 0.92) reasons.push('P-value สูงมาก — ข้อนี้อาจง่ายเกินไป');
      if (dIndex < 0.15)   reasons.push('D-index ต่ำ — ไม่ช่วยแยกแยะความสามารถนักเรียน');
      return {
        ...q,
        pValue:  Number(q.pValue),
        dIndex,
        flag,
        flagReasons: reasons,
        optCounts: [Number(q.optA), Number(q.optB), Number(q.optC), Number(q.optD)],
      };
    });

    const flaggedCount = items.filter(q => q.flag).length;
    const avgPValue    = items.reduce((s, q) => s + q.pValue, 0) / items.length;
    const avgDIndex    = items.reduce((s, q) => s + q.dIndex, 0) / items.length;

    res.json({ items, summary: { totalQuestions: items.length, flaggedCount, avgPValue: Math.round(avgPValue*10000)/10000, avgDIndex: Math.round(avgDIndex*10000)/10000 } });
  } catch (err) {
    console.error('[analytics/items]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /students
//  รายชื่อนักเรียน + คะแนน + rank
//  Query: examId (required), search?, passed?, page?, limit?
// ─────────────────────────────────────────────────────────────
router.get('/students', async (req, res) => {
  const { examId, search, passed, page = 1, limit = 100 } = req.query;
  const tutorId = req.user.AdminId;

  if (!examId) return res.status(400).json({ error: 'examId is required' });
  if (!await assertExamOwner(examId, tutorId, res)) return;

  try {
    const offset = (Number(page) - 1) * Number(limit);
    const params = [examId];
    let where = '';
    if (search) {
      where += ` AND (u.Firstname LIKE ? OR u.Lastname LIKE ? OR u.Nickname LIKE ?)`;
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (passed !== undefined && passed !== '') {
      where += ' AND ej.IsPassed = ?';
      params.push(Number(passed));
    }

    const [students] = await pool.execute(`
      SELECT
        u.UserId,
        CONCAT(u.Firstname, ' ', u.Lastname) AS name,
        u.Nickname,
        ROUND(ej.Score, 2)                        AS totalScore,
        ROUND(ej.MaxScore, 2)                     AS maxScore,
        ROUND(ej.Score / ej.MaxScore * 100, 2)    AS pct,
        ej.IsPassed                               AS passed,
        ej.TimeTakenSec,
        ej.SubmittedAt,
        RANK() OVER (ORDER BY ej.Score DESC)      AS rank
      FROM exam_join ej
      JOIN users u ON ej.UserId = u.UserId
      WHERE ej.ExamId = ? AND ej.Status = 'submitted' AND ej.MaxScore > 0
        ${where}
      ORDER BY ej.Score DESC
      LIMIT ? OFFSET ?
    `, [...params, Number(limit), offset]);

    // topic breakdown ต่อนักเรียน (ถ้ามีข้อมูล)
    let topicByUser = {};
    try {
      const userIds = students.map(s => s.UserId);
      if (userIds.length) {
        const placeholders = userIds.map(() => '?').join(',');
        const [tRows] = await pool.execute(`
          SELECT
            a.UserId,
            q.Topic,
            ROUND(SUM(a.IsCorrect * q.Score) / SUM(q.Score) * 100, 2) AS topicPct
          FROM exam_student_answers a
          JOIN exam_questions q ON a.QuestionId = q.QuestionId
          WHERE a.ExamId = ? AND a.UserId IN (${placeholders})
          GROUP BY a.UserId, q.Topic
        `, [examId, ...userIds]);
        tRows.forEach(r => {
          if (!topicByUser[r.UserId]) topicByUser[r.UserId] = {};
          topicByUser[r.UserId][r.Topic] = r.topicPct;
        });
      }
    } catch (_) {}

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM exam_join WHERE ExamId = ? AND Status = 'submitted' AND MaxScore > 0`,
      [examId]
    );

    const result = students.map(s => ({
      ...s,
      topicPcts: topicByUser[s.UserId] || {}
    }));

    res.json({ students: result, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('[analytics/students]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /students/:userId
//  รายละเอียดนักเรียนรายคน (drill-down modal)
//  Params: userId  Query: examId (required)
// ─────────────────────────────────────────────────────────────
router.get('/students/:userId', async (req, res) => {
  const { userId } = req.params;
  const { examId }  = req.query;
  const tutorId     = req.user.AdminId;

  if (!examId) return res.status(400).json({ error: 'examId is required' });
  if (!await assertExamOwner(examId, tutorId, res)) return;

  try {
    const [[student]] = await pool.execute(`
      SELECT
        u.UserId,
        CONCAT(u.Firstname, ' ', u.Lastname) AS name,
        u.Nickname,
        ROUND(ej.Score, 2)                      AS totalScore,
        ROUND(ej.MaxScore, 2)                   AS maxScore,
        ROUND(ej.Score / ej.MaxScore * 100, 2)  AS pct,
        ej.IsPassed                             AS passed,
        ej.TimeTakenSec,
        ej.SubmittedAt
      FROM exam_join ej
      JOIN users u ON ej.UserId = u.UserId
      WHERE ej.ExamId = ? AND ej.UserId = ? AND ej.MaxScore > 0
    `, [examId, userId]);

    if (!student) return res.status(404).json({ error: 'Student not found in this exam' });

    // รายข้อ
    const [answers] = await pool.execute(`
      SELECT
        q.QuestionNo,
        q.QuestionText,
        q.Topic,
        q.DifficultyLevel AS level,
        q.Score,
        q.CorrectOption,
        a.ChosenOption,
        a.IsCorrect,
        a.TimeTakenSec
      FROM exam_student_answers a
      JOIN exam_questions q ON a.QuestionId = q.QuestionId
      WHERE a.ExamId = ? AND a.UserId = ?
      ORDER BY q.QuestionNo
    `, [examId, userId]);

    // topic breakdown
    const topicMap = {};
    answers.forEach(a => {
      if (!a.Topic) return;
      if (!topicMap[a.Topic]) topicMap[a.Topic] = { score: 0, maxScore: 0 };
      topicMap[a.Topic].score    += a.IsCorrect ? Number(a.Score) : 0;
      topicMap[a.Topic].maxScore += Number(a.Score);
    });
    const topicBreakdown = Object.entries(topicMap).map(([topic, s]) => ({
      topic, ...s,
      pct: s.maxScore > 0 ? Math.round(s.score / s.maxScore * 100) : 0
    }));

    res.json({ ...student, topicBreakdown, answers });
  } catch (err) {
    console.error('[analytics/students/:userId]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /compare
//  เปรียบเทียบ Pre / Mid / Post-test
//  Query: courseId (required), subjectId?
// ─────────────────────────────────────────────────────────────
router.get('/compare', async (req, res) => {
  const { courseId, subjectId } = req.query;
  const tutorId = req.user.AdminId;

  if (!courseId) return res.status(400).json({ error: 'courseId is required' });

  try {
    const params = [tutorId, courseId];
    let extra = '';
    if (subjectId) { extra += ' AND e.SubjectId = ?'; params.push(subjectId); }

    // ── exam list ──────────────────────────────────────────────
    const [exams] = await pool.execute(`
      SELECT
        e.ExamId,
        et.ExamTypeId,
        et.ExamTypeName                                                AS examType,
        e.ExamDate,
        ROUND(AVG(ej.Score / ej.MaxScore * 100), 2)                  AS avgPct,
        ROUND(SUM(ej.IsPassed) / NULLIF(COUNT(*), 0) * 100, 2)       AS passRate,
        COUNT(ej.UserId)                                              AS studentCount
      FROM exam e
      JOIN examtype et ON e.ExamTypeId = et.ExamTypeId
      LEFT JOIN exam_join ej ON ej.ExamId = e.ExamId AND ej.Status = 'submitted' AND ej.MaxScore > 0
      WHERE e.UserId = ? AND e.CourseID = ?
        AND e.Deleted_at IS NULL
        ${extra}
      GROUP BY e.ExamId
      ORDER BY et.ExamTypeId, e.ExamDate
    `, params);

    if (!exams.length) return res.json({ exams: [], topicTrend: [], studentProgress: [] });

    const examIds = exams.map(e => e.ExamId);
    const ph      = examIds.map(() => '?').join(',');

    // ── topic trend ────────────────────────────────────────────
    let topicTrend = [];
    try {
      const [tRows] = await pool.execute(`
        SELECT
          a.ExamId,
          et.ExamTypeName,
          q.Topic,
          ROUND(SUM(a.IsCorrect * q.Score) / NULLIF(SUM(q.Score), 0) * 100, 2) AS avgPct
        FROM exam_student_answers a
        JOIN exam_questions q  ON a.QuestionId = q.QuestionId
        JOIN exam e            ON a.ExamId = e.ExamId
        JOIN examtype et       ON e.ExamTypeId = et.ExamTypeId
        WHERE a.ExamId IN (${ph})
        GROUP BY a.ExamId, q.Topic
        ORDER BY et.ExamTypeId, q.Topic
      `, examIds);

      // pivot: topic → { pre, mid, post }
      const topicMap = {};
      tRows.forEach(r => {
        if (!topicMap[r.Topic]) topicMap[r.Topic] = { topic: r.Topic };
        topicMap[r.Topic][r.ExamTypeName] = r.avgPct;
      });
      topicTrend = Object.values(topicMap);
    } catch (_) {}

    // ── student progress (pre → post) ─────────────────────────
    let studentProgress = [];
    const preExam  = exams.find(e => e.examType === 'pre-test');
    const postExam = exams.find(e => e.examType === 'post-test');

    if (preExam && postExam) {
      const [sp] = await pool.execute(`
        SELECT
          u.UserId,
          CONCAT(u.Firstname,' ',u.Lastname) AS name,
          ROUND(pre.Score / pre.MaxScore * 100, 2)  AS preScore,
          ROUND(post.Score / post.MaxScore * 100, 2) AS postScore,
          ROUND((post.Score/post.MaxScore - pre.Score/pre.MaxScore) * 100, 2) AS delta
        FROM exam_join pre
        JOIN exam_join post ON pre.UserId = post.UserId
          AND post.ExamId = ? AND post.Status = 'submitted' AND post.MaxScore > 0
        JOIN users u ON pre.UserId = u.UserId
        WHERE pre.ExamId = ? AND pre.Status = 'submitted' AND pre.MaxScore > 0
        ORDER BY delta DESC
      `, [postExam.ExamId, preExam.ExamId]);
      studentProgress = sp;
    }

    res.json({ exams, topicTrend, studentProgress });
  } catch (err) {
    console.error('[analytics/compare]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /export
//  Export Excel — students + item analysis
//  Query: examId (required), type? (all|students|items)
// ─────────────────────────────────────────────────────────────
router.get('/export', async (req, res) => {
  const { examId, type = 'all' } = req.query;
  const tutorId = req.user.AdminId;

  if (!examId) return res.status(400).json({ error: 'examId is required' });
  if (!await assertExamOwner(examId, tutorId, res)) return;

  try {
    const wb = XLSX.utils.book_new();

    if (type === 'all' || type === 'students') {
      const [students] = await pool.execute(`
        SELECT
          RANK() OVER (ORDER BY ej.Score DESC)       AS อันดับ,
          CONCAT(u.Firstname,' ',u.Lastname)          AS ชื่อนักเรียน,
          u.Nickname                                  AS ชื่อเล่น,
          ROUND(ej.Score, 2)                          AS คะแนนที่ได้,
          ROUND(ej.MaxScore, 2)                       AS คะแนนเต็ม,
          CONCAT(ROUND(ej.Score/ej.MaxScore*100,1),'%') AS เปอร์เซ็นต์,
          IF(ej.IsPassed,'ผ่าน','ไม่ผ่าน')            AS ผลการสอบ,
          ROUND(ej.TimeTakenSec/60,0)                AS เวลาที่ใช้_นาที,
          DATE_FORMAT(ej.SubmittedAt,'%d/%m/%Y %H:%i') AS เวลาส่ง
        FROM exam_join ej
        JOIN users u ON ej.UserId = u.UserId
        WHERE ej.ExamId = ? AND ej.Status = 'submitted' AND ej.MaxScore > 0
        ORDER BY ej.Score DESC
      `, [examId]);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(students), 'ผลนักเรียน');
    }

    if (type === 'all' || type === 'items') {
      const [items] = await pool.execute(`
        SELECT
          q.QuestionNo                   AS ข้อที่,
          q.QuestionText                 AS โจทย์,
          q.Topic                        AS หัวข้อ,
          q.DifficultyLevel              AS ระดับ,
          q.Score                        AS คะแนนต่อข้อ,
          ROUND(SUM(a.IsCorrect)/COUNT(*)*100,1) AS P_value_pct,
          ROUND(AVG(a.TimeTakenSec),0)   AS เวลาเฉลี่ย_วิ,
          SUM(CASE WHEN a.ChosenOption=0 THEN 1 ELSE 0 END) AS เลือก_A,
          SUM(CASE WHEN a.ChosenOption=1 THEN 1 ELSE 0 END) AS เลือก_B,
          SUM(CASE WHEN a.ChosenOption=2 THEN 1 ELSE 0 END) AS เลือก_C,
          SUM(CASE WHEN a.ChosenOption=3 THEN 1 ELSE 0 END) AS เลือก_D
        FROM exam_questions q
        LEFT JOIN exam_student_answers a ON a.QuestionId = q.QuestionId AND a.ExamId = ?
        WHERE q.ExamId = ? AND q.Deleted_at IS NULL
        GROUP BY q.QuestionId
        ORDER BY q.QuestionNo
      `, [examId, examId]);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(items), 'วิเคราะห์ข้อสอบ');
    }

    const [[examInfo]] = await pool.execute(
      'SELECT et.ExamTypeName, e.ExamDate FROM exam e JOIN examtype et ON e.ExamTypeId = et.ExamTypeId WHERE e.ExamId = ?',
      [examId]
    );
    const filename = `analytics_${examInfo.ExamTypeName}_${examInfo.ExamDate}.xlsx`.replace(/\s/g,'_');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  } catch (err) {
    console.error('[analytics/export]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;