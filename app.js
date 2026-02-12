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

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'Express + MySQL2 + JWT' });
});


app.use('/auth', authRoutes);
app.use('/products', productRoutes);
app.use('/courses', coursesRoutes);


//404 Handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});


//Start Server
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`✅ API running at http://localhost:${PORT}`);
});

