import './style.css';

const api = () => window.go.main.App;

const state = {
  settings: null,
  connections: [],
  mounts: {},
  active: null,
  path: '',
  entries: [],
  editing: null,
  selected: null,
};

let dragName = null;

const app = document.getElementById('app');
let statusEl;
let menuEl;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (n) => {
  if (n == null || n < 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i ? 1 : 0) + ' ' + u[i];
};

function setStatus(text, error = false) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('error', error);
}

let toastTimer;
function toast(text, error = false) {
  let node = document.getElementById('toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'toast';
    document.body.appendChild(node);
  }
  node.className = 'toast' + (error ? ' error' : '');
  node.textContent = text;
  node.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.style.display = 'none'; }, 3200);
}

function notify(text, error = false) {
  setStatus(text, error);
  toast(text, error);
}

function hideMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }

function showMenu(x, y, items) {
  hideMenu();
  menuEl = document.createElement('div');
  menuEl.className = 'menu';
  items.forEach((item) => {
    const node = document.createElement('div');
    node.className = 'menu-item' + (item.danger ? ' danger' : '');
    node.textContent = item.label;
    node.onclick = () => { hideMenu(); item.action(); };
    menuEl.appendChild(node);
  });
  document.body.appendChild(menuEl);
  const rect = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menuEl.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}

document.addEventListener('click', (e) => { if (menuEl && !menuEl.contains(e.target)) hideMenu(); });

function renderShell() {
  app.innerHTML = `
    <header>
      <button id="btn-refresh">刷新</button>
      <button id="btn-mount">挂载</button>
      <button id="btn-unmount">卸载</button>
      <button id="btn-upload">上传</button>
      <button id="btn-import">导入</button>
      <button id="btn-export">导出</button>
      <div class="actions">
        <button id="btn-theme">切换主题</button>
        <button id="btn-about">关于</button>
        <button id="btn-settings">设置</button>
      </div>
    </header>
    <main>
      <aside><div class="list-title">连接</div><div id="connections"></div></aside>
      <section class="files">
        <div class="crumbs" id="crumbs"></div>
        <div id="entries"></div>
      </section>
    </main>
    <footer id="status"></footer>
    <dialog id="edit-dialog">
      <h2 id="edit-title">新建连接</h2>
      <label>名称（内部标识）</label><input id="edit-name" />
      <label>显示名称</label><input id="edit-display" />
      <label>类型</label>
      <select id="edit-type">
        <option value="minio">MinIO / S3 兼容</option>
        <option value="alibaba">阿里云 OSS</option>
        <option value="s3">其他 S3 兼容</option>
        <option value="webdav">WebDAV</option>
        <option value="sftp">SFTP</option>
        <option value="ftp">FTP</option>
      </select>
      <label>端点 / 主机</label><input id="edit-endpoint" />
      <label>账号 / Access Key</label><input id="edit-account" />
      <label>密钥（编辑时留空表示不修改）</label><input id="edit-secret" type="password" />
      <label>区域（可空）</label><input id="edit-region" />
      <div class="footer">
        <button id="edit-cancel">取消</button>
        <button id="edit-save" class="primary">保存</button>
      </div>
    </dialog>
    <dialog id="policy-dialog">
      <h2 id="policy-title">桶策略</h2>
      <label>策略 JSON</label>
      <textarea id="policy-text" rows="16"></textarea>
      <label id="policy-acl"></label>
      <div class="footer">
        <button id="policy-cancel">取消</button>
        <button id="policy-save" class="primary">保存策略</button>
      </div>
    </dialog>
    <dialog id="settings-dialog">
      <h2>设置</h2>
      <label>rclone 配置文件</label><input id="set-config" />
      <label>文件管理器（留空自动探测）</label><input id="set-filemanager" />
      <div class="row">
        <div><label>缓存目录</label><input id="set-cache-dir" /></div>
        <div><label>目录缓存时长</label><input id="set-dir-cache" /></div>
      </div>
      <div class="row">
        <div><label>缓存上限</label><input id="set-cache-size" /></div>
        <div><label>缓存保留时长</label><input id="set-cache-age" /></div>
      </div>
      <label>传输缓冲</label><input id="set-buffer" />
      <div class="footer">
        <button id="settings-cancel">取消</button>
        <button id="settings-save" class="primary">保存</button>
      </div>
    </dialog>
    <dialog id="about-dialog">
      <h2>关于</h2>
      <div id="about-info" class="about-info"></div>
      <div class="footer">
        <button id="about-log">查看日志</button>
        <button id="about-datadir">打开数据目录</button>
        <button id="about-close" class="primary">关闭</button>
      </div>
    </dialog>
    <dialog id="log-dialog">
      <h2>运行日志</h2>
      <textarea id="log-text" rows="20" readonly></textarea>
      <div class="footer"><button id="log-close" class="primary">关闭</button></div>
    </dialog>
  `;
  statusEl = document.getElementById('status');
  document.getElementById('btn-refresh').onclick = refresh;
  document.getElementById('btn-mount').onclick = mountActive;
  document.getElementById('btn-unmount').onclick = unmountActive;
  document.getElementById('btn-upload').onclick = uploadFile;
  document.getElementById('btn-import').onclick = importJson;
  document.getElementById('btn-export').onclick = exportJson;
  document.getElementById('btn-theme').onclick = toggleTheme;
  document.getElementById('btn-about').onclick = openAbout;
  document.getElementById('btn-settings').onclick = openSettings;
  document.getElementById('about-close').onclick = () => document.getElementById('about-dialog').close();
  document.getElementById('about-log').onclick = openLog;
  document.getElementById('about-datadir').onclick = () => api().OpenDataDir().catch((err) => toast('打开失败：' + err, true));
  document.getElementById('log-close').onclick = () => document.getElementById('log-dialog').close();
  document.getElementById('edit-cancel').onclick = () => document.getElementById('edit-dialog').close();
  document.getElementById('edit-save').onclick = saveConnection;
  document.getElementById('policy-cancel').onclick = () => document.getElementById('policy-dialog').close();
  document.getElementById('policy-save').onclick = savePolicy;
  document.getElementById('settings-cancel').onclick = () => document.getElementById('settings-dialog').close();
  document.getElementById('settings-save').onclick = saveSettings;
}

