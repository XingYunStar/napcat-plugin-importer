/**
 * 注入脚本的真 DOM 测试（用 jsdom 模拟 WebUI 的「插件管理」页）。
 * 需要先装 jsdom：  mkdir -p /tmp/domtest && cd /tmp/domtest && npm i jsdom
 * 运行：            node test-inject-dom.mjs [jsdom路径]
 */
import fs from 'node:fs';
import path from 'node:path';

const JSDOM_PATHS = [
  process.argv[2],
  '/tmp/domtest/node_modules/jsdom',
  path.join(process.cwd(), 'node_modules/jsdom')
].filter(Boolean);

let jsdomMod = null, jsdomFrom = '';
for (const p of JSDOM_PATHS) {
  try { jsdomMod = await import(path.join(p, 'lib/api.js')); jsdomFrom = p; break; } catch { /* next */ }
}
if (!jsdomMod) {
  console.log('⚠ 未找到 jsdom，跳过 DOM 测试（npm i jsdom 后再跑）');
  process.exit(0);
}
const { JSDOM } = jsdomMod;
console.log('使用 jsdom：' + jsdomFrom);

const INJECT_JS = fs.readFileSync(path.join(import.meta.dirname, '..', 'webui', 'inject.js'), 'utf8');

// WebUI 插件管理页的真实结构（取自官方构建产物里的类名）
const PAGE = `<!doctype html><html><head><title>NapCat WebUI</title></head><body>
<div id="root"><div class="p-2 md:p-4 relative">
  <div class="flex mb-6 items-center gap-4">
    <h1 class="text-2xl font-bold">插件管理</h1>
    <button class="bg-default-100/50" aria-label="refresh"><svg width="24" height="24"></svg></button>
  </div>
  <div class="grid">插件列表</div>
</div></div></body></html>`;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name, extra); } else { fail++; console.log('  ❌', name, extra); }
};
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

