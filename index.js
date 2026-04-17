const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Firebase Admin SDK başlat
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      clientId: process.env.FIREBASE_CLIENT_ID,
      authUri: process.env.FIREBASE_AUTH_URI,
      tokenUri: process.env.FIREBASE_TOKEN_URI,
      authProviderX509CertUrl: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
      clientX509CertUrl: process.env.FIREBASE_CLIENT_CERT_URL
    })
  });
}

const dbFirestore = admin.firestore();

// SQLite veritabanı (yerel yedek/önbellek)
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
    double_reward INTEGER DEFAULT 0,
    slots INTEGER,
    total_slots INTEGER,
    time_left TEXT,
    category TEXT,
    url TEXT,
    video_url TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    user_id INTEGER,
    task_title TEXT,
    screenshot_url TEXT,
    reward REAL,
    status TEXT DEFAULT 'pending',
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT,
    title TEXT,
    amount REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ==================== API ENDPOINTLERİ ====================

// Config endpoint'i
app.get('/api/config', (req, res) => {
  res.json({
    firebaseApiKey: process.env.FIREBASE_API_KEY,
    firebaseAuthDomain: process.env.FIREBASE_AUTH_DOMAIN,
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
    firebaseStorageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    firebaseMessagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    firebaseAppId: process.env.FIREBASE_APP_ID,
    imgbbApiKey: process.env.IMGBB_API_KEY,
    adminId: parseInt(process.env.ADMIN_ID) || 7904032877
  });
});

// Kullanıcı girişi / kayıt
app.post('/api/auth', async (req, res) => {
  const { telegramId, firstName, lastName, username, referredBy } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'Telegram ID gerekli' });

  try {
    const userRef = dbFirestore.collection('users').doc(telegramId.toString());
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      const userData = {
        telegramId,
        firstName,
        lastName: lastName || '',
        username: username || '',
        balance: 0,
        totalEarned: 0,
        tasksDone: 0,
        referrals: 0,
        refEarned: 0,
        referralCode: `ref_${telegramId}`,
        referredBy: referredBy || null,
        isAdmin: telegramId === parseInt(process.env.ADMIN_ID),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      await userRef.set(userData);

      // Referans bonusu
      if (referredBy) {
        const refUserRef = dbFirestore.collection('users').doc(referredBy.toString());
        await refUserRef.update({
          balance: admin.firestore.FieldValue.increment(0.05),
          refEarned: admin.firestore.FieldValue.increment(0.05),
          referrals: admin.firestore.FieldValue.increment(1)
        });
      }

      res.json({ success: true, isNew: true, user: userData });
    } else {
      res.json({ success: true, isNew: false, user: userDoc.data() });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Kullanıcı bilgisi
app.get('/api/user/:telegramId', async (req, res) => {
  try {
    const userDoc = await dbFirestore.collection('users').doc(req.params.telegramId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(userDoc.data());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Aktif görevler
app.get('/api/tasks', async (req, res) => {
  try {
    const snapshot = await dbFirestore.collection('tasks').where('isActive', '==', true).get();
    const tasks = [];
    snapshot.forEach(doc => tasks.push({ id: doc.id, ...doc.data() }));
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Görev teslimi
app.post('/api/submit-task', async (req, res) => {
  const { taskId, userId, taskTitle, screenshotUrl, reward } = req.body;
  if (!taskId || !userId || !screenshotUrl) {
    return res.status(400).json({ error: 'Eksik bilgi' });
  }

  try {
    await dbFirestore.collection('submissions').add({
      taskId,
      userId,
      taskTitle,
      screenshotUrl,
      reward,
      status: 'pending',
      submittedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Slot azalt
    await dbFirestore.collection('tasks').doc(taskId).update({
      slots: admin.firestore.FieldValue.increment(-1)
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// İşlem geçmişi
app.get('/api/transactions/:userId', async (req, res) => {
  try {
    const snapshot = await dbFirestore.collection('transactions')
      .where('userId', '==', parseInt(req.params.userId))
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();
    
    const transactions = [];
    snapshot.forEach(doc => transactions.push({ id: doc.id, ...doc.data() }));
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Kullanıcılar
app.get('/api/admin/users', async (req, res) => {
  try {
    const snapshot = await dbFirestore.collection('users').orderBy('createdAt', 'desc').get();
    const users = [];
    snapshot.forEach(doc => users.push({ id: doc.id, ...doc.data() }));
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Görev ekle
app.post('/api/admin/add-task', async (req, res) => {
  const { title, type, subtype, icon, reward, doubleReward, slots, timeLeft, category, url, videoUrl } = req.body;
  
  try {
    const taskRef = await dbFirestore.collection('tasks').add({
      title,
      type,
      subtype,
      icon,
      reward: parseFloat(reward),
      doubleReward: doubleReward || false,
      slots: parseInt(slots),
      totalSlots: parseInt(slots),
      timeLeft: timeLeft || '∞',
      category,
      url: url || null,
      videoUrl: videoUrl || null,
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, taskId: taskRef.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Görev sil
app.delete('/api/admin/task/:taskId', async (req, res) => {
  try {
    await dbFirestore.collection('tasks').doc(req.params.taskId).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Onay bekleyenler
app.get('/api/admin/pending-submissions', async (req, res) => {
  try {
    const snapshot = await dbFirestore.collection('submissions')
      .where('status', '==', 'pending')
      .orderBy('submittedAt', 'desc')
      .get();
    
    const submissions = [];
    snapshot.forEach(doc => submissions.push({ id: doc.id, ...doc.data() }));
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Onayla
app.post('/api/admin/approve-submission', async (req, res) => {
  const { submissionId } = req.body;
  
  try {
    const subRef = dbFirestore.collection('submissions').doc(submissionId);
    const subDoc = await subRef.get();
    const submission = subDoc.data();

    await subRef.update({
      status: 'approved',
      reviewedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Kullanıcı bakiyesini güncelle
    const userRef = dbFirestore.collection('users').doc(submission.userId.toString());
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(submission.reward),
      totalEarned: admin.firestore.FieldValue.increment(submission.reward),
      tasksDone: admin.firestore.FieldValue.increment(1)
    });

    // İşlem kaydı
    await dbFirestore.collection('transactions').add({
      userId: submission.userId,
      type: 'earn',
      title: 'Görev Onaylandı: ' + submission.taskTitle,
      amount: submission.reward,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Reddet
app.post('/api/admin/reject-submission', async (req, res) => {
  const { submissionId } = req.body;
  
  try {
    await dbFirestore.collection('submissions').doc(submissionId).update({
      status: 'rejected',
      reviewedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Çekim talebi
app.post('/api/withdraw', async (req, res) => {
  const { userId, amount, address } = req.body;
  
  try {
    const userRef = dbFirestore.collection('users').doc(userId.toString());
    const userDoc = await userRef.get();
    const user = userDoc.data();

    if (user.balance < amount) {
      return res.status(400).json({ error: 'Yetersiz bakiye' });
    }

    await userRef.update({
      balance: admin.firestore.FieldValue.increment(-amount)
    });

    await dbFirestore.collection('transactions').add({
      userId,
      type: 'withdraw',
      title: 'Çekim Talebi',
      amount: -amount,
      address,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Sunucuyu başlat
app.listen(PORT, () => {
  console.log(`🚀 NekomiGrow ${PORT} portunda çalışıyor`);
  console.log(`📁 Data dizini: ${dataDir}`);
  console.log(`🔥 Firebase Admin SDK başlatıldı`);
});
