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
