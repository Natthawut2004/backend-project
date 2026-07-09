// app.js
const express = require('express');
require('dotenv').config();
const path = require('path');

const app = express();
app.use(express.json());
const cors = require('cors');
app.use(cors())
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


//Routes
const productRoutes = require('./routes/products.routes');
const authRoutes = require('./routes/auth.routes');
const coursesRoutes = require('./routes/courses.routes');
const studentCoursesRoutes = require('./routes/student.courses.routes'); // ✅ ใหม่: course ฝั่ง student/public
const studentRoutes = require('./routes/student.routes');


//เป้ว
const tutorRoutes = require('./routes/tutor.routes');
const newsRoute = require('./routes/news.routes');
const tutorContentRoutes = require('./routes/tutorContent.routes');
const tutorIncomeRoute = require('./routes/tutor.income.routes');
const adminCourses = require('./routes/admin.courses.routes');
const adminTutorsRoutes   = require('./routes/admin.tutors.routes');
const adminStudentsRoutes = require('./routes/admin.students.routes');
const adminSeheduleRoutes = require('./routes/admin.schedule.routes');
const holidaysRouter = require('./routes/admin.holidays.routes');
const adminAnnoumcement = require('./routes/admin.announcement.routes');

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'Express + MySQL2 + JWT' });
});


app.use('/auth', authRoutes);
app.use('/products', productRoutes);

// ⚠️ ลำดับสำคัญ: ต้อง mount studentCoursesRoutes ก่อน coursesRoutes เสมอ
// เพราะทั้งคู่ mount ที่ path เดียวกัน (/courses)
// studentCoursesRoutes จะดัก GET / และ GET /:id ไปตอบก่อน
// ส่วน POST/PUT/DELETE/:id/students ฯลฯ ที่ไม่มีใน studentCoursesRoutes
// จะถูกส่งต่อ (fall through) ไปให้ coursesRoutes (ของเดิม) จัดการตามปกติ
app.use('/courses', studentCoursesRoutes);
app.use('/courses', coursesRoutes);

app.use('/api/student', studentRoutes)

//เป้ว
app.use('/api/tutor', tutorRoutes);
app.use('/api/news', newsRoute);
app.use('/api/tutor-content', tutorContentRoutes);
app.use('/api/tutor', tutorIncomeRoute);   // รายได้ → /api/tutor/income/:adminId
app.use('/api/admin', adminCourses);
app.use('/api/admin', adminTutorsRoutes);
app.use('/api/admin', adminStudentsRoutes);
app.use('/api/admin/schedule', adminSeheduleRoutes);
app.use('/api/admin/holidays', holidaysRouter);
app.use('/api/admin/news', adminAnnoumcement);

//404 Handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});


//Start Server
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});