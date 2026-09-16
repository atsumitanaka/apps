// ==UserScript==
// @name         Starrydata2 Open Access Filter
// @namespace    user.starrydata.oa
// @version      2.11.0
// @description  論文に OA バッジとライセンスを表示。全件スキャン、CC BY/CC0 フィルタ、CSV エクスポート、Editor (キュレーター) オンデマンド検索、論文リスト IndexedDB キャッシュ (30k 件規模対応)。
// @author       you
// @match        https://starrydata.nims.go.jp/starrydata2/paperlist/project/*
// @grant        GM_xmlhttpRequest
// @connect      api.unpaywall.org
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ====== 設定 ======
  const UNPAYWALL_EMAIL = 'starrydata1@gmail.com';
  const CACHE_KEY = 'starrydata_oa_cache_v1';
  const FILTER_KEY = 'starrydata_oa_filter';
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;     // 30 日
  const MAX_CONCURRENT_UNPAYWALL = 3;
  const PAGE_LIMIT_FOR_PREFETCH = 500;               // 1ページあたりの件数
  const DELAY_BETWEEN_PAGES_MS = 300;                // 次リクエスト前の待機
  const MAX_CONCURRENT_PAGES = 1;                    // 深いページネーションが遅いので順次取得（信頼性優先）
  const PAGE_FETCH_TIMEOUT_MS = 30000;               // ページ取得タイムアウト（深いページは数秒かかる）
  const MAX_PAGE_RETRIES = 5;                        // ページ失敗時のリトライ回数
  const CUSTOM_PAGE_SIZE = 25;

  // ====== Editor (キュレーター) 設定 ======
  const EDITOR_CACHE_KEY = 'starrydata_editor_cache_v1';
  const EDITOR_FILTER_KEY = 'starrydata_editor_filter';
  const EDITOR_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 年（キュレーターはほぼ変わらない）
  const MAX_CONCURRENT_EDITOR = 5;                       // 「検索」体験のため適度に並列化（~10 req/s）
  const DELAY_BETWEEN_EDITOR_MS = 500;                   // 各論文の data_api 取得間隔

  // ====== プロジェクト名 ======
  const projectMatch = location.pathname.match(/\/paperlist\/project\/([^\/?#]+)/);
  if (!projectMatch) return;
  const projectname = decodeURIComponent(projectMatch[1]);
  const SCRIPT_NAME =
    (typeof window.SCRIPT_NAME === 'string' && window.SCRIPT_NAME) ||
    (location.pathname.includes('/starrydata2/') ? '/starrydata2' : '');

  // ====== 論文リストキャッシュ設定 ======
  const PAPER_CACHE_PREFIX = `starrydata_papers_v1_${projectname}`;
  const PAPER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // 7 日（プロジェクトに新規論文が追加される可能性）
  const PAPER_CHUNK_SIZE = 5000;                         // localStorage の 1 キーあたりサイズ抑制

  // ====== キャッシュ ======
  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
    catch (_) { return {}; }
  }
  function saveCacheNow(c) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (_) {}
  }
  // 連続呼び出しを 1 秒間隔にまとめる（大量スキャン時の同期ブロック対策）
  let saveCacheTimer = null;
  function saveCache(c) {
    if (saveCacheTimer) return;
    saveCacheTimer = setTimeout(() => {
      saveCacheTimer = null;
      saveCacheNow(c);
    }, 1000);
  }
  const cache = loadCache();

  // ====== Editor キャッシュ ======
  function loadEditorCache() {
    try { return JSON.parse(localStorage.getItem(EDITOR_CACHE_KEY) || '{}'); }
    catch (_) { return {}; }
  }
  function saveEditorCacheNow(c) {
    try { localStorage.setItem(EDITOR_CACHE_KEY, JSON.stringify(c)); } catch (_) {}
  }
  let saveEditorCacheTimer = null;
  function saveEditorCache(c) {
    if (saveEditorCacheTimer) return;
    saveEditorCacheTimer = setTimeout(() => {
      saveEditorCacheTimer = null;
      saveEditorCacheNow(c);
    }, 1000);
  }
  const editorCache = loadEditorCache();

  // ====== 論文リストキャッシュ (IndexedDB) ======
  // 30k 件規模(~12MB)は localStorage の上限を超えるため IndexedDB を利用
  const IDB_NAME = 'starrydata_oa_filter_v1';
  const IDB_STORE = 'paperlist';

  function trimPaperForCache(p) {
    const f = p.fields || {};
    return {
      pk: p.pk,
      fields: {
        sid: f.sid,
        DOI: f.DOI,
        title: f.title,
        author: f.author,
        container_title: f.container_title,
        volume: f.volume,
        issue: f.issue,
        page: f.page,
        article_number: f.article_number,
        fignum: f.fignum,
        samnum: f.samnum,
        issued: f.issued,
        published_print: f.published_print,
        published_online: f.published_online,
      },
    };
  }

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'projectname' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 旧 localStorage 版のゴミ掃除（あれば）
  function clearLegacyLocalStorageCache() {
    try {
      localStorage.removeItem(`${PAPER_CACHE_PREFIX}_meta`);
      for (let i = 0; i < 200; i++) {
        const key = `${PAPER_CACHE_PREFIX}_chunk_${i}`;
        if (localStorage.getItem(key) !== null) localStorage.removeItem(key);
      }
    } catch (_) {}
  }

  async function savePaperListCache(papers, totalPapers) {
    clearLegacyLocalStorageCache();
    try {
      const trimmed = papers.map(trimPaperForCache);
      const db = await idbOpen();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({
          projectname,
          t: Date.now(),
          totalPapers,
          count: trimmed.length,
          papers: trimmed,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('aborted'));
      });
      db.close();
      console.log(`[OA filter] IndexedDB に ${trimmed.length} 件保存しました`);
      return true;
    } catch (e) {
      console.warn('[OA filter] IndexedDB 保存に失敗:', e);
      return false;
    }
  }

  async function loadPaperListCache() {
    try {
      const db = await idbOpen();
      const rec = await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(projectname);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      if (!rec) return null;
      if (Date.now() - rec.t > PAPER_CACHE_TTL_MS) {
        await clearPaperListCache();
        return null;
      }
      return { papers: rec.papers, totalPapers: rec.totalPapers, t: rec.t };
    } catch (e) {
      console.warn('[OA filter] IndexedDB 読み込みに失敗:', e);
      return null;
    }
  }

  async function clearPaperListCache() {
    clearLegacyLocalStorageCache();
    try {
      const db = await idbOpen();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(projectname);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (_) {}
  }

  // ====== 同時実行制限 ======
  function makeLimiter(max) {
    let active = 0;
    const queue = [];
    function next() {
      if (active >= max) return;
      const job = queue.shift();
      if (!job) return;
      active++;
      job().finally(() => { active--; next(); });
    }
    return fn => new Promise(res => {
      queue.push(() => fn().then(res, () => res(null)));
      next();
    });
  }
  const limitUnpaywall = makeLimiter(MAX_CONCURRENT_UNPAYWALL);
  const limitEditor = makeLimiter(MAX_CONCURRENT_EDITOR);

  // ====== Editor 取得 (Starrydata data_api) ======
  function fetchEditors(pk) {
    if (!pk) return Promise.resolve(null);
    const c = editorCache[pk];
    if (c && Date.now() - c.t < EDITOR_CACHE_TTL_MS) return Promise.resolve(c.users);
    return limitEditor(async () => {
      const url = `${SCRIPT_NAME}/paperlist/data_api/${encodeURIComponent(pk)}/${encodeURIComponent(projectname)}`;
      try {
        const r = await fetch(url, { credentials: 'same-origin' });
        if (!r.ok) return null;
        const j = await r.json();
        const users = (Array.isArray(j.users) ? j.users : []).map(u => ({
          user_id: u.user_id,
          username: u.username,
        }));
        editorCache[pk] = { t: Date.now(), users };
        saveEditorCache(editorCache);
        return users;
      } catch (_) {
        return null;
      }
    });
  }

  // ====== Unpaywall ======
  function fetchOA(doi) {
    if (!doi || !/^10\./.test(String(doi).trim())) {
      return Promise.resolve({ is_oa: null, reason: 'no-doi' });
    }
    const key = String(doi).toLowerCase().trim();
    const c = cache[key];
    if (c && Date.now() - c.t < CACHE_TTL_MS) return Promise.resolve(c.v);
    return limitUnpaywall(() => new Promise(resolve => {
      const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`;
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 15000,
        onload: r => {
          let val = { is_oa: null, reason: 'parse-error' };
          try {
            if (r.status === 200) {
              const j = JSON.parse(r.responseText);
              const loc = j.best_oa_location || null;
              // 全 oa_locations から最も寛容なライセンスを採用
              const allLocs = Array.isArray(j.oa_locations) ? j.oa_locations : (loc ? [loc] : []);
              const license = pickBestLicense(allLocs.map(l => l && l.license).filter(Boolean));
              val = {
                is_oa: !!j.is_oa,
                oa_status: j.oa_status || null,
                license: license || null,
                pdf_url: loc ? (loc.url_for_pdf || loc.url || null) : null,
                host_type: loc ? loc.host_type || null : null,
              };
            } else if (r.status === 404) {
              val = { is_oa: null, reason: 'not-found' };
            } else {
              val = { is_oa: null, reason: `http-${r.status}` };
            }
          } catch (_) {}
          cache[key] = { t: Date.now(), v: val };
          saveCache(cache);
          resolve(val);
        },
        onerror: () => resolve({ is_oa: null, reason: 'network-error' }),
        ontimeout: () => resolve({ is_oa: null, reason: 'timeout' }),
      });
    }));
  }

  function paperStatus(p) {
    if (!p || !p.oa) return 'unknown';
    if (p.oa.is_oa === true) return 'oa';
    if (p.oa.is_oa === false) return 'closed';
    return 'unknown';
  }

  // ライセンスの再利用可否：cc-by / cc0 / public domain のみ
  // LLM への投入とデータ抽出を法的に問題なく行うため、SA/NC/ND は除外
  function isReusable(license) {
    if (!license) return false;
    const l = String(license).toLowerCase().trim();
    return l === 'cc-by' || l === 'ccby'
        || l === 'cc0' || l === 'cc-0'
        || l === 'pd' || l === 'public-domain';
  }
  function paperIsReusable(p) {
    return !!(p && p.oa && p.oa.is_oa === true && isReusable(p.oa.license));
  }

  // 寛容度順にライセンスから best を選ぶ（再利用可なものを優先）
  function pickBestLicense(licenses) {
    if (!licenses || licenses.length === 0) return null;
    const order = ['cc-by', 'cc-by-sa', 'cc0', 'pd', 'public-domain', 'cc-by-nc', 'cc-by-nc-sa', 'cc-by-nc-nd', 'cc-by-nd'];
    const norm = licenses.map(l => String(l).toLowerCase());
    for (const want of order) {
      if (norm.includes(want)) return want;
    }
    return norm[0];
  }

  function passesFilter(p) {
    const st = paperStatus(p);
    let oaOk = true;
    switch (state.filter) {
      case 'all': oaOk = true; break;
      case 'oa': oaOk = st === 'oa'; break;
      case 'closed': oaOk = st === 'closed'; break;
      case 'unknown': oaOk = st === 'unknown'; break;
      case 'reusable': oaOk = paperIsReusable(p); break;
      case 'non-reusable': oaOk = !paperIsReusable(p); break;
      default: oaOk = true;
    }
    if (!oaOk) return false;
    if (state.selectedEditor) {
      if (!Array.isArray(p.editors)) return false;
      const q = state.selectedEditor.toLowerCase();
      if (!p.editors.some(u => u && typeof u.username === 'string' && u.username.toLowerCase().includes(q))) return false;
    }
    return true;
  }

  function paperEditorNames(p) {
    if (!p || !Array.isArray(p.editors)) return [];
    return p.editors.map(u => u && u.username).filter(Boolean);
  }

  function buildEditorIndex() {
    const counts = new Map();
    for (const p of state.allPapers) {
      for (const name of paperEditorNames(p)) {
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
    return counts;
  }

  // ====== 状態 ======
  const state = {
    mode: 'page',                 // 'page' = 表示中のみ / 'project' = プロジェクト全体
    filter: localStorage.getItem(FILTER_KEY) || 'all',
    allPapers: [],
    papersBySid: new Map(),       // SID -> paper, findPaperByLi の O(1) 化用
    totalPapers: 0,
    oaChecked: 0,
    scanning: false,
    cancel: false,
    customPage: 1,
    // Editor (キュレーター)
    selectedEditor: localStorage.getItem(EDITOR_FILTER_KEY) || '',
    scanningEditors: false,
    editorCancel: false,
    editorScanned: 0,
    editorTotalToFetch: 0,
    editorScanMode: null,        // 'all' | 'search' | null
    editorSearchTerm: '',
    editorSearchMatched: 0,
    // 論文リストキャッシュ
    _cacheRestoredAt: null,
  };

  // ====== スタイル ======
  const style = document.createElement('style');
  style.textContent = `
    .oa-filter-control { display: inline-flex; align-items: center; margin-left: 8px; gap: 6px; flex-wrap: wrap; }
    .oa-filter-control select, .oa-filter-control button {
      padding: 2px 6px; border: 1px solid #ccc; border-radius: 3px; font-size: 0.9em; background: #fff; cursor: pointer;
    }
    .oa-filter-control button:disabled { opacity: 0.5; cursor: not-allowed; }
    .oa-filter-control label { font-size: 0.9em; }
    .oa-info { font-size: 0.85em; color: #555; }
    .oa-badge { font-weight: bold; margin-bottom: 2px; }
    .oa-badge a { margin-left: 6px; font-weight: normal; }
    li[data-oa-status="oa"]      .oa-badge { color: #0a8a3a; }
    li[data-oa-status="closed"]  .oa-badge { color: #b00020; }
    li[data-oa-status="unknown"] .oa-badge { color: #888; }
    .oa-custom-list { list-style: none; padding-left: 0; }
    .oa-custom-pagination { margin: 8px 0; }
    .oa-custom-pagination button { margin: 0 4px; padding: 4px 8px; border: 1px solid #ccc; background: #fff; cursor: pointer; border-radius: 4px; }
    .oa-custom-pagination button:disabled { opacity: 0.5; cursor: not-allowed; }
    .oa-editor-badge { font-size: 0.85em; color: #4a4a4a; margin-bottom: 2px; }
    .oa-editor-badge .oa-editor-name { font-weight: normal; }
    .oa-filter-control .oa-editor-divider { width: 1px; height: 18px; background: #ccc; margin: 0 4px; }
  `;
  document.head.appendChild(style);

  // ====== UI ======
  let uiWrap = null;
  function injectFilterUI() {
    const menu = document.querySelector('.paper .sub-menu');
    if (!menu || menu.querySelector('.oa-filter-control')) return false;
    uiWrap = document.createElement('div');
    uiWrap.className = 'oa-filter-control';
    uiWrap.innerHTML = `
      <label>OA:</label>
      <select class="oa-filter-select">
        <option value="all">All</option>
        <option value="oa">🟢 OA only</option>
        <option value="closed">🔒 Closed only</option>
        <option value="unknown">❓ Unknown only</option>
        <option value="reusable">✨ 再利用可 (CC BY / CC0)</option>
        <option value="non-reusable">🚫 再利用不可 (SA・NC・ND・不明・Closed)</option>
      </select>
      <button class="oa-scan-btn" type="button" title="プロジェクト全件をスキャンしてフィルタを有効化（時間がかかります）">🔍 全件スキャン</button>
      <button class="oa-cancel-btn" type="button" style="display:none;">✕ 中止</button>
      <button class="oa-csv-btn" type="button" title="現在のフィルタに一致する論文を CSV ダウンロード">📥 CSV</button>
      <span class="oa-editor-divider"></span>
      <label>👤 Editor:</label>
      <input type="text" class="oa-editor-input" placeholder="名前で検索（部分一致）" title="キュレーター名で絞り込み。部分一致・大文字小文字無視。空欄ですべて表示。" style="width: 14em;">
      <button class="oa-editor-clear-btn" type="button" title="検索をクリア">✕</button>
      <button class="oa-editor-search-btn" type="button" title="入力された名前を含む論文を検索（必要な分だけ Starrydata API を呼び、マッチをリアルタイムで表示）">🔍 検索</button>
      <button class="oa-editor-scan-btn" type="button" title="プロジェクト全論文の Editor (キュレーター) 情報を一気に取得します（時間がかかります）">👤 全件取得</button>
      <button class="oa-editor-cancel-btn" type="button" style="display:none;">✕ 中止</button>
      <span class="oa-info"></span>
    `;
    menu.appendChild(uiWrap);

    const sel = uiWrap.querySelector('.oa-filter-select');
    sel.value = state.filter;
    sel.addEventListener('change', () => {
      state.filter = sel.value;
      state.customPage = 1;
      localStorage.setItem(FILTER_KEY, state.filter);
      render();
    });

    uiWrap.querySelector('.oa-scan-btn').addEventListener('click', () => {
      if (state.scanning) return;
      if (state.mode === 'project' && state.allPapers.length > 0) {
        if (!confirm('既にスキャン済みです。再スキャンしますか？\n（保存済みの論文リストキャッシュも更新されます）')) return;
        state.allPapers = [];
        state.papersBySid.clear();
        state.oaChecked = 0;
        state.totalPapers = 0;
        state._cacheRestoredAt = null;
        clearPaperListCache();
      }
      startProjectScan();
    });
    uiWrap.querySelector('.oa-cancel-btn').addEventListener('click', () => {
      state.cancel = true;
      updateInfo();
    });

    uiWrap.querySelector('.oa-csv-btn').addEventListener('click', exportCSV);

    const editorInput = uiWrap.querySelector('.oa-editor-input');
    editorInput.value = state.selectedEditor || '';
    let editorInputTimer = null;
    const applyEditorInput = () => {
      const v = editorInput.value.trim();
      if (v === state.selectedEditor) return;
      state.selectedEditor = v;
      state.customPage = 1;
      localStorage.setItem(EDITOR_FILTER_KEY, state.selectedEditor);
      render();
    };
    editorInput.addEventListener('input', () => {
      if (editorInputTimer) clearTimeout(editorInputTimer);
      editorInputTimer = setTimeout(applyEditorInput, 300);
    });
    editorInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (editorInputTimer) { clearTimeout(editorInputTimer); editorInputTimer = null; }
        applyEditorInput();
      }
    });
    uiWrap.querySelector('.oa-editor-clear-btn').addEventListener('click', () => {
      editorInput.value = '';
      applyEditorInput();
    });

    uiWrap.querySelector('.oa-editor-search-btn').addEventListener('click', () => {
      if (state.scanningEditors) return;
      if (state.mode !== 'project' || state.allPapers.length === 0) {
        alert('先に「🔍 全件スキャン」で論文一覧を取得してください。');
        return;
      }
      const term = editorInput.value.trim();
      if (!term) {
        alert('検索したい Editor 名を入力してください。');
        return;
      }
      // 入力内容を即座にフィルタへ反映
      if (editorInputTimer) { clearTimeout(editorInputTimer); editorInputTimer = null; }
      applyEditorInput();
      startEditorScan({ mode: 'search', term });
    });

    uiWrap.querySelector('.oa-editor-scan-btn').addEventListener('click', () => {
      if (state.scanningEditors) return;
      if (state.mode !== 'project' || state.allPapers.length === 0) {
        alert('先に「🔍 全件スキャン」で論文一覧を取得してください。');
        return;
      }
      const missing = state.allPapers.filter(p => !Array.isArray(p.editors)).length;
      if (missing === 0) {
        if (!confirm('既に Editor 情報を取得済みです。再取得しますか？')) return;
        for (const p of state.allPapers) {
          p.editors = undefined;
          if (p.pk) delete editorCache[p.pk];
        }
        saveEditorCacheNow(editorCache);
      } else {
        const seconds = Math.ceil(missing * DELAY_BETWEEN_EDITOR_MS / MAX_CONCURRENT_EDITOR / 1000);
        const minutes = Math.ceil(seconds / 60);
        if (!confirm(`Editor 情報を ${missing} 件取得します (約 ${minutes} 分)。\nStarrydata サーバーへの問い合わせなので、ゆっくり順次取得します。\n途中で「✕ 中止」を押せば停止できます。続行しますか？`)) return;
      }
      startEditorScan();
    });
    uiWrap.querySelector('.oa-editor-cancel-btn').addEventListener('click', () => {
      state.editorCancel = true;
      updateInfo();
    });

    return true;
  }

  // ====== CSV エクスポート ======
  function exportCSV() {
    let papers = [];
    let scope = '';
    if (state.mode === 'project' && state.allPapers.length > 0) {
      papers = state.allPapers.filter(passesFilter);
      scope = 'project';
    } else {
      // page モード: 表示中の <li> から SID を拾ってオブジェクト化
      const items = Array.from(document.querySelectorAll('.paper .field:not(.oa-custom-list) li'))
        .filter(li => li.style.display !== 'none');
      papers = items.map(li => extractPaperFromLi(li)).filter(Boolean);
      scope = 'page';
    }

    if (papers.length === 0) {
      alert('エクスポート対象の論文がありません。');
      return;
    }

    const cols = [
      'SID', 'DOI', 'Title', 'Authors', 'Journal', 'Volume', 'Page', 'Year',
      'OA_status', 'OA_color', 'License', 'Reusable', 'PDF_URL', 'Original_URL',
      'Editors'
    ];
    const rows = papers.map(p => {
      const f = p.fields || {};
      const oa = p.oa || {};
      const status = paperStatus(p);
      const reusable = paperIsReusable(p) ? 'yes' : 'no';
      const authors = Array.isArray(f.author)
        ? f.author.map(a => {
            const fam = a.family || '';
            const giv = a.given || '';
            return [fam, giv].filter(Boolean).join(', ');
          }).join('; ')
        : '';
      const doiUrl = f.DOI && f.DOI !== 'unknown' ? `https://doi.org/${f.DOI}` : '';
      const editors = paperEditorNames(p).join('; ');
      return [
        f.sid ?? '',
        f.DOI ?? '',
        f.title ?? '',
        authors,
        f.container_title ?? '',
        f.volume ?? '',
        f.page && f.page !== 'unknown' ? f.page : (f.article_number ?? ''),
        getYear(f),
        status,
        oa.oa_status ?? '',
        oa.license ?? '',
        reusable,
        oa.pdf_url ?? '',
        doiUrl,
        editors,
      ];
    });

    const csv = [cols, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
    const bom = '﻿';
    const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8' });
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const filename = `starrydata_${projectname}_${state.filter}_${scope}_${ts}.csv`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  // page モード: <li> から疑似 paper オブジェクトを組み立てる
  function extractPaperFromLi(li) {
    const sidDivs = Array.from(li.querySelectorAll('.tagarea .sid'));
    const getField = (label) => {
      const re = new RegExp(`^${label}\\s*:\\s*(.*)$`, 'i');
      for (const d of sidDivs) {
        if (d.classList.contains('oa-badge')) continue;
        const m = d.textContent.trim().match(re);
        if (m) return m[1].trim();
      }
      return '';
    };
    const sid = getField('SID');
    if (!sid) return null;
    // project モードの allPapers にあれば優先
    const cached = state.papersBySid.get(sid);
    if (cached) return cached;

    const title = (li.querySelector('.content .title') || {}).textContent || '';
    const authorEl = li.querySelector('.content .author');
    const authorsText = authorEl ? authorEl.textContent.trim() : '';
    const journalEl = li.querySelector('.content .journal');
    const journalText = journalEl ? journalEl.textContent.trim() : '';

    const status = li.dataset.oaStatus || 'unknown';
    const reusable = li.dataset.reusable === '1';
    const badgeText = (li.querySelector('.oa-badge') || {}).textContent || '';
    const licenseMatch = badgeText.match(/\[([^\]]+)\]/);
    const license = licenseMatch ? licenseMatch[1] : null;
    const pdfA = li.querySelector('.oa-badge a');
    const pdfUrl = pdfA ? pdfA.href : null;

    return {
      pk: '',
      fields: {
        sid,
        DOI: getField('DOI'),
        fignum: getField('Figure'),
        samnum: getField('Sample'),
        year: getField('Year'),
        title: title.trim(),
        container_title: journalText,
        author: authorsText ? [{ family: authorsText, given: '' }] : [],
        volume: '',
        page: '',
        article_number: '',
      },
      oa: {
        is_oa: status === 'oa' ? true : (status === 'closed' ? false : null),
        oa_status: null,
        license,
        pdf_url: pdfUrl,
      },
      editors: [],
      _reusable_hint: reusable,
    };
  }

  function computeBreakdown() {
    let oa = 0, closed = 0, unk = 0, reusable = 0, nonReusable = 0;
    for (const p of state.allPapers) {
      if (!p.oa) { unk++; continue; }   // 未判定は unknown と同じ箱に
      const st = paperStatus(p);
      if (st === 'oa') oa++;
      else if (st === 'closed') closed++;
      else unk++;
      if (paperIsReusable(p)) reusable++;
      else nonReusable++;
    }
    return { oa, closed, unk, reusable, nonReusable };
  }

  function updateInfo() {
    if (!uiWrap) return;
    const info = uiWrap.querySelector('.oa-info');
    const scanBtn = uiWrap.querySelector('.oa-scan-btn');
    const cancelBtn = uiWrap.querySelector('.oa-cancel-btn');
    const editorScanBtn = uiWrap.querySelector('.oa-editor-scan-btn');
    const editorCancelBtn = uiWrap.querySelector('.oa-editor-cancel-btn');

    if (state.scanning) {
      scanBtn.disabled = true;
      cancelBtn.style.display = '';
      const b = computeBreakdown();
      info.innerHTML =
        `取得中 ${state.allPapers.length}/${state.totalPapers || '?'} 件 ` +
        `| OA判定 ${state.oaChecked}/${state.allPapers.length} ` +
        `| 🟢 ${b.oa} / 🔒 ${b.closed} / ❓ ${b.unk} ` +
        `| ✨ 再利用可 ${b.reusable} / 🚫 不可 ${b.nonReusable}`;
      return;
    }

    scanBtn.disabled = false;
    cancelBtn.style.display = 'none';

    const editorSearchBtn = uiWrap.querySelector('.oa-editor-search-btn');
    if (state.scanningEditors) {
      editorScanBtn.disabled = true;
      if (editorSearchBtn) editorSearchBtn.disabled = true;
      editorCancelBtn.style.display = '';
    } else {
      editorScanBtn.disabled = false;
      if (editorSearchBtn) editorSearchBtn.disabled = false;
      editorCancelBtn.style.display = 'none';
    }

    if (state.mode === 'project') {
      const b = computeBreakdown();
      const editorIdx = buildEditorIndex();
      const withEditors = state.allPapers.filter(p => Array.isArray(p.editors)).length;
      let editorInfo = '';
      if (state.scanningEditors && state.editorScanMode === 'search') {
        editorInfo = ` | 🔍 検索中「${escapeText(state.editorSearchTerm)}」: マッチ ${state.editorSearchMatched}件 / スキャン ${state.editorScanned}/${state.editorTotalToFetch}`;
      } else if (state.scanningEditors) {
        editorInfo = ` | 👤 取得中 ${state.editorScanned}/${state.editorTotalToFetch} (uniq ${editorIdx.size})`;
      } else if (withEditors > 0) {
        editorInfo = ` | 👤 ${withEditors}/${state.allPapers.length} 件 (uniq ${editorIdx.size})`;
      } else {
        editorInfo = ' | 👤 未取得';
      }
      let cacheInfo = '';
      if (state._cacheRestoredAt) {
        const d = new Date(state._cacheRestoredAt);
        const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        cacheInfo = ` <span style="color:#888;">[📦 ${ymd} のキャッシュ]</span>`;
      }
      info.innerHTML =
        `プロジェクト全体 ${state.allPapers.length} 件: ` +
        `🟢 ${b.oa} / 🔒 ${b.closed} / ❓ ${b.unk} ` +
        `| ✨ 再利用可 ${b.reusable} / 🚫 不可 ${b.nonReusable}` +
        editorInfo +
        cacheInfo;
    } else {
      info.textContent = ' (フィルタは表示中ページのみ。全件対象には 🔍 全件スキャンを押してください)';
    }
  }

  // ====== 表示中ページのバッジ付け ======
  const processedLi = new WeakSet();
  async function processVisibleLi(li) {
    if (processedLi.has(li)) return;
    processedLi.add(li);
    const doi = extractDOI(li);
    setBadgeOnLi(li, null);
    const oa = await fetchOA(doi);
    setBadgeOnLi(li, oa);
    if (state.mode === 'page') applyPageFilter();
  }

  function applyPageFilter() {
    if (state.mode !== 'page') return;
    document.querySelectorAll('.paper .field:not(.oa-custom-list) li').forEach(li => {
      const st = li.dataset.oaStatus || 'unknown';
      const reusable = li.dataset.reusable === '1';
      let show = true;
      switch (state.filter) {
        case 'all': show = true; break;
        case 'oa': show = st === 'oa'; break;
        case 'closed': show = st === 'closed'; break;
        case 'unknown': show = st === 'unknown'; break;
        case 'reusable': show = reusable; break;
        case 'non-reusable': show = !reusable; break;
      }
      li.style.display = show ? '' : 'none';
    });
  }

  function extractDOI(li) {
    const divs = li.querySelectorAll('.tagarea .sid');
    for (const d of divs) {
      if (d.classList.contains('oa-badge')) continue;
      const t = d.textContent.trim();
      const m = t.match(/^DOI\s*:\s*(.*)$/i);
      if (m) {
        const v = m[1].trim();
        if (!v || /^(unknown|undefined|-)$/i.test(v)) return null;
        return v;
      }
    }
    return null;
  }

  function setEditorBadgeOnLi(li, names) {
    const tagarea = li.querySelector('.tagarea');
    if (!tagarea) return;
    let badge = li.querySelector('.oa-editor-badge');
    if (!Array.isArray(names) || names.length === 0) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'oa-editor-badge sid';
      const oaBadge = li.querySelector('.oa-badge');
      if (oaBadge && oaBadge.nextSibling) tagarea.insertBefore(badge, oaBadge.nextSibling);
      else tagarea.prepend(badge);
    }
    badge.innerHTML = `👤 <span class="oa-editor-name">${names.map(escapeText).join(', ')}</span>`;
  }

  function setBadgeOnLi(li, oa) {
    let badge = li.querySelector('.oa-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'oa-badge sid';
      const tagarea = li.querySelector('.tagarea');
      if (!tagarea) return;
      tagarea.prepend(badge);
    }
    if (!oa) {
      badge.textContent = '⏳ OA: checking...';
      li.dataset.oaStatus = 'unknown';
      return;
    }
    if (oa.is_oa === true) {
      const link = oa.pdf_url ? ` <a href="${escapeAttr(oa.pdf_url)}" target="_blank" rel="noopener noreferrer">[PDF]</a>` : '';
      const tag = oa.oa_status ? ` (${escapeText(oa.oa_status)})` : '';
      const lic = oa.license ? ` <span style="color:#555;font-weight:normal;">[${escapeText(oa.license)}]</span>` : '';
      const reuse = isReusable(oa.license) ? ' ✨' : '';
      badge.innerHTML = `🟢 Open Access${tag}${lic}${reuse}${link}`;
      li.dataset.oaStatus = 'oa';
      li.dataset.reusable = isReusable(oa.license) ? '1' : '0';
    } else if (oa.is_oa === false) {
      badge.textContent = '🔒 Closed';
      li.dataset.oaStatus = 'closed';
      li.dataset.reusable = '0';
    } else {
      const why = oa.reason ? ` (${oa.reason})` : '';
      badge.textContent = `❓ OA: unknown${why}`;
      li.dataset.oaStatus = 'unknown';
      li.dataset.reusable = '0';
    }
  }

  // ====== プロジェクト全件スキャン ======
  async function startProjectScan() {
    state.scanning = true;
    state.cancel = false;
    state.mode = 'project';
    updateInfo();

    // 取得したページ分の OA 判定を背後で開始（待たない）共通処理
    const startOaFor = (papers) => {
      for (const p of papers) {
        if (state.cancel) break;
        fetchOA(p.fields && p.fields.DOI).then(oa => {
          p.oa = oa;
          state.oaChecked++;
          if (state.oaChecked % 5 === 0 || state.oaChecked === state.allPapers.length) {
            updateInfo();
            if (state.filter !== 'all' && !state.scanning) render();
          }
        });
      }
    };

    const ingestPage = (data) => {
      for (const p of data) {
        state.allPapers.push(p);
        if (p.fields && p.fields.sid != null) {
          state.papersBySid.set(String(p.fields.sid), p);
        }
        // キャッシュ済みの Editor 情報があれば即座に紐付け（追加 API 呼び出しなし）
        if (p.pk) {
          const ec = editorCache[p.pk];
          if (ec && Date.now() - ec.t < EDITOR_CACHE_TTL_MS) {
            p.editors = ec.users;
          }
        }
      }
    };

    // activePageLimit は page=1 のレスポンスサイズを見て調整する（サーバが内部キャップしている場合に同期させる）
    let activePageLimit = PAGE_LIMIT_FOR_PREFETCH;
    const fetchPage = async (page, limitOverride) => {
      const limit = limitOverride != null ? limitOverride : activePageLimit;
      const url = `${SCRIPT_NAME}/paperlist/getpaperlist/all?` + new URLSearchParams({
        projectname,
        pagelimit: String(limit),
        page: String(page),
      });
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), PAGE_FETCH_TIMEOUT_MS);
      try {
        const r = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } finally {
        clearTimeout(tid);
      }
    };

    // まず page=1 を取得して totalPapers と「サーバが実際に返す件数」を確定
    let firstPage;
    try {
      firstPage = await fetchPage(1);
    } catch (e) {
      console.error('[OA filter] page 1 取得失敗', e);
      state.scanning = false;
      updateInfo();
      return;
    }
    if (!Array.isArray(firstPage) || firstPage.length === 0) {
      state.scanning = false;
      updateInfo();
      return;
    }
    ingestPage(firstPage);
    if (firstPage[0] && firstPage[0].totalpapers != null) state.totalPapers = firstPage[0].totalpapers;
    // サーバが pagelimit を内部キャップしている可能性があるので、実際に返ってきた件数を採用
    // ※以降のページ要求も同じ値で送らないと page→offset 変換がずれ、空ページや 504 を引き起こす
    const effectivePageSize = firstPage.length;
    if (effectivePageSize > 0 && effectivePageSize < PAGE_LIMIT_FOR_PREFETCH) {
      console.log(`[OA filter] サーバが pagelimit を ${PAGE_LIMIT_FOR_PREFETCH} → ${effectivePageSize} にキャップ。以降のリクエストもこのサイズで送ります。`);
      activePageLimit = effectivePageSize;
    } else {
      console.log(`[OA filter] pagelimit=${PAGE_LIMIT_FOR_PREFETCH} で ${effectivePageSize} 件取得（totalpapers=${state.totalPapers}）`);
    }
    updateInfo();
    startOaFor(firstPage);

    // 残りのページを並列ワーカーで取得
    const totalPages = state.totalPapers && effectivePageSize > 0
      ? Math.ceil(state.totalPapers / effectivePageSize)
      : 2000;
    let nextPage = 2;
    const fetchedPages = new Set([1]);
    const failedPages = new Set();
    // 末尾を超えたページ番号を全ワーカーで共有する（連続的に空が続く境界を超えたら終了）
    let confirmedEndPage = Infinity;

    async function pageWorker() {
      while (!state.cancel) {
        const myPage = nextPage++;
        if (myPage > Math.min(totalPages + 5, 2000)) return;
        if (myPage > confirmedEndPage) return;
        if (state.totalPapers && state.allPapers.length >= state.totalPapers) return;
        let data;
        try {
          data = await fetchPage(myPage);
        } catch (e) {
          console.error('[OA filter] page ' + myPage + ' 取得失敗（後でリトライ）', e);
          failedPages.add(myPage);
          await sleep(DELAY_BETWEEN_PAGES_MS);
          continue;
        }
        if (state.cancel) return;
        if (!Array.isArray(data) || data.length === 0) {
          // 末尾の可能性もあるが、サーバの一過性レスポンスかもしれないのでリトライ対象に積む
          failedPages.add(myPage);
          if (state.totalPapers && state.allPapers.length >= state.totalPapers) {
            confirmedEndPage = Math.min(confirmedEndPage, myPage);
          }
          await sleep(DELAY_BETWEEN_PAGES_MS);
          continue;
        }
        fetchedPages.add(myPage);
        failedPages.delete(myPage);
        ingestPage(data);
        updateInfo();
        startOaFor(data);
        await sleep(DELAY_BETWEEN_PAGES_MS);
      }
    }
    const pageWorkers = Array.from({ length: Math.max(1, MAX_CONCURRENT_PAGES) }, () => pageWorker());
    await Promise.all(pageWorkers.map(w => w.catch(() => {})));

    // 不足分の救済: totalpapers に対して足りなければ、失敗ページを指数バックオフで順次リトライ
    if (!state.cancel && state.totalPapers && state.allPapers.length < state.totalPapers) {
      const retryQueue = Array.from(failedPages).filter(p => !fetchedPages.has(p)).sort((a, b) => a - b);
      console.log(`[OA filter] 不足 ${state.totalPapers - state.allPapers.length} 件。失敗ページ ${retryQueue.length} 個を指数バックオフでリトライ`);
      for (const myPage of retryQueue) {
        if (state.cancel) break;
        if (state.allPapers.length >= state.totalPapers) break;
        let success = false;
        for (let attempt = 0; attempt < MAX_PAGE_RETRIES && !state.cancel && !success; attempt++) {
          try {
            const data = await fetchPage(myPage);
            if (Array.isArray(data) && data.length > 0) {
              fetchedPages.add(myPage);
              ingestPage(data);
              updateInfo();
              startOaFor(data);
              success = true;
              break;
            }
          } catch (e) {
            console.warn(`[OA filter] リトライ失敗 page=${myPage} attempt=${attempt + 1}/${MAX_PAGE_RETRIES} (${e.message})`);
          }
          // 指数バックオフ: 1, 2, 4, 8, 16 秒
          const backoff = 1000 * Math.pow(2, attempt);
          await sleep(backoff);
        }
        if (!success) console.warn(`[OA filter] page=${myPage} は ${MAX_PAGE_RETRIES} 回リトライしても取得できず`);
      }
    }
    if (state.totalPapers && state.allPapers.length < state.totalPapers) {
      console.warn(`[OA filter] 最終結果: ${state.allPapers.length}/${state.totalPapers} 件（不足が残っています）`);
    } else {
      console.log(`[OA filter] スキャン完了: ${state.allPapers.length}/${state.totalPapers || '?'} 件`);
    }

    // 全件取得完了。OA判定の完了を待つ（中断中なら待たない）
    state.scanning = false;
    updateInfo();

    // 残りの OA 判定が終わるまで待つ（render は重いので 2 秒間隔に間引く）
    let lastRender = 0;
    while (!state.cancel && state.oaChecked < state.allPapers.length) {
      await sleep(500);
      updateInfo();
      if (state.filter !== 'all' && Date.now() - lastRender > 2000) {
        render();
        lastRender = Date.now();
      }
    }
    // 残っているキャッシュ保存をフラッシュ
    if (saveCacheTimer) { clearTimeout(saveCacheTimer); saveCacheTimer = null; saveCacheNow(cache); }
    // 中止されていなければ論文リストを IndexedDB に永続化（次回ページ再訪時にスキャン不要に）
    if (!state.cancel && state.allPapers.length > 0) {
      const ok = await savePaperListCache(state.allPapers, state.totalPapers);
      if (ok) state._cacheRestoredAt = Date.now();
    }
    updateInfo();
    render();
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ====== Editor (キュレーター) スキャン ======
  // opts.mode: 'all'  → 全論文の Editor 情報を取得
  //           'search' → 入力された名前を含む論文を検索（マッチをリアルタイム表示）
  async function startEditorScan(opts = {}) {
    const mode = opts.mode || 'all';
    const term = (opts.term || '').toLowerCase();
    state.scanningEditors = true;
    state.editorCancel = false;
    state.editorScanned = 0;
    state.editorScanMode = mode;
    state.editorSearchTerm = opts.term || '';
    state.editorSearchMatched = 0;

    // 先にキャッシュから埋める（ネットワーク不要）
    for (const p of state.allPapers) {
      if (Array.isArray(p.editors)) continue;
      const c = editorCache[p.pk];
      if (c && Date.now() - c.t < EDITOR_CACHE_TTL_MS) {
        p.editors = c.users;
      }
    }

    const matchesTerm = (p) => Array.isArray(p.editors) &&
      p.editors.some(u => u && typeof u.username === 'string' && u.username.toLowerCase().includes(term));
    if (mode === 'search') {
      state.editorSearchMatched = state.allPapers.filter(matchesTerm).length;
    }
    render();

    const queue = state.allPapers.filter(p => !Array.isArray(p.editors) && p.pk);
    state.editorTotalToFetch = queue.length;
    updateInfo();

    let done = 0;
    let lastRender = 0;
    let qi = 0;

    async function worker() {
      while (qi < queue.length && !state.editorCancel) {
        const p = queue[qi++];
        const users = await fetchEditors(p.pk);
        if (state.editorCancel) return;
        p.editors = Array.isArray(users) ? users : [];
        done++;
        state.editorScanned = done;
        if (mode === 'search' && matchesTerm(p)) state.editorSearchMatched++;
        if (done % 5 === 0 || done === queue.length) {
          updateInfo();
          if (Date.now() - lastRender > 1500) {
            render();
            lastRender = Date.now();
          }
        }
        await sleep(DELAY_BETWEEN_EDITOR_MS);
      }
    }
    const workers = Array.from({ length: Math.max(1, MAX_CONCURRENT_EDITOR) }, () => worker());
    await Promise.all(workers.map(w => w.catch(() => {})));

    if (saveEditorCacheTimer) { clearTimeout(saveEditorCacheTimer); saveEditorCacheTimer = null; saveEditorCacheNow(editorCache); }
    state.scanningEditors = false;
    state.editorScanMode = null;
    updateInfo();
    render();
  }

  // ====== カスタム一覧描画 (project モード時) ======
  function render() {
    updateInfo();
    if (state.mode !== 'project') { applyPageFilter(); return; }

    const originalField = document.querySelector('.paper .field:not(.oa-custom-list)');
    const originalPagelimit = document.querySelector('.paper .pagelimit');
    const originalPagination = document.querySelector('.paper .pagination');
    let customWrap = document.getElementById('oa-custom-wrap');

    if (state.filter === 'all' && !state.selectedEditor) {
      if (originalField) originalField.style.display = '';
      if (originalPagelimit) originalPagelimit.style.display = '';
      if (originalPagination) originalPagination.style.display = '';
      if (customWrap) customWrap.style.display = 'none';
      // 全件モード時も表示中ページにバッジを反映
      document.querySelectorAll('.paper .field:not(.oa-custom-list) li').forEach(li => {
        const p = findPaperByLi(li);
        if (p && p.oa) setBadgeOnLi(li, p.oa);
        else processVisibleLi(li);
        if (p) setEditorBadgeOnLi(li, paperEditorNames(p));
      });
      return;
    }

    if (originalField) originalField.style.display = 'none';
    if (originalPagelimit) originalPagelimit.style.display = 'none';
    if (originalPagination) originalPagination.style.display = 'none';

    const filtered = state.allPapers.filter(passesFilter);

    if (!customWrap) {
      const host = document.querySelector('.paper');
      if (!host) return;
      customWrap = document.createElement('div');
      customWrap.id = 'oa-custom-wrap';
      customWrap.innerHTML = `
        <div class="oa-custom-pagination"></div>
        <ul class="field oa-custom-list" id="oa-custom-list"></ul>
        <div class="oa-custom-pagination"></div>
      `;
      host.appendChild(customWrap);
    }
    customWrap.style.display = '';
    const list = customWrap.querySelector('#oa-custom-list');
    list.innerHTML = '';

    const totalPages = Math.max(1, Math.ceil(filtered.length / CUSTOM_PAGE_SIZE));
    if (state.customPage > totalPages) state.customPage = totalPages;
    const startIdx = (state.customPage - 1) * CUSTOM_PAGE_SIZE;
    const pageItems = filtered.slice(startIdx, startIdx + CUSTOM_PAGE_SIZE);

    if (filtered.length === 0) {
      const msg = document.createElement('div');
      msg.style.padding = '12px';
      msg.style.color = '#666';
      const filterDesc = `フィルタ: ${state.filter}${state.selectedEditor ? ` / 👤 ${state.selectedEditor}` : ''}`;
      msg.textContent = `条件に一致する論文はありません (${filterDesc})`;
      list.appendChild(msg);
    } else {
      for (const p of pageItems) list.appendChild(buildPaperLi(p));
    }

    const pagerHtml = `
      <button data-page="1" ${state.customPage <= 1 ? 'disabled' : ''}>&lt;&lt;</button>
      <button data-page="${state.customPage - 1}" ${state.customPage <= 1 ? 'disabled' : ''}>&lt;</button>
      <span>${state.customPage} / ${totalPages}</span>
      <button data-page="${state.customPage + 1}" ${state.customPage >= totalPages ? 'disabled' : ''}>&gt;</button>
      <button data-page="${totalPages}" ${state.customPage >= totalPages ? 'disabled' : ''}>&gt;&gt;</button>
      <span style="margin-left:12px; color:#555; font-size:0.9em;">
        全 ${filtered.length} 件 (プロジェクト ${state.allPapers.length} 件中)
      </span>
    `;
    customWrap.querySelectorAll('.oa-custom-pagination').forEach(pg => {
      pg.innerHTML = pagerHtml;
      pg.querySelectorAll('button[data-page]').forEach(b => {
        b.addEventListener('click', () => {
          state.customPage = Number(b.dataset.page);
          render();
          window.scrollTo({ top: customWrap.offsetTop - 20, behavior: 'smooth' });
        });
      });
    });
  }

  function findPaperByLi(li) {
    const sidDiv = Array.from(li.querySelectorAll('.tagarea .sid'))
      .find(d => /^SID\s*:/i.test(d.textContent.trim()));
    if (!sidDiv) return null;
    const sid = sidDiv.textContent.replace(/^SID\s*:\s*/i, '').trim();
    return state.papersBySid.get(sid) || null;
  }

  function buildPaperLi(p) {
    const f = p.fields || {};
    const li = document.createElement('li');
    li.dataset.oaStatus = paperStatus(p);
    li.dataset.pk = p.pk;

    const checkbox = document.createElement('div');
    checkbox.className = 'checkbox';
    checkbox.innerHTML = `<div class="space"></div><label></label>`;
    li.appendChild(checkbox);

    const content = document.createElement('div');
    content.className = 'papercontent';

    const tagarea = document.createElement('div');
    tagarea.className = 'tagarea';
    const oa = p.oa;
    let badgeHtml = '❓ OA: unknown';
    if (oa && oa.is_oa === true) {
      const link = oa.pdf_url ? ` <a href="${escapeAttr(oa.pdf_url)}" target="_blank" rel="noopener noreferrer">[PDF]</a>` : '';
      const tag = oa.oa_status ? ` (${escapeText(oa.oa_status)})` : '';
      const lic = oa.license ? ` <span style="color:#555;font-weight:normal;">[${escapeText(oa.license)}]</span>` : '';
      const reuse = isReusable(oa.license) ? ' ✨' : '';
      badgeHtml = `🟢 Open Access${tag}${lic}${reuse}${link}`;
    } else if (oa && oa.is_oa === false) {
      badgeHtml = '🔒 Closed';
    } else if (oa && oa.reason) {
      badgeHtml = `❓ OA: unknown (${escapeText(oa.reason)})`;
    }
    const editorNames = paperEditorNames(p);
    const editorBadgeHtml = editorNames.length > 0
      ? `<div class="sid oa-editor-badge">👤 <span class="oa-editor-name">${editorNames.map(escapeText).join(', ')}</span></div>`
      : '';
    tagarea.innerHTML = `
      <div class="sid oa-badge">${badgeHtml}</div>
      ${editorBadgeHtml}
      <div class="sid">SID : ${escapeText(f.sid)}</div>
      <div class="sid">DOI : ${escapeText(f.DOI)}</div>
      <div class="sid">Figure : ${escapeText(f.fignum)}</div>
      <div class="sid">Sample : ${escapeText(f.samnum)}</div>
      <div class="sid">Year : ${escapeText(getYear(f))}</div>
    `;
    content.appendChild(tagarea);

    const titleLabel = document.createElement('label');
    titleLabel.className = 'content';
    titleLabel.innerHTML = `
      <div class="title">${escapeText(f.title)}</div>
      <div class="author">${buildAuthors(f.author)}</div>
      <div class="journal">${escapeText(f.container_title || '')} ${escapeText(f.volume || '')} (${escapeText(getYear(f))}) ${escapeText(f.page && f.page !== 'unknown' ? f.page : (f.article_number || ''))}.</div>
    `;
    content.appendChild(titleLabel);

    const commonLabel = document.createElement('label');
    commonLabel.className = 'common';
    const paperUrl = f.DOI && f.DOI !== 'unknown' ? `https://doi.org/${encodeURIComponent(f.DOI)}` : '#';
    commonLabel.innerHTML = `
      <div class="jump">
        <a href="${escapeAttr(paperUrl)}" target="_blank" rel="noopener noreferrer">Original paper</a>
        <a href="${SCRIPT_NAME}/paperlist/source/${escapeAttr(p.pk)}/${escapeAttr(projectname)}">Bibliographic information</a>
        <a href="${SCRIPT_NAME}/paperlist/data/${escapeAttr(p.pk)}/${escapeAttr(projectname)}">Data</a>
        <a href="${SCRIPT_NAME}/paperlist/report/${escapeAttr(p.pk)}/${escapeAttr(projectname)}">Summary</a>
        <a href="${SCRIPT_NAME}/paperlist/sample_table/${escapeAttr(p.pk)}/${escapeAttr(projectname)}">Sample Table</a>
      </div>
    `;
    content.appendChild(commonLabel);

    li.appendChild(content);
    return li;
  }

  function buildAuthors(authors) {
    if (!Array.isArray(authors)) return '';
    return authors.map(a => {
      const g = a.given ? `${escapeText(String(a.given)[0] || '')}.` : '';
      const f = a.family ? `${escapeText(a.family)},&nbsp;` : '';
      return `${g} ${f}`;
    }).join(' ');
  }

  function getYear(f) {
    if (!f) return '-';
    const tryFields = ['issued', 'published-print', 'published-online'];
    for (const k of tryFields) {
      const v = f[k];
      if (v && v['date-parts'] && v['date-parts'][0] && v['date-parts'][0][0]) {
        return String(v['date-parts'][0][0]);
      }
    }
    if (f.year) return String(f.year);
    return '-';
  }

  function escapeText(v) {
    if (v == null) return '';
    return String(v).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function escapeAttr(v) { return escapeText(v); }

  // ====== 起動: UI 注入 + 表示中ページのバッジ ======
  // 自分自身の DOM 変更がオブザーバを再発火させるループを防ぐため
  // rAF で 1 フレーム 1 回にデバウンスする
  let observerScheduled = false;
  function scheduleObserverWork() {
    if (observerScheduled) return;
    observerScheduled = true;
    requestAnimationFrame(() => {
      observerScheduled = false;
      runObserverWork();
    });
  }
  function runObserverWork() {
    injectFilterUI();
    // スキャン中はカスタム一覧で結果が反映されるので、表示中ページの再走査をスキップ
    // （findPaperByLi/setBadgeOnLi のループが allPapers の増加と共に重くなる）
    if (state.scanning) return;
    const lis = document.querySelectorAll('.paper .field:not(.oa-custom-list) li');
    if (state.mode === 'project') {
      lis.forEach(li => {
        const p = findPaperByLi(li);
        if (p && p.oa) setBadgeOnLi(li, p.oa);
        else processVisibleLi(li);
      });
    } else {
      lis.forEach(li => processVisibleLi(li));
      applyPageFilter();
    }
  }
  const observer = new MutationObserver(scheduleObserverWork);
  observer.observe(document.body, { childList: true, subtree: true });

  // ====== キャッシュから自動復元 ======
  // ページ再訪時にスキャン不要で即フィルタを使えるようにする
  async function restoreFromCache() {
    const cached = await loadPaperListCache();
    if (!cached || !Array.isArray(cached.papers) || cached.papers.length === 0) return false;

    state.mode = 'project';
    state.allPapers = cached.papers;
    state.totalPapers = cached.totalPapers || cached.papers.length;
    state.papersBySid.clear();
    state.oaChecked = 0;

    for (const p of state.allPapers) {
      if (p.fields && p.fields.sid != null) {
        state.papersBySid.set(String(p.fields.sid), p);
      }
      // OA キャッシュから復元
      const doi = p.fields && p.fields.DOI;
      if (doi && typeof doi === 'string' && /^10\./.test(doi.trim())) {
        const key = doi.toLowerCase().trim();
        const c = cache[key];
        if (c && Date.now() - c.t < CACHE_TTL_MS) {
          p.oa = c.v;
          state.oaChecked++;
        }
      } else {
        p.oa = { is_oa: null, reason: 'no-doi' };
        state.oaChecked++;
      }
      // Editor キャッシュから復元
      if (p.pk) {
        const ec = editorCache[p.pk];
        if (ec && Date.now() - ec.t < EDITOR_CACHE_TTL_MS) {
          p.editors = ec.users;
        }
      }
    }
    state._cacheRestoredAt = cached.t;
    return true;
  }

  // 起動時の初期注入
  injectFilterUI();
  restoreFromCache().then(ok => {
    if (ok) {
      updateInfo();
      render();
    } else {
      updateInfo();
    }
  });
})();
