// server.js
// Google Drive Proxy (Render/Node/Express)

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { google } = require('googleapis');
const { Readable } = require('stream');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(express.json());

// ---- CORS -------------------------------------------------
const allowAll = !process.env.CORS_ORIGINS;
const whitelist = allowAll
  ? []
  : process.env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);

app.use(
  cors({
    origin: allowAll
      ? true
      : function (origin, cb) {
          // origin が null（curl など）の場合は許可
          if (!origin) return cb(null, true);
          const ok = whitelist.some(w => {
            if (w.includes('*')) {
              const re = new RegExp('^' + w.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
              return re.test(origin);
            }
            return origin === w;
          });
          cb(null, ok);
        },
    credentials: false,
  })
);

// ---- Multer (memory) -------------------------------------
// 任意で 10MB 制限
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ---- Google Auth / Drive ---------------------------------
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// ---- Helpers ---------------------------------------------
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const sanitize = (s) =>
  String(s || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 200);

async function createFolder(name, parents) {
  const resp = await drive.files.create({
    resource: {
      name: sanitize(name),
      mimeType: FOLDER_MIME,
      ...(parents?.length ? { parents } : {}),
    },
    fields: 'id,name',
  });
  const id = resp.data.id;
  const info = await drive.files.get({ fileId: id, fields: 'id,name,webViewLink' });
  return info.data; // {id,name,webViewLink}
}

async function grantPublic(fileId) {
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });
}

