const mysql = require('mysql2/promise')
require('dotenv').config()

const pool = mysql. createPool({
host : process.env.DB_HOST,
port : Number(process.env.DB_PORT || 3306),
user : process. env.DB_USER,
password : process.env.DB_PASS,
database : process.env.DB_NAME,
waitForConnections : true,
connectionLimit : 10,
queueLimit : 0,
namedPlaceholders : true,
timezone: '+07:00',
charset: 'utf8mb4',
})

async function query(sql, params) {
    const [rows] = await pool.execute(sql,params);
    return rows
}

async function withTransaction(fn) {
    const conn = await pool.getConnection();
    try{
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result
    }catch(err){
        await conn.rollback();
        throw err
    }finally{
        conn.release() ;
    }
}

module.exports = {pool, query, withTransaction}