async function boot() {
  renderShell();
  try {
    state.settings = await api().GetSettings();
    applyTheme();
    await refresh();
  } catch (err) { setStatus('启动失败：' + err, true); }
}

function applyTheme() {
  document.body.classList.toggle('dark', state.settings && state.settings.theme === 'dark');
}

async function refresh() {
  try {
    state.connections = (await api().ListConnections()) || [];
    state.mounts = (await api().ListMounts()) || {};
    if (state.active && !state.connections.some((c) => c.name === state.active)) {
      state.active = null; state.path = ''; state.entries = [];
    }
    renderConnections();
    renderEntries();
    setStatus(`共 ${state.connections.length} 个连接`);
  } catch (err) { setStatus('读取连接失败：' + err, true); }
}

function mountDriveOf(remote) {
  return Object.keys(state.mounts).find((d) => state.mounts[d] === remote + ':') || '';
}

function renderConnections() {
  const host = document.getElementById('connections');
  if (!state.connections.length) { host.innerHTML = '<div class="empty">没有连接</div>'; return; }
  host.innerHTML = state.connections.map((c) => {
    const drive = mountDriveOf(c.name);
    const badge = drive
      ? `<span class="badge mounted">${esc(drive)} 已挂载</span>`
      : `<span class="badge">${esc(c.type || '未挂载')}</span>`;
    return `<div class="conn${state.active === c.name ? ' active' : ''}" data-name="${esc(c.name)}">
      <span class="name" title="${esc(c.displayName)}">${esc(c.displayName)}</span>${badge}</div>`;
  }).join('');
  host.querySelectorAll('.conn').forEach((node) => {
    node.onclick = () => selectConnection(node.dataset.name);
    node.draggable = true;
    node.ondragstart = (e) => {
      dragName = node.dataset.name;
      e.dataTransfer.effectAllowed = 'move';
      node.classList.add('dragging');
    };
    node.ondragend = () => node.classList.remove('dragging');
    node.ondragover = (e) => { e.preventDefault(); node.classList.add('drop-target'); };
    node.ondragleave = () => node.classList.remove('drop-target');
    node.ondrop = async (e) => {
      e.preventDefault();
      node.classList.remove('drop-target');
      const from = state.connections.findIndex((x) => x.name === dragName);
      const to = state.connections.findIndex((x) => x.name === node.dataset.name);
      if (from < 0 || to < 0 || from === to) return;
      const list = state.connections.slice();
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      state.connections = list;
      renderConnections();
      try { await api().SaveConnectionOrder(list.map((x) => x.name)); toast('顺序已保存'); }
      catch (err) { toast('保存顺序失败：' + err, true); }
    };
    node.oncontextmenu = (e) => {
      e.preventDefault();
      const name = node.dataset.name;
      selectConnection(name);
      showMenu(e.clientX, e.clientY, [
        { label: '编辑连接…', action: () => openEdit(name) },
        { label: '测试连接', action: () => testConnection(name) },
        { label: '修改名称…', action: () => renameConnection(name) },
        { label: mountDriveOf(name) ? '卸载' : '挂载', action: () => (mountDriveOf(name) ? unmountActive() : mountActive()) },
        { label: '删除连接', danger: true, action: () => deleteConnection(name) },
      ]);
    };
  });
}