async function listChildFolders(parentId) {
  const { data } = await drive.files.list({
    q: `'${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: 'files(id,name,webViewLink)',
    pageSize: 1000,
  });
  return data.files || [];
}

// ---- JWT utils for Debtor Portal -------------------------
function signPortalToken(payload, expiresIn = '30d') {
  return jwt.sign(payload, process.env.PORTAL_JWT_SECRET, { expiresIn });
}
function verifyPortalToken(token) {
  return jwt.verify(token, process.env.PORTAL_JWT_SECRET);
}
function requireDebtor(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.query.token || '');
    if (!token) return res.status(401).json({ error: 'token が必要です' });
    const p = verifyPortalToken(token);
    if (p.role !== 'debtor') return res.status(403).json({ error: 'role 不正' });
    req.portal = p; // { rootId, debtorName, docTypes, role, exp }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'token 検証に失敗しました' });
  }
}

// ---- Health ----------------------------------------------
app.get('/', (_, res) => {
  res.json({ ok: true, service: 'drive-folder-api', ts: new Date().toISOString() });
});

// ==========================================================
// 1) 案件フォルダ一括作成
// POST /create-case-folders
// Body: { rootName: string, docTypes?: string[], makePublic?: boolean, parentId?: string, createManifest?: boolean }
// 生成: root / (01_提出物|02_承認済|03_差し戻し) / <docType...>
// ==========================================================
app.post('/create-case-folders', async (req, res) => {
  try {
    const { rootName, docTypes = [], makePublic = false, parentId, createManifest = false } = req.body || {};
    if (!rootName || typeof rootName !== 'string') {
      return res.status(400).json({ error: 'rootName は必須です' });
    }

    const parents = [];
    if (parentId) parents.push(parentId);
    else if (process.env.GOOGLE_DRIVE_PARENT_ID) parents.push(process.env.GOOGLE_DRIVE_PARENT_ID);

    // root
    const root = await createFolder(rootName, parents);

    // status folders
    const statusNames = ['01_提出物', '02_承認済', '03_差し戻し'];
    const statusCreated = await Promise.all(statusNames.map((n) => createFolder(n, [root.id])));
    const statusMap = {
      pending: statusCreated[0],
      approved: statusCreated[1],
      rejected: statusCreated[2],
    };

    // docType subfolders under each status
    const byStatus = {};
    for (const s of statusCreated) {
      const children = await Promise.all((docTypes || []).map((dt) => createFolder(dt, [s.id])));
      byStatus[s.name] = children; // array of {id,name,webViewLink}
    }

    // optional: public
    if (makePublic) {
      const allIds = [
        root.id,
        ...statusCreated.map((s) => s.id),
        ...Object.values(byStatus).flat().map((c) => c.id),
      ];
      await Promise.all(allIds.map((id) => grantPublic(id)));
    }

    // optional: manifest.csv (empty with header)
    if (createManifest) {
      const header = 'fileId,fileName,docType,status,reason,uploader,reviewer,createdAt,decidedAt,version\n';
      await drive.files.create({
        resource: { name: 'manifest.csv', parents: [root.id] },
        media: { mimeType: 'text/csv', body: Readable.from(header) },
        fields: 'id,name,webViewLink',
      });
    }

    res.json({
      root,
      statusFolders: statusMap,
      docFolders: byStatus, // { "01_提出物": [...], "02_承認済": [...], "03_差し戻し": [...] }
    });
  } catch (err) {
    console.error('create-case-folders error:', err?.response?.data || err);
    const msg = err?.response?.data?.error?.message || err?.message || 'Google Drive API error';
    res.status(500).json({ error: msg });
  }
});

// ==========================================================
// 2) 構成の再取得（ブラウザ更新後に docType→folderId を復元）
// GET /case-structure?rootId=xxxx
// ==========================================================
app.get('/case-structure', async (req, res) => {
  try {
    const { rootId } = req.query;
    if (!rootId) return res.status(400).json({ error: 'rootId は必須です' });

    const statuses = await listChildFolders(String(rootId));
    const statusMap = Object.fromEntries(statuses.map((f) => [f.name, f]));

    const docFolders = {};
    for (const s of statuses) {
      docFolders[s.name] = await listChildFolders(s.id);
    }

    res.json({ statusFolders: statusMap, docFolders });
  } catch (err) {
    console.error('case-structure error:', err?.response?.data || err);
    const msg = err?.response?.data?.error?.message || err?.message || 'Google Drive API error';
    res.status(500).json({ error: msg });
  }
});

// ==========================================================
// 3) アップロード（汎用／審査者UIからも利用）
// POST /upload-to-folder (multipart: file, folderId, [namePrefix?])
// 保存先は 01_提出物/{docType} を指定して送る
// ==========================================================
app.post('/upload-to-folder', upload.single('file'), async (req, res) => {
  try {
    const { folderId, namePrefix } = req.body || {};
    if (!req.file) return res.status(400).json({ error: 'file が必要です' });
    if (!folderId) return res.status(400).json({ error: 'folderId が必要です' });

    const now = new Date().toISOString().replace(/[:-]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS
    const safeOriginal = sanitize(req.file.originalname);
    const finalName = namePrefix ? `${sanitize(namePrefix)}_${now}_${safeOriginal}` : safeOriginal;

    const fileMetadata = { name: finalName, parents: [folderId] };
    const media = { mimeType: req.file.mimetype, body: Readable.from(req.file.buffer) };

    const response = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id,name,webViewLink,parents',
    });

    res.json({ message: '指定フォルダへのアップロード成功', file: response.data });
  } catch (err) {
    console.error('upload-to-folder error:', err?.response?.data || err);
    const msg = err?.response?.data?.error?.message || err?.message || 'Google Drive API error';
    res.status(500).json({ error: msg });
  }
});

// ==========================================================
// 4) ファイル一覧（フォルダ内）
// GET /files-in-folder?folderId=xxxxx
// ==========================================================
app.get('/files-in-folder', async (req, res) => {
  try {
    const { folderId } = req.query;
    if (!folderId) return res.status(400).json({ error: 'folderId は必須です' });

    const { data } = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType,webViewLink,thumbnailLink,modifiedTime,size)',
      orderBy: 'modifiedTime desc',
      pageSize: 50,
    });

    res.json({ files: data.files || [] });
  } catch (err) {
    console.error('files-in-folder error:', err?.response?.data || err);
    const msg = err?.response?.data?.error?.message || err?.message || 'Google Drive API error';
    res.status(500).json({ error: msg });
  }
});

// ==========================================================
// 5) ファイル移動（承認/差し戻し）
// POST /move-file { fileId, sourceFolderId, destinationFolderId }
// ==========================================================
app.post('/move-file', async (req, res) => {
  try {
    const { fileId, sourceFolderId, destinationFolderId } = req.body || {};
    if (!fileId || !sourceFolderId || !destinationFolderId) {
      return res.status(400).json({ error: 'fileId, sourceFolderId, destinationFolderId は必須です' });
    }
    const response = await drive.files.update({
      fileId,
      addParents: destinationFolderId,
      removeParents: sourceFolderId,
      fields: 'id,name,parents,webViewLink',
    });
    res.json({ message: 'ファイル移動成功', file: response.data });
  } catch (err) {
    console.error('move-file error:', err?.response?.data || err);
    const msg = err?.response?.data?.error?.message || err?.message || 'Google Drive API error';
    res.status(500).json({ error: msg });
  }
});

// ==========================================================
// 6) ファイル移動（親自動解決版）
// POST /move-file-smart { fileId, destinationFolderId }
// ==========================================================
app.post('/move-file-smart', async (req, res) => {
  try {
    const { fileId, destinationFolderId } = req.body || {};
    if (!fileId || !destinationFolderId) {
      return res.status(400).json({ error: 'fileId と destinationFolderId は必須です' });
    }

    // 現在の親フォルダを取得
    const { data: meta } = await drive.files.get({
      fileId,
      fields: 'id, name, parents, webViewLink'
    });
    const currentParents = meta.parents?.join(',') || '';

    const result = await drive.files.update({
      fileId,
      addParents: destinationFolderId,
      removeParents: currentParents, // removeParents はカンマ区切り
      fields: 'id, name, parents, webViewLink'
    });

    res.json({ message: 'ファイル移動成功', file: result.data });
  } catch (err) {
    console.error('move-file-smart error:', err?.response?.data || err);
    const msg = err?.response?.data?.error?.message || err?.message || 'Google Drive API error';
    res.status(500).json({ error: msg });
  }
});

// ==========================================================
// 7) コメント付与（任意：差し戻し理由の記録など）
// POST /comment { fileId, message }
// ==========================================================
app.post('/comment', async (req, res) => {
  try {
    const { fileId, message } = req.body || {};
    if (!fileId || !message) return res.status(400).json({ error: 'fileId と message は必須です' });

    // Drive v3 ではコメントAPIが直接ないため、description 更新で代替
    const { data } = await drive.files.update({
      fileId,
      resource: { description: message },
      fields: 'id,name,webViewLink,description',
    });
    res.json({ message: 'コメント登録（description更新）', file: data });
  } catch (err) {
    console.error('comment error:', err?.response?.data || err);
    const msg = err?.response?.data?.error?.message || err?.message || 'Google Drive API error';
    res.status(500).json({ error: msg });
  }
});

// ==========================================================
// 8) 審査者が使う「債務者URL発行」
// POST /issue-portal-link { rootId, debtorName, docTypes }
// ==========================================================
app.post('/issue-portal-link', async (req, res) => {
  try {
    const { rootId, debtorName, docTypes = [] } = req.body || {};
    if (!rootId || !debtorName) return res.status(400).json({ error: 'rootId, debtorName は必須です' });
    const token = signPortalToken({ rootId, debtorName, docTypes, role: 'debtor' }, '30d');
    const base = (process.env.PORTAL_URL_BASE || '').replace(/\/+$/, '');
    const url = `${base}?token=${encodeURIComponent(token)}`;
    res.json({ url, token, expiresIn: '30d' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'failed to issue portal link' });
  }
});

// ==========================================================
// 9) 債務者ポータル API
// GET /portal/info, GET /portal/structure, POST /portal/upload, GET /portal/files
// ==========================================================
app.get('/portal/info', requireDebtor, (req, res) => {
  const { debtorName, docTypes, rootId, exp } = req.portal;
  res.json({ debtorName, docTypes, rootId, exp });
});

app.get('/portal/structure', requireDebtor, async (req, res) => {
  try {
    const { rootId } = req.portal;
    const statuses = await listChildFolders(rootId);
    const pending = statuses.find(s => s.name === '01_提出物');
    if (!pending) return res.json({ pending: {} });
    const children = await listChildFolders(pending.id);
    const map = Object.fromEntries(children.map(c => [c.name, c.id])); // docType -> folderId
    res.json({ pending: map });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/portal/upload', requireDebtor, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file 必須' });
    const { docType } = req.body || {};
    if (!docType) return res.status(400).json({ error: 'docType 必須' });

    const { rootId } = req.portal;
    const statuses = await listChildFolders(rootId);
    const pending = statuses.find(s => s.name === '01_提出物');
    if (!pending) return res.status(400).json({ error: '提出物フォルダがありません' });
    const children = await listChildFolders(pending.id);
    const folder = children.find(c => c.name === docType);
    if (!folder) return res.status(400).json({ error: `docType フォルダがありません: ${docType}` });

    const stamp = new Date().toISOString().replace(/[:-]/g,'').slice(0,15);
    const safeName = sanitize(req.file.originalname);
    const finalName = `${docType}_${stamp}_${safeName}`;

    const response = await drive.files.create({
      resource: { name: finalName, parents: [folder.id] },
      media: { mimeType: req.file.mimetype, body: Readable.from(req.file.buffer) },
      fields: 'id,name,webViewLink,parents'
    });
    res.json({ message: 'アップロード成功', file: response.data });
  } catch (e) { res.status(500).json({ error: e.message || 'portal upload failed' }); }
});

app.get('/portal/files', requireDebtor, async (req, res) => {
  try {
    const { docType } = req.query;
    const { rootId } = req.portal;
    const statuses = await listChildFolders(rootId);
    const pending = statuses.find(s => s.name === '01_提出物');
    if (!pending) return res.json({ files: [] });
    const children = await listChildFolders(pending.id);
    const folder = children.find(c => c.name === docType);
    if (!folder) return res.json({ files: [] });

    const { data } = await drive.files.list({
      q: `'${folder.id}' in parents and trashed=false`,
      fields: 'files(id,name,webViewLink,modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 50
    });
    res.json({ files: data.files || [] });
  } catch (e) { res.status(500).json({ error: e.message || 'portal files failed' }); }
});

// ---- Server start ----------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ drive-folder-api listening on :${PORT}`);
});
