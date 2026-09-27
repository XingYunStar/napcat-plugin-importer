/**
 * 注入到 NapCat WebUI 主页面（非 iframe）的脚本：把「导入插件」按钮放回「插件管理」页，
 * 位置/样式与原版一致。由 napcat-plugin-importer 在启动时**内联**写进 static/index.html
 * （内联而不是外链，避免多一次 /plugin/... 请求——反代只放行 /webui 时也能用）。
 *
 * 设计要点：
 *  - 只在「插件管理」页出现（锚点 = 页面里的 <h1>插件管理</h1>，不依赖路由前缀）
 *  - 锚点找不到时（某些改版可能改结构）在右下角给一个悬浮按钮兜底，锚点恢复后自动移除
 *  - SPA 路由切换 / React 重新渲染后自动补回（MutationObserver + 定时兜底）
 *  - 点击时才探测插件是否在线，插件没装/没启用就明确提示，不白挂死按钮
 *  - 接口地址按候选顺序自动探测：/api/Plugin/ext/... → <前缀>/api/... → /plugin/... ← 兼容各种反代
 *  - 凭证：优先复用 WebUI 登录凭证（同源 localStorage.token），失败则提示输入访问口令
 */
(function () {
  'use strict';
  if (window.__napcatImporterBtnLoaded) return;
  window.__napcatImporterBtnLoaded = true;

  var PLUGIN_ID = 'napcat-plugin-importer';
  var BTN_ATTR = 'data-napcat-importer-btn';
  var FAB_ATTR = 'data-napcat-importer-fab';
  var TOKEN_KEY = 'napcat-importer-token';
  var MARK_TEXT = '插件管理';
  // 悬浮兜底按钮的延迟：正常页面不到 1s 就渲染出锚点，等 3s 再兜底，避免闪一下
  var FAB_DELAY = typeof window.__napcatImporterFabDelay === 'number' ? window.__napcatImporterFabDelay : 3000;
  var startedAt = Date.now();

  var log = function () {
    try { console.log.apply(console, ['[importer-btn]'].concat([].slice.call(arguments))); } catch (e) {}
  };

  // ---------------------------------------------------------------- 接口地址探测
  /** WebUI 装在子路径时（如 /napcat/webui/...）需要带上前缀 */
  function prefix () {
    var p = location.pathname;
    var i = p.indexOf('/webui');
    return i > 0 ? p.slice(0, i) : '';
  }
  var baseCache = null;
  function baseCandidates () {
    var pre = prefix();
    var out = ['/api/Plugin/ext/' + PLUGIN_ID];                      // 与 WebUI 自身请求一致（绝对 /api）
    if (pre) out.push(pre + '/api/Plugin/ext/' + PLUGIN_ID);         // 带前缀的 /api
    out.push(pre + '/plugin/' + PLUGIN_ID + '/api');                 // 插件免鉴权挂载路径
    if (pre) out.push('/plugin/' + PLUGIN_ID + '/api');
    return out;
  }

  function webuiCredential () {
    var raw = null;
    try { raw = localStorage.getItem('token'); } catch (e) {}
    if (!raw) return '';
    try { var v = JSON.parse(raw); return typeof v === 'string' ? v : ''; } catch (e) { return raw; }
  }
  function storedToken () { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function authHeader () { return 'Bearer ' + (storedToken() || webuiCredential()); }

  function rawCall (base, path, opt) {
    var o = opt || {};
    var headers = {};
    for (var k in (o.headers || {})) headers[k] = o.headers[k];
    if (o.auth !== false) headers.Authorization = authHeader();
    return fetch(base + path, { method: o.method || 'GET', headers: headers, body: o.body })
      .then(function (r) {
        return r.json().catch(function () { return { code: -1, message: 'HTTP ' + r.status }; })
          .then(function (j) { return { status: r.status, body: j, base: base }; });
      });
  }

  /** 调用接口：命中过的 base 会被记住；404/405 就换下一个候选 */
  function api (path, opt) {
    if (baseCache) {
      return rawCall(baseCache, path, opt).then(function (r) {
        if (r.status === 404 || r.status === 405) { baseCache = null; return api(path, opt); }
        return r;
      });
    }
    var list = baseCandidates();
    var i = 0;
    function next () {
      if (i >= list.length) {
        return { status: 404, body: { code: -1, message: '找不到插件接口（检查反代是否放行 /api 或 /plugin）' }, base: '' };
      }
      var b = list[i++];
      return rawCall(b, path, opt).then(function (r) {
        if (r.status === 404 || r.status === 405) return next();
        if (r.status === 200 || r.status === 401 || r.status === 429) { baseCache = b; log('接口地址确定：' + b); }
        return r;
      });
    }
    return Promise.resolve().then(next);
  }

  /** 插件在线检测：200/401/429 都说明接口在（404/503 = 插件未加载）。按设计不带凭证 */
  function pluginAlive () {
    return api('/list', { auth: false }).then(function (r) {
      return r.status === 200 || r.status === 401 || r.status === 429;
    }).catch(function () { return false; });
  }

  // ---------------------------------------------------------------- toast
  var toastEl = null, toastTimer = null;
  function toast (msg, kind) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:360px;' +
        'padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;white-space:pre-wrap;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.18);border:1px solid rgba(0,0,0,.12);background:#fff;color:#18181b';
      document.body.appendChild(toastEl);
    }
    var colors = { ok: '#17c964', err: '#f31260', warn: '#f5a524', info: '#006fee' };
    toastEl.style.borderLeft = '3px solid ' + (colors[kind] || colors.info);
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (toastEl) toastEl.style.display = 'none'; }, kind === 'err' ? 8000 : 4000);
  }

  // ---------------------------------------------------------------- 按钮
  var ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/>' +
    '<line x1="12" y1="3" x2="12" y2="15"/></svg>';

  function makeButton (attr) {
    var b = document.createElement('button');
    b.setAttribute(attr, '1');
    b.type = 'button';
    b.title = '导入本地插件 zip（由 ' + PLUGIN_ID + ' 提供）';
    // 与原版「导入插件」按钮同一套 Tailwind 类，看起来就是原生按钮
    b.className = 'bg-primary-100/50 hover:bg-primary-200/50 text-primary-700 backdrop-blur-md ' +
      'rounded-full inline-flex items-center justify-center gap-2 px-4 h-10 text-sm font-medium transition-colors';
    b.style.cursor = 'pointer';
    b.innerHTML = ICON + '<span>导入插件</span>';
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
  }

  /** 锚点：页面上的 <h1>插件管理</h1>（官方各版本都是这个结构） */
  function findAnchor () {
    var h1s = document.querySelectorAll('h1');
    for (var i = 0; i < h1s.length; i++) {
      var t = (h1s[i].textContent || '').trim();
      if (t === MARK_TEXT || t === MARK_TEXT + ' ') return h1s[i];
    }
    var bold = document.querySelectorAll('[class*="font-bold"]');
    for (var j = 0; j < bold.length; j++) {
      if ((bold[j].textContent || '').trim() === MARK_TEXT && bold[j].children.length === 0) return bold[j];
    }
    return null;
  }

  /** 是否在插件管理路由上（/webui/plugins，兼容子路径前缀） */
  function onPluginsRoute () {
    return /\/plugins\/?$/.test(location.pathname) || /\/plugins\/?$/.test(location.hash.replace(/^#/, ''));
  }

  function removeFab () {
    var f = document.querySelector('[' + FAB_ATTR + ']');
    if (f && f.parentNode) { f.parentNode.removeChild(f); log('已移除悬浮兜底按钮'); }
  }
  function injectFab () {
    if (document.querySelector('[' + FAB_ATTR + ']') || !document.body) return;
    var b = makeButton(FAB_ATTR);
    b.style.position = 'fixed';
    b.style.right = '18px';
    b.style.bottom = '18px';
    b.style.zIndex = '2147483000';
    b.style.boxShadow = '0 8px 24px rgba(0,0,0,.18)';
    document.body.appendChild(b);
    log('没找到页面锚点，已在右下角放一个悬浮「导入插件」按钮');
  }

  function inject () {
    if (document.querySelector('[' + BTN_ATTR + ']')) { removeFab(); return true; }
    var h1 = findAnchor();
    if (h1) {
      (h1.parentElement || h1).appendChild(makeButton(BTN_ATTR));
      removeFab();
      log('已注入「导入插件」按钮');
      return true;
    }
    // 兜底：在插件管理路由上等一会儿还没锚点，就放悬浮按钮
    if (onPluginsRoute() && Date.now() - startedAt > FAB_DELAY) injectFab();
    return false;
  }

  // ---------------------------------------------------------------- 选文件 / 上传
  var input = null;
  function pickFile () {
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,application/zip';
      input.style.display = 'none';
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        input.value = '';
        if (f) upload(f);
      });
      document.body.appendChild(input);
    }
    input.click();
  }

  function readBase64 (file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || '');
        var i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : '');
      };
      fr.onerror = function () { reject(new Error('读取文件失败')); };
      fr.readAsDataURL(file);
    });
  }

  /** 提示输入访问口令；返回是否成功记下 */
  function askToken () {
    var t = window.prompt('需要鉴权：请输入访问口令\n（默认就是 WebUI 的 token，即 config/webui.json 里的 token；也可在插件配置里单独设置）');
    if (t && t.trim()) {
      try { localStorage.setItem(TOKEN_KEY, t.trim()); } catch (e) {}
      toast('已记住口令，请再点一次「导入插件」', 'ok');
      return true;
    }
    return false;
  }

  function upload (file) {
    if (!/\.zip$/i.test(file.name)) { toast('请选择 .zip 格式的插件包', 'err'); return; }
    toast('正在导入 ' + file.name + '（' + (file.size / 1024).toFixed(0) + ' KB）…', 'info');
    readBase64(file).then(function (base64) {
      return api('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, base64: base64 })
      });
    }).then(function (r) {
      if (r.status === 401 || r.status === 429) {
        if (!askToken()) toast('鉴权失败：' + ((r.body && r.body.message) || 'Unauthorized'), 'err');
        return;
      }
      if (!r.body || r.body.code !== 0) { toast('导入失败：' + ((r.body && r.body.message) || '未知错误'), 'err'); return; }
      var d = r.body.data || {};
      toast('✅ ' + d.message + (d.needRestart ? '\n（需要重启 NapCat 后生效）' : ''), d.needRestart ? 'warn' : 'ok');
      setTimeout(function () { location.reload(); }, 1200);
    }).catch(function (e) { toast('导入失败：' + (e && e.message), 'err'); });
  }

  function onClick () {
    pluginAlive().then(function (alive) {
      if (!alive) { toast('导入器插件没有在运行：请先安装并启用 ' + PLUGIN_ID, 'err'); return; }
      pickFile();
    });
  }

  // ---------------------------------------------------------------- 启动 + SPA 监听
  inject();
  // 启动后的快速重试阶梯：SPA 首屏渲染 / 路由切换后按钮更快出现，兜底按钮也不用等轮询
  [300, 800, 1500, 3000, 6000].forEach(function (t) { setTimeout(inject, t); });

  // 路由变化立即重试：点侧边栏切换页面走的是 history.pushState，
  // 它不会触发任何 DOM 事件，光靠 MutationObserver/轮询会慢半拍
  (function hookHistory () {
    try {
      ['pushState', 'replaceState'].forEach(function (k) {
        var orig = window.history[k];
        if (typeof orig !== 'function' || orig.__napcatImporterHooked) return;
        var wrapped = function () {
          var r = orig.apply(this, arguments);
          setTimeout(inject, 0);
          return r;
        };
        wrapped.__napcatImporterHooked = true;
        window.history[k] = wrapped;
      });
    } catch (e) { /* ignore */ }
    window.addEventListener('popstate', function () { setTimeout(inject, 0); });
    window.addEventListener('hashchange', function () { setTimeout(inject, 0); });
  })();

  var pending = false;
  try {
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () { pending = false; inject(); }, 250);
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* ignore */ }
  setInterval(inject, 1500);
  log('已加载（接口候选：' + baseCandidates().join(' , ') + '）');
})();
