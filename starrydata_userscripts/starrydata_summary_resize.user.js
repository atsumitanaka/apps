// ==UserScript==
// @name         Starrydata2 Summary Chart Resize
// @namespace    user.starrydata.summary
// @version      1.2.0
// @description  Summary (report) ページの Chart.js グラフをウィンドウ幅に追従させ、UI からカラム数とデータ点サイズを切り替え可能にする
// @author       you
// @match        https://starrydata.nims.go.jp/starrydata2/paperlist/report/*
// @match        https://starrydata.nims.go.jp/starrydata2/paperlist/report/*/* 
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ====== 設定 ======
  const COLS_KEY = 'starrydata_summary_cols';
  const DEFAULT_COLS = 'auto';         // 'auto' | '1' | '2' | '3' | '4' | '5' | '6'
  const AUTO_MIN_PX = 520;             // auto モードで各タイルに確保する最小幅
  const GAP_PX = 16;

  const PT_KEY = 'starrydata_summary_pt';
  const DEFAULT_PT = 3;                // デフォルトのデータ点半径 (px)
  const PT_MIN = 0;
  const PT_MAX = 12;

  function loadCols() {
    const v = localStorage.getItem(COLS_KEY);
    if (v == null) return DEFAULT_COLS;
    return v;
  }
  function saveCols(v) {
    try { localStorage.setItem(COLS_KEY, String(v)); } catch (_) {}
  }
  let currentCols = loadCols();

  function loadPt() {
    const v = parseFloat(localStorage.getItem(PT_KEY));
    if (!isFinite(v)) return DEFAULT_PT;
    return Math.min(PT_MAX, Math.max(PT_MIN, v));
  }
  function savePt(v) {
    try { localStorage.setItem(PT_KEY, String(v)); } catch (_) {}
  }
  let currentPt = loadPt();

  // ====== 静的な CSS（レイアウト固定を解除）======
  const style = document.createElement('style');
  style.textContent = `
    #graphview {
      width: 100% !important;
      max-width: 100% !important;
      box-sizing: border-box;
      display: grid !important;
      gap: ${GAP_PX}px;
    }
    #graphview .item {
      width: auto !important;
      max-width: 100% !important;
      min-width: 0 !important;
      box-sizing: border-box;
    }
    #graphview .item canvas {
      width: 100% !important;
      height: auto !important;
      display: block;
      max-width: 100%;
    }

    /* ===== UI パネル ===== */
    .oa-summary-cols {
      display: inline-flex; align-items: center; gap: 6px;
      margin: 6px 0 10px 0; padding: 4px 8px;
      background: #f6f6f6; border: 1px solid #ccc; border-radius: 4px;
      font-size: 0.9em;
    }
    .oa-summary-cols label { font-weight: bold; }
    .oa-summary-cols button {
      padding: 2px 8px; border: 1px solid #bbb; background: #fff;
      border-radius: 3px; cursor: pointer; font-size: 0.9em;
    }
    .oa-summary-cols button.active {
      background: #0a8a3a; color: #fff; border-color: #0a8a3a;
    }
    .oa-summary-cols button:hover:not(.active) { background: #eaeaea; }
    .oa-summary-cols .oa-cols-info { color: #666; margin-left: 6px; }
    .oa-summary-cols .oa-sep { width: 1px; height: 18px; background: #ccc; margin: 0 4px; }
    .oa-summary-cols input[type="range"] { width: 140px; vertical-align: middle; }
    .oa-summary-cols .oa-pt-val { display: inline-block; min-width: 2.2em; text-align: right; }
  `;
  document.head.appendChild(style);

  // ====== grid-template-columns を切り替え ======
  function applyCols(cols) {
    currentCols = cols;
    saveCols(cols);
    const g = document.getElementById('graphview');
    if (!g) return;
    if (cols === 'auto') {
      g.style.gridTemplateColumns = `repeat(auto-fit, minmax(${AUTO_MIN_PX}px, 1fr))`;
    } else {
      const n = Math.max(1, parseInt(cols, 10) || 1);
      // minmax(0, 1fr) にすることで小さいウィンドウでも指定列数を維持
      g.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
    }
    updateButtons();
    // 列数が変わったら Chart.js に再計算させる
    scheduleResize(50);
    scheduleResize(300);
  }

  // ====== UI パネルを挿入 ======
  let panel = null;
  function injectPanel() {
    if (panel && document.body.contains(panel)) return;
    const g = document.getElementById('graphview');
    if (!g) return;

    panel = document.createElement('div');
    panel.className = 'oa-summary-cols';
    const buttons = ['auto', '1', '2', '3', '4', '5', '6']
      .map(v => `<button data-cols="${v}">${v === 'auto' ? 'Auto' : v}</button>`).join('');
    panel.innerHTML = `
      <label>📊 カラム数:</label>
      ${buttons}
      <span class="oa-sep"></span>
      <label>● 点サイズ:</label>
      <input type="range" class="oa-pt-slider" min="${PT_MIN}" max="${PT_MAX}" step="0.5" value="${currentPt}">
      <span class="oa-pt-val">${currentPt}</span>
      <button class="oa-pt-reset" title="デフォルト (${DEFAULT_PT}) に戻す">↺</button>
      <span class="oa-cols-info">(ウィンドウ幅: <span class="oa-cols-ww">-</span>px)</span>
    `;
    // #graphview の直前に置く
    g.parentNode.insertBefore(panel, g);

    panel.querySelectorAll('button[data-cols]').forEach(b => {
      b.addEventListener('click', () => applyCols(b.dataset.cols));
    });
    const slider = panel.querySelector('.oa-pt-slider');
    const ptVal = panel.querySelector('.oa-pt-val');
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      ptVal.textContent = v;
      applyPt(v);
    });
    panel.querySelector('.oa-pt-reset').addEventListener('click', () => {
      slider.value = DEFAULT_PT;
      ptVal.textContent = DEFAULT_PT;
      applyPt(DEFAULT_PT);
    });
    updateButtons();
    updateInfo();
  }

  // ====== データ点サイズを全チャートに適用 ======
  // 元のサイズを覚えておいて、スライダー値 = 追加のオフセットではなく「絶対値」として上書き
  function applyPt(pt) {
    currentPt = pt;
    savePt(pt);
    if (!window.Chart || typeof Chart.getChart !== 'function') return 0;
    let n = 0;
    document.querySelectorAll('canvas').forEach(cv => {
      const c = Chart.getChart(cv);
      if (!c || !c.data || !Array.isArray(c.data.datasets)) return;
      let touched = false;
      for (const ds of c.data.datasets) {
        // 元値を1回だけ退避
        if (!('_origPointRadius' in ds)) ds._origPointRadius = ds.pointRadius;
        if (!('_origPointHoverRadius' in ds)) ds._origPointHoverRadius = ds.pointHoverRadius;
        ds.pointRadius = pt;
        ds.pointHoverRadius = pt + 2;
        touched = true;
      }
      if (touched) {
        try { c.update('none'); n++; } catch (_) {}
      }
    });
    return n;
  }

  function updateButtons() {
    if (!panel) return;
    panel.querySelectorAll('button[data-cols]').forEach(b => {
      b.classList.toggle('active', b.dataset.cols === currentCols);
    });
  }
  function updateInfo() {
    if (!panel) return;
    const ww = panel.querySelector('.oa-cols-ww');
    if (ww) ww.textContent = window.innerWidth;
  }

  // ====== Chart.js インスタンスを resize ======
  function resizeAllCharts() {
    if (!window.Chart || typeof Chart.getChart !== 'function') return 0;
    let n = 0;
    document.querySelectorAll('canvas').forEach(cv => {
      const c = Chart.getChart(cv);
      if (c) { try { c.resize(); n++; } catch (_) {} }
    });
    return n;
  }

  let resizeTimer = null;
  function scheduleResize(delay = 150) {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeAllCharts, delay);
  }

  // ====== window resize ======
  window.addEventListener('resize', () => {
    updateInfo();
    scheduleResize(150);
  });

  // ====== graphview サイズ変化も監視（保険） ======
  let roAttached = false;
  function attachResizeObserver() {
    if (roAttached) return;
    const g = document.getElementById('graphview');
    if (!g) return;
    const ro = new ResizeObserver(() => scheduleResize(150));
    ro.observe(g);
    roAttached = true;
  }

  // ====== 起動 ======
  const kickTimes = [200, 600, 1500, 3000, 6000];
  kickTimes.forEach(ms => {
    setTimeout(() => {
      injectPanel();
      attachResizeObserver();
      applyCols(currentCols);
      applyPt(currentPt);
      const n = resizeAllCharts();
      if (ms === kickTimes[kickTimes.length - 1]) {
        console.log(`[summary-resize] initial: cols=${currentCols}, pt=${currentPt}, ${n} charts`);
      }
    }, ms);
  });
})();
