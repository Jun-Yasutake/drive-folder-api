// server.js
// Google Drive Folder Creator API (Render-ready)

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
require('dotenv').config();

const {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  REFRESH_TOKEN,
  CORS_ORIGINS,
  PORT = 3000,
  GOOGLE_DRIVE_PARENT_ID, // 任意: 指定した親フォルダ直下に作成したい場合
} = process.env;

// --- Basic validation for required envs ---
['CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI', 'REFRESH_TOKEN'].forEach((key) => {
  if (!process.env[key]) {
    console.warn(`⚠️ Missing env: ${key}`);
  }
});

// --- CORS setup (comma-separated origins) ---
const app = express();
const origins = (CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: origins.length ? origins : true, // dev: allow all if not set
    credentials: false,
  })
);
app.use(express.json());

// --- Google OAuth2 client ---
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// --- Health check ---
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'drive-folder-api', ts: new Date().toISOString() });
});

// --- POST /create-folder ---
// Body: { name: string, makePublic?: boolean, parentId?: string }
// Returns: { folder: { id, name, webViewLink } }
app.post('/create-folder', async (req, res) => {
  try {
    const { name, makePublic = false, parentId } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name は必須です（string）' });
    }

    // sanitize folder name (very simple)
    const safeName = name.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 200);
    if (!safeName) {
      return res.status(400).json({ error: 'name が不正です' });
    }

    const parents = [];
    if (parentId && typeof parentId === 'string') parents.push(parentId);
    else if (GOOGLE_DRIVE_PARENT_ID) parents.push(GOOGLE_DRIVE_PARENT_ID);

    // 1) Create folder
    const createResp = await drive.files.create({
      resource: {
        name: safeName,
        mimeType: 'application/vnd.google-apps.folder',
        ...(parents.length ? { parents } : {}),
      },
      fields: 'id, name',
    });
    const folderId = createResp.data.id;

    // 2) (Optional) Make public
    if (makePublic) {
      await drive.permissions.create({
        fileId: folderId,
        requestBody: { role: 'reader', type: 'anyone' },
      });
    }

    // 3) Get latest link (webViewLink)
    const getResp = await drive.files.get({
      fileId: folderId,
      fields: 'id, name, webViewLink',
    });

    return res.json({ folder: getResp.data });
  } catch (err) {
    console.error('create-folder error:', err?.response?.data || err);
    const msg =
      err?.response?.data?.error?.message ||
      err?.message ||
      'Google Drive API error';
    return res.status(500).json({ error: msg });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`✅ drive-folder-api listening on :${PORT}`);
});


// ==============================
// POST /create-case-folders
// Body: { rootName: string, docTypes?: string[], makePublic?: boolean, parentId?: string }
// 生成: root / (01_提出物|02_承認済|03_差し戻し) / <各docType>
// ==============================
app.post('/create-case-folders', async (req, res) => {
  try {
    const { rootName, docTypes = [], makePublic = false, parentId } = req.body || {};
    if (!rootName || typeof rootName !== 'string') {
      return res.status(400).json({ error: 'rootName は必須です' });
    }
    const safe = (s) => s.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 200);

    const parents = [];
    if (parentId && typeof parentId === 'string') parents.push(parentId);
    else if (process.env.GOOGLE_DRIVE_PARENT_ID) parents.push(process.env.GOOGLE_DRIVE_PARENT_ID);

    const createFolder = async (name, parentsArr) => {
      const f = await drive.files.create({
        resource: { name: safe(name), mimeType: 'application/vnd.google-apps.folder', ...(parentsArr?.length ? { parents: parentsArr } : {}) },
        fields: 'id, name',
      });
      const id = f.data.id;
      const info = await drive.files.get({ fileId: id, fields: 'id, name, webViewLink' });
      return info.data;
    };

    const grantPublic = async (fileId) => {
      await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
    };

    // 1) ルート
    const root = await createFolder(rootName, parents);

    // 2) ステータス3フォルダ
    const statusNames = ['01_提出物', '02_承認済', '03_差し戻し'];
    const statusCreated = await Promise.all(statusNames.map((n) => createFolder(n, [root.id])));
    const statusMap = {
      pending: statusCreated[0],
      approved: statusCreated[1],
      rejected: statusCreated[2],
    };

    // 3) 各ステータス配下に docTypes のサブフォルダ
    const byStatus = {};
    for (const s of statusCreated) {
      const children = await Promise.all(
        (docTypes || []).map((dt) => createFolder(dt, [s.id]))
      );
      byStatus[s.name] = children;
    }

    // 4) 任意: 公開設定
    if (makePublic) {
      const allIds = [
        root.id,
        ...statusCreated.map((s) => s.id),
        ...Object.values(byStatus).flat().map((c) => c.id),
      ];
      await Promise.all(allIds.map((id) => grantPublic(id)));
      // 公開後の最新リンクを取り直す必要は薄いが、厳密にやるなら再取得してもOK
    }

    // 5) 任意: 空の manifest.csv を作成（ヘッダのみ）
    // 使う場合はコメント解除
    // const manifestContent = 'fileId,fileName,docType,status,reason,uploader,reviewer,createdAt,decidedAt,version\n';
    // await drive.files.create({
    //   resource: { name: 'manifest.csv', parents: [root.id] },
    //   media: { mimeType: 'text/csv', body: Readable.from(manifestContent) },
    //   fields: 'id, name, webViewLink',
    // });

    return res.json({
      root,
      statusFolders: statusMap,
      docFolders: byStatus, // { "01_提出物": [...], "02_承認済": [...], "03_差し戻し": [...] }
    });
  } catch (err) {
    console.error('create-case-folders error:', err?.response?.data || err);
    const msg = err?.response?.data?.error?.message || err?.message || 'Google Drive API error';
    return res.status(500).json({ error: msg });
  }
});