function makeDom ({ credential = 'CREDENTIAL-XYZ', routes = {}, prompt = null } = {}) {
  const dom = new JSDOM(PAGE, { url: 'http://127.0.0.1:6003/webui/plugins', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  if (credential) w.localStorage.setItem('token', JSON.stringify(credential));
  const calls = [];
  w.fetch = async (url, opt = {}) => {
    calls.push({ url: String(url), method: (opt.method || 'GET'), headers: opt.headers || {}, body: opt.body });
    const key = Object.keys(routes).find(k => String(url).includes(k));
    const r = key ? routes[key] : { status: 200, json: { code: 0, data: { plugins: [] } } };
    return {
      status: r.status,
      json: async () => r.json
    };
  };
  if (prompt !== null) w.prompt = () => prompt;
  w.eval(INJECT_JS);
  return { dom, w, calls };
}

console.log('\n【A】 锚点与按钮注入');
{
  const { w, calls } = makeDom();
  const header = w.document.querySelector('.flex.mb-6.items-center.gap-4');
  const btn = w.document.querySelector('[data-napcat-importer-btn]');
  check('按钮已注入', !!btn);
  check('注入在插件管理页的头部容器里（h1 旁边）', !!btn && btn.parentElement === header);
  // 官方原版顺序是：h1「插件管理」 → 刷新按钮 → 导入插件按钮
  check('位置与原版一致（h1 / 刷新 / 导入插件）',
    header.children[0].tagName === 'H1' && header.children[1].tagName === 'BUTTON' && header.children[2] === btn,
    [...header.children].map(e => e.tagName).join(','));
  check('按钮文案是「导入插件」', btn && /导入插件/.test(btn.textContent));
  check('复用原版按钮样式类', btn && btn.className.includes('bg-primary-100/50') && btn.className.includes('text-primary-700'));
  check('带上传图标', btn && /<svg/.test(btn.innerHTML));
  check('加载时没有多余请求（点击才探测）', calls.length === 0, `calls=${calls.length}`);
  w.close();
}

console.log('\n【B】 点击 → 探测插件 → 打开文件选择器');
{
  const { w, calls } = makeDom();
  const btn = w.document.querySelector('[data-napcat-importer-btn]');
  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  check('先请求 /list 探测插件是否在线', calls.some(c => /\/api\/Plugin\/ext\/napcat-plugin-importer\/list$/.test(c.url)));
  check('探测请求是裸 GET（按设计不外发凭证）', calls[0] && calls[0].method === 'GET' && !calls[0].headers.Authorization, JSON.stringify(calls[0] && calls[0].headers));
  const input = w.document.querySelector('input[type=file]');
  check('创建了隐藏的 file input 且限定 .zip', !!input && input.accept.includes('.zip'));
  const { w: w3 } = makeDom({ routes: { '/list': { status: 503, json: { code: -1 } } } });
  const b3 = w3.document.querySelector('[data-napcat-importer-btn]');
  b3.dispatchEvent(new w3.MouseEvent('click', { bubbles: true }));
  await tick();
  check('插件未运行时提示且不打开选择器', !w3.document.querySelector('input[type=file]') && /没有在运行/.test(w3.document.body.textContent));
  w.close(); w3.close();
}

console.log('\n【C】 选 zip → 读取 → 上传（端到端）');
{
  const { w, calls } = makeDom({
    routes: { '/import': { status: 200, json: { code: 0, data: { message: '插件 napcat-plugin-x 已导入并加载成功', pluginId: 'napcat-plugin-x', files: 2, needRestart: false } } } }
  });
  const btn = w.document.querySelector('[data-napcat-importer-btn]');
  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const input = w.document.querySelector('input[type=file]');
  const file = new w.File([Buffer.from('PK\u0003\u0004 fake-zip-bytes')], 'napcat-plugin-x.zip', { type: 'application/zip' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new w.Event('change'));
  await tick(120);
  const up = calls.find(c => /\/import$/.test(c.url));
  check('POST 到了 /api/Plugin/ext/.../import', !!up && up.method === 'POST' && /\/api\/Plugin\/ext\/napcat-plugin-importer\/import$/.test(up.url));
  check('带 Authorization', !!up && up.headers.Authorization === 'Bearer CREDENTIAL-XYZ');
  check('Content-Type 是 JSON', !!up && up.headers['Content-Type'] === 'application/json');
  let parsed = null;
  try { parsed = JSON.parse(up.body); } catch { /* ignore */ }
  check('请求体带 filename', !!parsed && parsed.filename === 'napcat-plugin-x.zip');
  check('请求体把 zip 转成了 base64', !!parsed && typeof parsed.base64 === 'string' && parsed.base64.length > 0);
  check('成功后给出提示', /已导入并加载成功/.test(w.document.body.textContent));
  w.close();
}

console.log('\n【D】 鉴权失败（401）→ 提示输入口令并记住');
{
  const { w, calls } = makeDom({
    credential: '',
    prompt: 'my-access-token',
    routes: { '/import': { status: 401, json: { code: -1, message: 'Unauthorized：需要 WebUI 登录凭证或访问口令' } } }
  });
  const btn0 = w.document.querySelector('[data-napcat-importer-btn]');
  btn0.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick();
  const input = w.document.querySelector('input[type=file]');
  const file = new w.File([Buffer.from('PK\u0003\u0004')], 'p.zip', { type: 'application/zip' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new w.Event('change'));
  await tick(120);
  const up = calls.find(c => /\/import$/.test(c.url));
  check('无凭证时上传头为空的 Bearer（不假装已鉴权）', !!up && up.headers.Authorization === 'Bearer ', JSON.stringify(up && up.headers.Authorization));
  check('401 时弹出口令输入并记下', w.localStorage.getItem('napcat-importer-token') === 'my-access-token', String(w.localStorage.getItem('napcat-importer-token')));
  check('提示用户重试（且不被失败提示盖掉）', /再点一次/.test(w.document.body.textContent), JSON.stringify(w.document.body.textContent.slice(-80)));
  w.close();
}

console.log('\n【E】 SPA 重新渲染后自动补回按钮');
{
  const { w } = makeDom();
  // 模拟 React 重新挂载整个页面：清空 root 再放回同样的结构
  const root = w.document.getElementById('root');
  root.innerHTML = '';
  await tick(400);
  root.innerHTML = `<div class="flex mb-6 items-center gap-4"><h1 class="text-2xl font-bold">插件管理</h1></div>`;
  await tick(400);
  check('DOM 重建后按钮被自动补回（MutationObserver）', !!w.document.querySelector('[data-napcat-importer-btn]'));
  w.close();
}


console.log('\n【F】 接口地址回退（反代只放行 /api 或 /plugin 时）');
{
  const { w, calls } = makeDom({
    routes: {
      '/api/Plugin/ext/': { status: 404, json: { code: -1, message: 'not found' } },
      '/plugin/napcat-plugin-importer/api/list': { status: 200, json: { code: 0, data: { plugins: [] } } }
    }
  });
  const btn = w.document.querySelector('[data-napcat-importer-btn]');
  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(60);
  check('第一个候选 404 时自动回退到 /plugin/... 路径',
    calls.some(c => /^\/api\/Plugin\/ext\//.test(c.url)) && calls.some(c => /^\/plugin\/napcat-plugin-importer\/api\/list$/.test(c.url)),
    calls.map(c => c.url).join(' → '));
  check('回退成功后打开了文件选择器', !!w.document.querySelector('input[type=file]'));
  w.close();
}

console.log('\n【G】 锚点缺失时的右下角兜底按钮');
{
  // 模拟“插件管理页结构变了”的场景：路由是 /webui/plugins，但 DOM 里没有 <h1>插件管理</h1>
  const dom = new JSDOM('<!doctype html><html><body><div id="root"><div class="some-new-layout">插件列表</div></div></body></html>',
    { url: 'http://127.0.0.1:6003/webui/plugins', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.localStorage.setItem('token', JSON.stringify('CRED'));
  w.fetch = async () => ({ status: 200, json: async () => ({ code: 0, data: { plugins: [] } }) });
  w.__napcatImporterFabDelay = 10;   // 测试用：缩短兜底延迟
  w.eval(INJECT_JS);
  await tick(450);                    // 等重试阶梯的第一跳（300ms）
  const fab = w.document.querySelector('[data-napcat-importer-fab]');
  check('锚点缺失时出现右下角悬浮按钮', !!fab);
  check('悬浮按钮文案同样有「导入插件」', !!fab && /导入插件/.test(fab.textContent));
  check('悬浮按钮固定定位在右下角', !!fab && fab.style.position === 'fixed' && fab.style.right === '18px');
  // 锚点出现后：头部按钮补上、悬浮按钮移除
  w.document.querySelector('#root').innerHTML = '<div class="flex mb-6 items-center gap-4"><h1 class="text-2xl font-bold">插件管理</h1></div>';
  await tick(500);
  check('锚点出现后改用页面内按钮', !!w.document.querySelector('[data-napcat-importer-btn]'));
  check('并自动移除悬浮兜底按钮', !w.document.querySelector('[data-napcat-importer-fab]'));
  w.close();

  // 不在插件管理路由时不应出现悬浮按钮
  const dom2 = new JSDOM('<!doctype html><html><body><div id="root">首页</div></body></html>',
    { url: 'http://127.0.0.1:6003/webui/', runScripts: 'outside-only', pretendToBeVisual: true });
  dom2.window.__napcatImporterFabDelay = 10;
  dom2.window.fetch = async () => ({ status: 200, json: async () => ({ code: 0, data: {} }) });
  dom2.window.eval(INJECT_JS);
  await tick(450);
  check('非插件管理页不出现悬浮按钮', !dom2.window.document.querySelector('[data-napcat-importer-fab]'));
  dom2.window.close();
}

console.log(`\n===== DOM 测试结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