async function selectConnection(name) {
  state.active = name; state.path = ''; renderConnections(); await loadEntries();
}

async function loadEntries() {
  if (!state.active) { renderEntries(); return; }
  const remote = state.active + ':' + state.path;
  setStatus('正在读取 ' + remote + ' …');
  try {
    state.entries = (await api().List(remote)) || [];
    renderEntries();
    setStatus(remote + '，' + state.entries.length + ' 项');
  } catch (err) { state.entries = []; renderEntries(); setStatus('读取失败：' + err, true); }
}

function renderEntries() {
  const crumbs = document.getElementById('crumbs');
  if (!state.active) {
    crumbs.innerHTML = '<span>开始使用</span>';
    document.getElementById('entries').innerHTML = `
      <div class="welcome">
        <h2>开始使用</h2>
        <ol>
          <li>点击下方「新建连接」，或直接从左侧选择已有连接。</li>
          <li>双击桶进入目录；右键文件可下载，右键桶可编辑策略。</li>
          <li>点击顶部「挂载」把连接挂成本地盘符，在文件管理器中直接访问。</li>
          <li>用顶部「导入 / 导出」在电脑之间迁移连接信息。</li>
        </ol>
        <button id="welcome-new" class="primary">新建连接</button>
      </div>`;
    document.getElementById('welcome-new').onclick = () => openEdit(null);
    return;
  }
  const parts = state.path ? state.path.split('/').filter(Boolean) : [];
  let trail = `<b>${esc(state.active)}</b>`;
  parts.forEach((p) => { trail += ` / ${esc(p)}`; });
  crumbs.innerHTML = `<a href="#" id="go-up">↑ 上级</a><span>${trail}</span>`;
  document.getElementById('go-up').onclick = (e) => { e.preventDefault(); goUp(); };

  const host = document.getElementById('entries');
  if (!state.entries.length) { host.innerHTML = '<div class="empty">此位置没有对象</div>'; return; }
  const rows = state.entries.map((en) => `<tr class="row ${en.isDir ? 'dir' : 'file'}" data-name="${esc(en.name)}" data-dir="${en.isDir}">
      <td><span class="icon">${en.isDir ? '📁' : '📄'}</span>${esc(en.name)}</td>
      <td class="size">${esc(en.isDir ? '' : fmtSize(en.size))}</td>
      <td class="time">${esc(en.modTime || '')}</td></tr>`).join('');
  host.innerHTML = `<table><thead><tr><th>名称</th><th class="size">大小</th><th class="time">修改时间</th></tr></thead><tbody>${rows}</tbody></table>`;
  host.querySelectorAll('tr.row').forEach((row) => {
    row.onclick = () => {
      host.querySelectorAll('tr.selected').forEach((item) => item.classList.remove('selected'));
      row.classList.add('selected');
      state.selected = { name: row.dataset.name, isDir: row.dataset.dir === 'true' };
    };
    row.ondblclick = () => { if (row.dataset.dir === 'true') enterDir(row.dataset.name); };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      const name = row.dataset.name; const isDir = row.dataset.dir === 'true';
      const items = [];
      if (isDir) items.push({ label: '进入', action: () => enterDir(name) });
      else items.push({ label: '下载…', action: () => downloadEntry(name) });
      if (!state.path && isDir) items.push({ label: '编辑桶策略…', action: () => openPolicy(name) });
      const drive = mountDriveOf(state.active);
      if (drive) items.push({ label: '在文件管理器中打开', action: () => api().OpenFolder(drive + '\\') });
      showMenu(e.clientX, e.clientY, items);
    };
  });
}

function enterDir(name) { state.path = state.path ? state.path + '/' + name : name; loadEntries(); }
function goUp() { const p = state.path.split('/').filter(Boolean); p.pop(); state.path = p.join('/'); loadEntries(); }

