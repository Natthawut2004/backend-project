const { pool } = require('./db');

async function migrate() {
  try {
    console.log('Running migration...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS news_images (
        ImageId    INT(11)      NOT NULL AUTO_INCREMENT,
        NewsId     INT(11)      NOT NULL,
        ImagePath  VARCHAR(255) NOT NULL,
        SortOrder  INT(11)      NOT NULL DEFAULT 0,
        Created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ImageId),
        KEY idx_news_images_newsid (NewsId),
        CONSTRAINT fk_news_images_news
          FOREIGN KEY (NewsId) REFERENCES news (NewsId)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci
    `);

    console.log('✅ Migration สำเร็จ: สร้างตาราง news_images แล้ว');
  } catch (err) {
    console.error('❌ Migration ล้มเหลว:', err.message);
  } finally {
    process.exit();
  }
}

migrate();