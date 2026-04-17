const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const https = require('https'); // YENİ EKLENDİ: Ping atmak için gerekli modül
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Firebase Admin SDK başlat
try {
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
    console.log('Firebase Admin SDK başlatıldı');
  }
} catch (error) {
  console.error('Firebase Admin SDK hatası:', error.message);
}

const db = admin.firestore();

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
  try {
    const { telegramId, firstName, lastName, username, referredBy } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Telegram ID gerekli' });

    const userRef = db.collection('users').doc(telegramId.toString());
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      const userData = {
        telegramId,
        firstName: firstName || 'Neko',
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

      if (referredBy) {
        const refUserRef = db.collection('users').doc(referredBy.toString());
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
    console.error('Auth error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Kullanıcı bilgisi
app.get('/api/user/:telegramId', async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.params.telegramId).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(userDoc.data());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Aktif görevler
app.get('/api/tasks', async (req, res) => {
  try {
    const snapshot = await db.collection('tasks').where('isActive', '==', true).get();
    const tasks = [];
    snapshot.forEach(doc => tasks.push({ id: doc.id, ...doc.data() }));
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Görev teslimi
app.post('/api/submit-task', async (req, res) => {
  try {
    const { taskId, userId, taskTitle, screenshotUrl, reward } = req.body;
    if (!taskId || !userId || !screenshotUrl) {
      return res.status(400).json({ error: 'Eksik bilgi' });
    }

    await db.collection('submissions').add({
      taskId,
      userId,
      taskTitle,
      screenshotUrl,
      reward,
      status: 'pending',
      submittedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection('tasks').doc(taskId).update({
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
    const snapshot = await db.collection('transactions')
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
    const snapshot = await db.collection('users').orderBy('createdAt', 'desc').get();
    const users = [];
    snapshot.forEach(doc => users.push({ id: doc.id, ...doc.data() }));
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Görev ekle
app.post('/api/admin/add-task', async (req, res) => {
  try {
    const { title, type, subtype, icon, reward, doubleReward, slots, timeLeft, category, url, videoUrl } = req.body;
    
    const taskRef = await db.collection('tasks').add({
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
    await db.collection('tasks').doc(req.params.taskId).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Onay bekleyenler
app.get('/api/admin/pending-submissions', async (req, res) => {
  try {
    const snapshot = await db.collection('submissions')
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
  try {
    const { submissionId } = req.body;
    
    const subRef = db.collection('submissions').doc(submissionId);
    const subDoc = await subRef.get();
    const submission = subDoc.data();

    await subRef.update({
      status: 'approved',
      reviewedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const userRef = db.collection('users').doc(submission.userId.toString());
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(submission.reward),
      totalEarned: admin.firestore.FieldValue.increment(submission.reward),
      tasksDone: admin.firestore.FieldValue.increment(1)
    });

    await db.collection('transactions').add({
      userId: submission.userId,
      type: 'earn',
      title: 'Görev Onaylandı',
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
  try {
    const { submissionId } = req.body;
    await db.collection('submissions').doc(submissionId).update({
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
  try {
    const { userId, amount, address } = req.body;
    
    const userRef = db.collection('users').doc(userId.toString());
    const userDoc = await userRef.get();
    const user = userDoc.data();

    if (user.balance < amount) {
      return res.status(400).json({ error: 'Yetersiz bakiye' });
    }

    await userRef.update({
      balance: admin.firestore.FieldValue.increment(-amount)
    });

    await db.collection('transactions').add({
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

// Örnek görevleri oluştur (ilk çalıştırmada)
async function createSampleTasks() {
  const snapshot = await db.collection('tasks').limit(1).get();
  if (snapshot.empty) {
    const sampleTasks = [
      { title: 'TechStartup Retweet', type: 'twitter', subtype: 'RETWEET', icon: 'fab fa-twitter', reward: 0.01, doubleReward: false, slots: 145, totalSlots: 200, timeLeft: '23s', category: 'twitter', url: 'https://x.com/techstartup', isActive: true },
      { title: 'Crypto News Beğen', type: 'twitter', subtype: 'LIKE', icon: 'fab fa-twitter', reward: 0.005, doubleReward: true, slots: 89, totalSlots: 100, timeLeft: '1g', category: 'twitter', url: 'https://x.com/cryptonews', isActive: true },
      { title: 'Tech Kanalına Katıl', type: 'telegram', subtype: 'CHANNEL', icon: 'fab fa-telegram', reward: 0.008, doubleReward: false, slots: 210, totalSlots: 500, timeLeft: '12s', category: 'telegram', url: 'https://t.me/technews', isActive: true },
      { title: 'YouTube Abone Ol', type: 'youtube', subtype: 'SUBSCRIBE', icon: 'fab fa-youtube', reward: 0.015, doubleReward: false, slots: 33, totalSlots: 100, timeLeft: '3g', category: 'youtube', url: 'https://youtube.com/c/tech', isActive: true },
      { title: '2X Ödüllü Video İzle', type: 'video', subtype: 'WATCH', icon: 'fas fa-video', reward: 0.02, doubleReward: true, slots: 50, totalSlots: 50, timeLeft: '5g', category: 'video', videoUrl: 'https://youtube.com/watch?v=example', isActive: true }
    ];
    
    for (const task of sampleTasks) {
      await db.collection('tasks').add({
        ...task,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    console.log('Örnek görevler oluşturuldu');
  }
}

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Sunucuyu başlat
app.listen(PORT, async () => {
  console.log(`NekomiGrow ${PORT} portunda çalışıyor`);
  await createSampleTasks();
});

// ==========================================================
// RENDER 7/24 UYKU ENGELLEYİCİ KOD (YENİ EKLENDİ)
// ==========================================================

// Lütfen buraya kendi Render linkini yapıştır (Sonunda '/' olmasın). 
// Örnek: "https://nekomigrow-backend.onrender.com"
const RENDER_URL = "https://nekomi.onrender.com"; 

setInterval(() => {
    https.get(RENDER_URL, (res) => {
        console.log(`[Uyandırma Pingi] Render uyanık tutuluyor. Durum kodu: ${res.statusCode}`);
    }).on('error', (err) => {
        console.error(`[Uyandırma Hatası] Ping atılamadı: ${err.message}`);
    });
}, 14 * 60 * 1000); // 14 dakikada bir çalıştırır (Render 15. dakikada uykuya geçer, uyumadan hemen önce yakalarız)
