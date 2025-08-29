// ---- Multer (memory) -------------------------------------
// ★ 任意で 10MB 制限
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// （中略：既存のルート群 /create-case-folders /case-structure /upload-to-folder /move-file /comment）


// ===== 追加ルート：listen の前に移動 =====

// GET /files-in-folder?folderId=xxxxx
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

// POST /move-file-smart { fileId, destinationFolderId }
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

// ---- Server start ----------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ drive-folder-api listening on :${PORT}`);
});
