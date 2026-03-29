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

//เป้ว
const tutorRoutes = require('./routes/tutor.routes');
const newsRoute = require('./routes/news.routes');
const tutorContentRoutes = require('./routes/tutorContent.routes');
const tutorIncomeRoute = require('./routes/tutor.income.routes');

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'Express + MySQL2 + JWT' });
});


app.use('/auth', authRoutes);
app.use('/products', productRoutes);
app.use('/courses', coursesRoutes);

//เป้ว
app.use('/api/tutor', tutorRoutes);
app.use('/api/news', newsRoute);
app.use('/api/tutor-content', tutorContentRoutes);
app.use('/api/tutor', tutorIncomeRoute);   // รายได้ → /api/tutor/income/:adminId

// 3. ทำให้โฟลเดอร์ uploads เข้าถึงได้จากหน้าเว็บ (สำคัญมาก!)
app.use('/uploads', express.static('uploads'));

//404 Handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});


//Start Server
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`✅ API running at http://localhost:${PORT}`);
});