async function mountActive() {
  if (!state.active) { setStatus('请先选择连接', true); return; }
  const drives = (await api().FreeDrives()) || [];
  if (!drives.length) { setStatus('没有可用盘符', true); return; }
  const drive = drives[0];
  setStatus('正在挂载 ' + state.active + ' → ' + drive + ' …');
  try { await api().Mount(state.active, drive); await refresh(); notify('已挂载到 ' + drive); }
  catch (err) { setStatus('挂载失败：' + err, true); }
}

async function unmountActive() {
  if (!state.active) { setStatus('请先选择连接', true); return; }
  setStatus('正在卸载 ' + state.active + ' …');
  try { await api().UnmountByRemote(state.active); await refresh(); notify('已卸载 ' + state.active); }
  catch (err) { setStatus('卸载失败：' + err, true); }
}

function openEdit(name) {
  state.editing = name || null;
  document.getElementById('edit-title').textContent = name ? '编辑连接' : '新建连接';
  const fields = { 'edit-name': '', 'edit-display': '', 'edit-endpoint': '', 'edit-account': '', 'edit-secret': '', 'edit-region': '' };
  if (name) {
    api().GetConnection(name).then((def) => {
      document.getElementById('edit-name').value = def.name || '';
      document.getElementById('edit-name').disabled = true;
      document.getElementById('edit-display').value = def.displayName || '';
      document.getElementById('edit-type').value = def.type || 'minio';
      document.getElementById('edit-endpoint').value = def.endpoint || '';
      document.getElementById('edit-account').value = def.account || '';
      document.getElementById('edit-region').value = def.region || '';
    }).catch((err) => setStatus('读取连接失败：' + err, true));
  } else {
    Object.keys(fields).forEach((id) => { document.getElementById(id).value = fields[id]; });
    document.getElementById('edit-name').disabled = false;
    document.getElementById('edit-type').value = 'minio';
  }
  document.getElementById('edit-dialog').showModal();
}

async function saveConnection() {
  const def = {
    name: document.getElementById('edit-name').value.trim(),
    displayName: document.getElementById('edit-display').value.trim(),
    type: document.getElementById('edit-type').value,
    endpoint: document.getElementById('edit-endpoint').value.trim(),
    account: document.getElementById('edit-account').value.trim(),
    secret: document.getElementById('edit-secret').value,
    region: document.getElementById('edit-region').value.trim(),
  };
  try {
    await api().SaveConnection(def, !!state.editing);
    document.getElementById('edit-dialog').close();
    await refresh();
    notify('连接已保存');
  } catch (err) { setStatus('保存失败：' + err, true); }
}

async function deleteConnection(name) {
  if (!confirm('确定删除连接 ' + name + '？')) return;
  try { await api().DeleteConnection(name); await refresh(); notify('已删除'); }
  catch (err) { setStatus('删除失败：' + err, true); }
}

async function renameConnection(name) {
  const next = prompt('新的内部名称', name);
  if (!next || next === name) return;
  try { await api().RenameConnection(name, next.trim()); await refresh(); notify('已改名'); }
  catch (err) { setStatus('改名失败：' + err, true); }
}

async function testConnection(name) {
  setStatus('正在测试 ' + name + ' …');
  try { await api().TestConnection(name); notify('连接正常'); }
  catch (err) { setStatus('连接失败：' + err, true); }
}

async function copySelected() {
  if (!state.selected || state.selected.isDir) { notify('请先选中一个文件', true); return; }
  const remotePath = state.active + ':' + (state.path ? state.path + '/' : '') + state.selected.name;
  setStatus('正在准备复制 ' + state.selected.name + ' …');
  try { const local = await api().CopyRemoteToClipboard(remotePath); notify('已复制到剪贴板：' + local); }
  catch (err) { notify('复制失败：' + err, true); }
}

async function pasteInto() {
  const remoteDir = state.active + ':' + state.path;
  setStatus('正在上传剪贴板文件 …');
  try { const msg = await api().PasteFromClipboard(remoteDir); await loadEntries(); notify(msg); }
  catch (err) { notify('粘贴失败：' + err, true); }
}

document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const key = e.key.toLowerCase();
  if (key === 'c' && state.active) { e.preventDefault(); copySelected(); }
  else if (key === 'v' && state.active) { e.preventDefault(); pasteInto(); }
});

async function downloadEntry(name) {
  const dir = await api().PickFolder();
  if (!dir) return;
  const remotePath = state.active + ':' + (state.path ? state.path + '/' : '') + name;
  setStatus('正在下载 ' + name + ' …');
  try { const local = await api().Download(remotePath, dir); notify('已下载到 ' + local); }
  catch (err) { setStatus('下载失败：' + err, true); }
}

