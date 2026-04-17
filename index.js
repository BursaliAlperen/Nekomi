const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SQLite veritabanı (Render Disk'te kalıcı olması için /data klasörü)
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'nekomigrow.db');
const db = new sqlite3.Database(dbPath);

// Tabloları oluştur
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    username TEXT,
    balance REAL DEFAULT 0,
    total_earned REAL DEFAULT 0,
    tasks_done INTEGER DEFAULT 0,
    referrals INTEGER DEFAULT 0,
    ref_earned REAL DEFAULT 0,
    referral_code TEXT,
    referred_by INTEGER,
    is_admin INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    type TEXT,
    subtype TEXT,
    icon TEXT,
    reward REAL,
    slots INTEGER,
    total_slots INTEGER,
    time_left TEXT,
    category TEXT,
    url TEXT,
    video_url TEXT,
    is_active INTEGER DEFAULT 1,
    requires_screenshot INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    user_id INTEGER,
    screenshot_url TEXT,
    status TEXT DEFAULT 'pending',
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME,
    reviewer_id INTEGER,
    rejection_reason TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT,
    title TEXT,
    amount REAL,
    date DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Örnek görevler (boşsa ekle)
  db.get(`SELECT COUNT(*) as count FROM tasks`, (err, row) => {
    if (row.count === 0) {
      const stmt = db.prepare(`INSERT INTO tasks (title, type, subtype, icon, reward, slots, total_slots, time_left, category, url) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      stmt.run('TechStartup Retweet', 'twitter', 'RETWEET', 'fab fa-twitter', 0.01, 145, 200, '23s', 'twitter', 'https://x.com/techstartup');
      stmt.run('Crypto News Beğen', 'twitter', 'LIKE', 'fab fa-twitter', 0.005, 89, 100, '1g', 'twitter', 'https://x.com/cryptonews');
      stmt.run('Tech Kanalına Katıl', 'telegram', 'CHANNEL', 'fab fa-telegram', 0.008, 210, 500, '12s', 'telegram', 'https://t.me/technews');
      stmt.run('YouTube Abone Ol', 'youtube', 'SUBSCRIBE', 'fab fa-youtube', 0.015, 33, 100, '3g', 'youtube', 'https://youtube.com/c/tech');
      stmt.finalize();
    }
  });
});

// ==================== YARDIMCI FONKSİYONLAR ====================
function generateReferralCode(telegramId) {
  return `ref_${telegramId}`;
}

// ==================== API ENDPOINTLERİ ====================

// Kullanıcı kaydı / girişi (Telegram ID ile otomatik)
app.post('/api/auth', async (req, res) => {
  const { telegramId, firstName, lastName, username, referredBy } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'Telegram ID gerekli' });

  db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegramId], async (err, user) => {
    if (err) return res.status(500).json({ error: err.message });

    if (!user) {
      const referralCode = generateReferralCode(telegramId);
      db.run(
        `INSERT INTO users (telegram_id, first_name, last_name, username, referral_code, referred_by) VALUES (?,?,?,?,?,?)`,
        [telegramId, firstName, lastName, username, referralCode, referredBy || null],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });
          // Referans bonusu
          if (referredBy) {
            db.run(`UPDATE users SET balance = balance + 0.05, ref_earned = ref_earned + 0.05, referrals = referrals + 1 WHERE telegram_id = ?`, [referredBy]);
          }
          res.json({ success: true, isNew: true, referralCode });
        }
      );
    } else {
      res.json({ success: true, isNew: false, user });
    }
  });
});

// Kullanıcı bilgilerini getir
app.get('/api/user/:telegramId', (req, res) => {
  db.get(`SELECT * FROM users WHERE telegram_id = ?`, [req.params.telegramId], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(user);
  });
});

// Aktif görevleri listele
app.get('/api/tasks', (req, res) => {
  db.all(`SELECT * FROM tasks WHERE is_active = 1`, (err, tasks) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(tasks);
  });
});

// Görev teslimi (ekran görüntüsü ImgBB'ye frontend'den yüklenir, URL buraya gönderilir)
app.post('/api/submit-task', (req, res) => {
  const { taskId, userId, screenshotUrl } = req.body;
  if (!taskId || !userId || !screenshotUrl) return res.status(400).json({ error: 'Eksik bilgi' });

  db.run(
    `INSERT INTO submissions (task_id, user_id, screenshot_url, status) VALUES (?,?,?, 'pending')`,
    [taskId, userId, screenshotUrl],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, submissionId: this.lastID });
    }
  );
});

// Kullanıcı işlem geçmişi
app.get('/api/transactions/:userId', (req, res) => {
  db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC LIMIT 20`, [req.params.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Admin: Tüm kullanıcılar
app.get('/api/admin/users', (req, res) => {
  db.all(`SELECT * FROM users`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Admin: Bakiye güncelle
app.post('/api/admin/update-balance', (req, res) => {
  const { telegramId, balance } = req.body;
  db.run(`UPDATE users SET balance = ? WHERE telegram_id = ?`, [balance, telegramId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Admin: Görev ekle
app.post('/api/admin/add-task', (req, res) => {
  const { title, type, subtype, icon, reward, slots, totalSlots, timeLeft, category, url, videoUrl } = req.body;
  db.run(
    `INSERT INTO tasks (title, type, subtype, icon, reward, slots, total_slots, time_left, category, url, video_url) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [title, type, subtype, icon, reward, slots, totalSlots, timeLeft, category, url, videoUrl],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, taskId: this.lastID });
    }
  );
});

// Admin: Onay bekleyen gönderiler
app.get('/api/admin/pending-submissions', (req, res) => {
  db.all(`SELECT s.*, t.title as task_title, u.first_name FROM submissions s 
          JOIN tasks t ON s.task_id = t.id 
          JOIN users u ON s.user_id = u.telegram_id 
          WHERE s.status = 'pending'`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Admin: Gönderi onayla / reddet
app.post('/api/admin/review-submission', (req, res) => {
  const { submissionId, status, reviewerId } = req.body;
  db.get(`SELECT * FROM submissions WHERE id = ?`, [submissionId], (err, submission) => {
    if (err || !submission) return res.status(404).json({ error: 'Gönderi bulunamadı' });

    db.run(`UPDATE submissions SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewer_id = ? WHERE id = ?`, [status, reviewerId, submissionId], (err) => {
      if (err) return res.status(500).json({ error: err.message });

      if (status === 'approved') {
        db.get(`SELECT reward FROM tasks WHERE id = ?`, [submission.task_id], (err, task) => {
          if (!err && task) {
            db.run(`UPDATE users SET balance = balance + ?, total_earned = total_earned + ?, tasks_done = tasks_done + 1 WHERE telegram_id = ?`, [task.reward, task.reward, submission.user_id]);
            db.run(`INSERT INTO transactions (user_id, type, title, amount) VALUES (?, 'earn', 'Görev Onaylandı', ?)`, [submission.user_id, task.reward]);
          }
        });
      }
      res.json({ success: true });
    });
  });
});

// Ana sayfa (SPA için index.html'i gönder)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Sunucuyu başlat
app.listen(PORT, () => {
  console.log(`NekomiGrow backend ${PORT} portunda çalışıyor`);
});
