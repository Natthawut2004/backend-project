const jwt = require('jsonwebtoken')
const { pool } = require('../db')


exports.authRequired = async (req, res , next) =>{
    const auth = req.headers.authorization;
    if(!auth?.startsWith('Bearer '))
        return res.status(401).json({message : 'No Token Provided'})
    const token = auth.split(' ')[1];

    try {
        const decoded = jwt.verify(token , process.env.JWT_SECRET)

        const [rows] = await pool.query('select * from tokens where token = ?' , [token])
        if(!rows.length) return res.status(401).json({message : " Invalid token "})

        req.user = decoded
        req.token = token
        next();
    }catch{
        res.status(401).json({message : 'Invalid token'})
    }
}

exports.requireRole = (role) =>{
    return (req, res, next) =>{
        if(req.user?.role !== role){
            return res.status(403).json({message:"Forbideden : Need role " + role})
        }
        next();
    }
}