async function uploadFile() {
  if (!state.active) { setStatus('请先选择连接', true); return; }
  const file = await api().PickFile();
  if (!file) return;
  const remoteDir = state.active + ':' + state.path;
  setStatus('正在上传 ' + file + ' …');
  try { await api().Upload(remoteDir, file); await loadEntries(); notify('上传完成'); }
  catch (err) { setStatus('上传失败：' + err, true); }
}

async function openPolicy(bucket) {
  document.getElementById('policy-title').textContent = '桶策略：' + bucket;
  document.getElementById('policy-text').value = '';
  document.getElementById('policy-acl').textContent = '';
  document.getElementById('policy-dialog').showModal();
  try {
    const text = await api().GetPolicy(state.active, bucket);
    document.getElementById('policy-text').value = text || '';
    const acl = await api().GetACL(state.active, bucket);
    document.getElementById('policy-acl').textContent = '所有者：' + (acl.owner || '未知') + '；授权条目：' + (acl.grants ? acl.grants.length : 0);
  } catch (err) { setStatus('读取策略失败：' + err, true); }
}

async function savePolicy() {
  const bucket = document.getElementById('policy-title').textContent.replace('桶策略：', '');
  try {
    await api().PutPolicy(state.active, bucket, document.getElementById('policy-text').value);
    document.getElementById('policy-dialog').close();
    setStatus('策略已保存');
  } catch (err) { setStatus('保存策略失败：' + err, true); }
}

async function exportJson() {
  const path = await api().PickSaveFile('rclone-connections.json');
  if (!path) return;
  const includeSecrets = confirm('是否包含账号与密钥？包含后文件可看到凭证，请妥善保管。');
  try { await api().ExportConnections(path, includeSecrets); notify('已导出到 ' + path); }
  catch (err) { setStatus('导出失败：' + err, true); }
}

async function importJson() {
  const path = await api().PickFile();
  if (!path) return;
  if (!confirm('导入会按名称新增或更新连接。继续？')) return;
  try { const msg = await api().ImportConnections(path); await refresh(); notify(msg); }
  catch (err) { setStatus('导入失败：' + err, true); }
}

async function toggleTheme() {
  state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  try { await api().SaveSettings(state.settings); }
  catch (err) { setStatus('保存主题失败：' + err, true); }
}

async function openAbout() {
  try {
    const info = await api().GetAbout();
    document.getElementById('about-info').innerHTML = `
      <p>程序版本：${esc(info.appVersion)}</p>
      <p>rclone 库版本：${esc(info.rcloneVersion)}</p>
      <p>rclone 配置：${esc(info.configPath)}</p>
      <p>数据目录：${esc(info.dataDir)}</p>
      <p>日志文件：${esc(info.logPath)}</p>`;
    document.getElementById('about-dialog').showModal();
  } catch (err) { toast('读取版本信息失败：' + err, true); }
}

async function openLog() {
  try {
    document.getElementById('log-text').value = (await api().GetLog()) || '暂无日志';
    document.getElementById('log-dialog').showModal();
  } catch (err) { toast('读取日志失败：' + err, true); }
}

function openSettings() {
  const s = state.settings;
  document.getElementById('set-config').value = s.rcloneConfig || '';
  document.getElementById('set-filemanager').value = s.fileManager || '';
  document.getElementById('set-cache-dir').value = s.cacheDirectory || '';
  document.getElementById('set-dir-cache').value = s.dirCacheTime || '';
  document.getElementById('set-cache-size').value = s.vfsCacheMaxSize || '';
  document.getElementById('set-cache-age').value = s.vfsCacheMaxAge || '';
  document.getElementById('set-buffer').value = s.bufferSize || '';
  document.getElementById('settings-dialog').showModal();
}

async function saveSettings() {
  const next = {
    ...state.settings,
    rcloneConfig: document.getElementById('set-config').value.trim(),
    fileManager: document.getElementById('set-filemanager').value.trim(),
    cacheDirectory: document.getElementById('set-cache-dir').value.trim(),
    dirCacheTime: document.getElementById('set-dir-cache').value.trim(),
    vfsCacheMaxSize: document.getElementById('set-cache-size').value.trim(),
    vfsCacheMaxAge: document.getElementById('set-cache-age').value.trim(),
    bufferSize: document.getElementById('set-buffer').value.trim(),
  };
  try { await api().SaveSettings(next); state.settings = next; document.getElementById('settings-dialog').close(); await refresh(); setStatus('设置已保存'); }
  catch (err) { setStatus('保存设置失败：' + err, true); }
}

boot();
