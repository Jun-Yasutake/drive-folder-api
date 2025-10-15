// server.js
// Google Drive Proxy (Render/Node/Express)

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const { Readable } = require('stream');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(express.json());

// ==========================================================
// CORS （デバッグログ & OPTIONS も対応）
// ==========================================================
const allowAll = !process.env.CORS_ORIGINS;
const whitelist = allowAll
  ? []
  : process.env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    // 直アクセス（curl等）で Origin が無いとき/allowAll のときは許可
    if (!origin || allowAll) return cb(null, true);

    const ok = whitelist.some(w => {
      if (w.includes('*')) {
        const re = new RegExp('^' + w.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
        return re.test(origin);
      }
      return origin === w;
    });

    console.log('[CORS]', origin, '->', ok ? 'ALLOW' : 'BLOCK');
    cb(null, ok);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ==========================================================
// Multer（10MB制限）
// ==========================================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ==========================================================
// Google OAuth / Drive
// ==========================================================
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// ==========================================================
// Helpers
// ==========================================================
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

// ---- Drive link helpers ----
function toViewUrl(id, webViewLink) {
  // webViewLink があれば優先。/file/d/ が無い場合は補正し、/preview を /view に統一
  if (webViewLink) {
    let v = webViewLink.replace(/\/preview(\?.*)?$/, '/view');
    if (!/\/file\/d\//.test(v)) v = v.replace('/file/', '/file/d/');
    return v;
  }
  return `https://drive.google.com/file/d/${id}/view`;
}
function toPreviewUrl(id, webViewLink) {
  return toViewUrl(id, webViewLink).replace(/\/view(\?.*)?$/, '/preview');
}
function buildPublicLinks(fileId, webViewLink) {
  return {
    viewUrl: toViewUrl(fileId, webViewLink),
    previewUrl: toPreviewUrl(fileId, webViewLink),
    downloadUrl: `https://drive.google.com/uc?export=download&id=${fileId}`,
  };
}

async function listChildFolders(parentId) {
  const { data } = await drive.files.list({
    q: `'${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: 'files(id,name,webViewLink)',
    pageSize: 1000,
  });
  return data.files || [];
}

// ==========================================================
// JWT utils for Debtor Portal
// ==========================================================
function signPortalToken(payload, expiresIn = '30d') {
  if (!process.env.PORTAL_JWT_SECRET) {
    throw new Error('PORTAL_JWT_SECRET is required');
  }
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

// ==========================================================
// Health
// ==========================================================
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

    // optional: public（create-case-folders 時はオプションのまま）
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
// 2) 構成の再取得（docType→folderId 復元）
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
// 3) アップロード（汎用）
// POST /upload-to-folder (multipart: file, folderId, [namePrefix?])
// 保存先は 01_提出物/{docType} を指定
// ＊この環境では「アップロード直後に必ず公開（anyone）」にします
// ==========================================================
app.post('/upload-to-folder', upload.single('file'), async (req, res) => {
  try {
    const { folderId, namePrefix } = req.body || {};
    if (!req.file) return res.status(400).json({ error: 'file が必要です' });
    if (!folderId) return res.status(400).json({ error: 'folderId が必要です' });

    const now = new Date().toISOString().replace(/[:-]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS
    const safeOriginal = sanitize(Buffer.from(req.file.originalname, 'latin1').toString('utf8'));
    const finalName = namePrefix ? `${sanitize(namePrefix)}_${now}_${safeOriginal}` : safeOriginal;

    const response = await drive.files.create({
      resource: { name: finalName, parents: [folderId] },
      media: { mimeType: req.file.mimetype, body: Readable.from(req.file.buffer) },
      fields: 'id,name,webViewLink,parents',
    });

    // 公開（リンクを知っている全員）
    const fileId = response.data.id;
    await grantPublic(fileId);
    const links = buildPublicLinks(fileId, response.data.webViewLink);

    res.json({
      message: '指定フォルダへのアップロード成功（公開化済み）',
      file: { ...response.data, isPublic: true, ...links },
    });
  } catch (err) {
    console.error('upload-to-folder error:', err?.response?.data || err);
    const msg = err?.response?.data?.error?.message || err?.message || 'Google Drive API error';
    res.status(500).json({ error: msg });
  }
});

// ==========================================================
// 4) フォルダ内ファイル一覧
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

    const files = (data.files || []).map(f => ({
      ...f,
      viewUrl: toViewUrl(f.id, f.webViewLink),
      previewUrl: toPreviewUrl(f.id, f.webViewLink),
      downloadUrl: `https://drive.google.com/uc?export=download&id=${f.id}`,
    }));

    res.json({ files });
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
// 7) コメント付与（任意：差し戻し理由等）
// POST /comment { fileId, message }
// ==========================================================
app.post('/comment', async (req, res) => {
  try {
    const { fileId, message } = req.body || {};
    if (!fileId || !message) return res.status(400).json({ error: 'fileId と message は必須です' });

    // Drive v3 にはコメントAPIが無いので description 更新で代替
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
// 8) 審査者：債務者URL発行
// POST /issue-portal-link { rootId, debtorName, docTypes }
// ==========================================================
app.post('/issue-portal-link', async (req, res) => {
  try {
    const { rootId, debtorName, docTypes = [] } = req.body || {};
    if (!rootId || !debtorName) return res.status(400).json({ error: 'rootId, debtorName は必須です' });
    const token = signPortalToken({ rootId, debtorName, docTypes, role: 'debtor' }, '30d');
    const base = (process.env.PORTAL_URL_BASE || '').replace(/\/+$/, '');
    if (!base) return res.status(500).json({ error: 'PORTAL_URL_BASE が未設定です' });
    const url = `${base}?token=${encodeURIComponent(token)}`;
    res.json({ url, token, expiresIn: '30d' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'failed to issue portal link' });
  }
});

// ==========================================================
// 9) 債務者ポータル API
// GET /portal/info, GET /portal/structure, POST /portal/upload, GET /portal/files
// （この環境ではアップロード直後に公開化）
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
    const safeName = sanitize(Buffer.from(req.file.originalname, 'latin1').toString('utf8'));
    const finalName = `${docType}_${stamp}_${safeName}`;

    const response = await drive.files.create({
      resource: { name: finalName, parents: [folder.id] },
      media: { mimeType: req.file.mimetype, body: Readable.from(req.file.buffer) },
      fields: 'id,name,webViewLink,parents'
    });

    // 公開（リンクを知っている全員）
    const fileId = response.data.id;
    await grantPublic(fileId);
    const links = buildPublicLinks(fileId, response.data.webViewLink);

    res.json({
      message: 'アップロード成功（公開化済み）',
      file: { ...response.data, isPublic: true, ...links }
    });
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

    const files = (data.files || []).map(f => ({
      ...f,
      viewUrl: toViewUrl(f.id, f.webViewLink),
      previewUrl: toPreviewUrl(f.id, f.webViewLink),
      downloadUrl: `https://drive.google.com/uc?export=download&id=${f.id}`,
    }));

    res.json({ files });
  } catch (e) { res.status(500).json({ error: e.message || 'portal files failed' }); }
});

// ==========================================================
// 審査者 or 債務者（preview/list 権限）の簡易認可
// ==========================================================
function reviewerOrDebtor(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'missing token' });
  try {
    const p = jwt.verify(m[1], process.env.JWT_SECRET);
    // 審査者は許可
    if (p.role === 'reviewer') { req.reviewer = p; return next(); }
    // 債務者は scope と rootId を要求
    if (p.role === 'debtor') {
      const sc = Array.isArray(p.scope) ? p.scope : [];
      if (!sc.includes('preview') && !sc.includes('list')) {
        return res.status(403).json({ error: 'forbidden: scope' });
      }
      req.portal = p; // { rootId など }
      return next();
    }
    return res.status(403).json({ error: 'forbidden' });
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

// 指定 fileId が JWT の rootId 配下か（最大10階層）ゆるく確認
async function belongsToRoot(driveClient, fileId, allowedRootId) {
  if (!allowedRootId) return true; // 審査者はスキップ可
  let cur = fileId;
  for (let i = 0; i < 10; i++) {
    const meta = await driveClient.files.get({ fileId: cur, fields: 'id,parents' });
    const parents = meta.data.parents || [];
    if (parents.includes(allowedRootId)) return true;
    if (!parents.length) break;
    cur = parents[0];
  }
  return false;
}

// --- プレビュー本体 ---
app.get('/files/preview/:fileId', reviewerOrDebtor, async (req, res) => {
  try {
    const { fileId } = req.params;
    const allowedRootId = req.portal?.rootId || req.portal?.debtorFolderId;

    if (allowedRootId) {
      const ok = await belongsToRoot(drive, fileId, allowedRootId);
      if (!ok) return res.status(403).json({ error: 'forbidden: outside of case root' });
    }

    // メタ情報
    const meta = await drive.files.get({
      fileId,
      fields: 'mimeType,name,size,md5Checksum'
    });
    const mime = meta.data.mimeType || 'application/octet-stream';
    const name = meta.data.name || 'file';
       const size = Number(meta.data.size || 0);
    const max  = Number(process.env.PREVIEW_MAX_BYTES || 0);
    if (max > 0 && size > max) {
      return res.status(413).json({ error: 'file too large for preview' });
    }

    // Drive からストリーム
    const gRes = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Cache-Control', 'private, max-age=600');
    if (meta.data.md5Checksum) res.setHeader('ETag', meta.data.md5Checksum);

    gRes.data.on('error', () => res.destroy());
    gRes.data.pipe(res);
  } catch (e) {
    const code = e?.code || e?.response?.status || 500;
    res.status(code === 404 ? 404 : 502).json({ error: 'preview failed' });
  }
});

// ==========================================================
// Server start
// ==========================================================
const PORT = process.env.PORT || 3000;

app.get('/healthz', (req, res) => {
  res.type('text/plain').send('ok');
});

app.listen(PORT, () => {
  console.log(`✅ drive-folder-api listening on :${PORT}`);
});

// 例: src/index.js

const cors = require('cors');
const { customAlphabet } = require('nanoid');
const { prisma } = require('./lib/prisma');

const app = express();

// JSONボディ
app.use(express.json());

// CORS（環境変数 CORS_ORIGINS にカンマ区切りで列挙）
const allowList = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowList.length ? allowList : '*',
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// 共有URLのベース（HashRouterなら /#/portal を含める）
const PORTAL_URL_BASE =
  process.env.PORTAL_URL_BASE || 'http://localhost:5173/#/portal';

// ランダム公開ID（十分長い21桁）
const nanoid = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  21
);

/**
 * POST /api/cases
 * 案件を作成し、公開ID/URLを返す
 * body: { debtorName?: string }
 */
app.post('/api/cases', async (req, res) => {
  try {
    const debtorName = req.body && typeof req.body.debtorName === 'string'
      ? req.body.debtorName
      : null;

    const result = await prisma.$transaction(async (tx) => {
      const c = await tx.case.create({ data: { debtorName } });
      const publicId = nanoid();
      await tx.casePublicLink.create({
        data: { caseId: c.id, publicId }
      });
      return { caseId: c.id, publicId };
    });

    const publicUrl = `${PORTAL_URL_BASE}/cases/${result.publicId}`;
    res.json({ caseId: String(result.caseId), publicUrl });
  } catch (err) {
    console.error('POST /api/cases error:', err);
    res.status(500).json({ message: 'failed to create case' });
  }
});

/**
 * GET /api/public/cases/:publicId
 * 公開IDから案件の公開用データを返す
 */
app.get('/api/public/cases/:publicId', async (req, res) => {
  try {
    const { publicId } = req.params;

    const link = await prisma.casePublicLink.findUnique({
      where: { publicId },
      include: { case: { include: { documents: true } } }
    });

    if (!link || !link.isActive) {
      return res.status(404).json({ message: 'not found' });
    }

    const c = link.case;
    res.json({
      case: {
        debtorName: c.debtorName,
        status: c.status,
        createdAt: c.createdAt
      },
      documents: c.documents.map(d => ({
        id: String(d.id),
        docType: d.docType,
        status: d.status,
        submittedAt: d.submittedAt
      }))
    });
  } catch (err) {
    console.error('GET /api/public/cases/:publicId error:', err);
    res.status(500).json({ message: 'failed to fetch public case' });
  }
});

// 既存の app.listen(...) はそのまま利用
// もし無ければ↓を有効化
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   console.log(`server running on :${PORT}`);
// });

module.exports = app; // RenderのAuto–Server-Startで不要なら省略可
