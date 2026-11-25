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
  multi: new Set(),
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
      <button id="btn-new" class="primary">新建</button>
      <button id="btn-refresh">刷新</button>
      <button id="btn-mount">挂载</button>
      <button id="btn-unmount">卸载</button>
      <button id="btn-upload">上传</button>
      <button id="btn-download">下载</button>
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
      <div class="policy-wrap">
        <div class="policy-left">
          <label>声明列表</label>
          <div id="policy-list" class="policy-list"></div>
          <button id="policy-add">+ 添加声明</button>
        </div>
        <div class="policy-right">
          <label>效果</label>
          <select id="pd-effect"><option>Allow</option><option>Deny</option></select>
          <label>被授权者（* 表示所有人，多个用逗号）</label>
          <input id="pd-principal" />
          <label>动作（常用可多选）</label>
          <div id="pd-actions" class="policy-actions"></div>
          <label>其他动作（逗号分隔，可选）</label>
          <input id="pd-extra" />
          <label>资源</label>
          <input id="pd-resource" />
          <button id="pd-apply">应用到当前声明</button>
        </div>
      </div>
      <label>策略 JSON 预览</label>
      <textarea id="policy-text" rows="6" readonly></textarea>
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
      <label>并发传输数（下载/上传同时进行）</label>
      <input id="set-transfers" type="number" min="1" max="16" />
      <div class="footer">
        <button id="settings-cancel">取消</button>
        <button id="settings-save" class="primary">保存</button>
      </div>
    </dialog>
    <dialog id="mount-dialog">
      <h2>挂载连接</h2>
      <label>盘符</label>
      <select id="mount-drive"></select>
      <label>挂载名称（资源管理器中显示的卷标）</label>
      <input id="mount-volume" />
      <div class="footer">
        <button id="mount-cancel">取消</button>
        <button id="mount-ok" class="primary">挂载</button>
      </div>
    </dialog>
    <dialog id="input-dialog">
      <h2 id="input-title">输入</h2>
      <input id="input-value" />
      <div class="footer">
        <button id="input-cancel">取消</button>
        <button id="input-ok" class="primary">确定</button>
      </div>
    </dialog>
    <dialog id="info-dialog">
      <h2>对象属性</h2>
      <div id="info-body" class="about-info"></div>
      <div class="footer"><button id="info-close" class="primary">关闭</button></div>
    </dialog>
    <dialog id="text-dialog">
      <h2 id="text-title">编辑文本</h2>
      <textarea id="text-content" rows="18"></textarea>
      <div class="footer">
        <button id="text-cancel">取消</button>
        <button id="text-save" class="primary">保存</button>
      </div>
    </dialog>
    <dialog id="about-dialog">
      <h2>关于</h2>
      <div id="about-info" class="about-info"></div>
      <div class="footer">
        <button id="about-update">检查更新</button>
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
  document.getElementById('btn-new').onclick = () => openEdit(null);
  document.getElementById('btn-refresh').onclick = refresh;
  document.getElementById('btn-mount').onclick = mountActive;
  document.getElementById('btn-unmount').onclick = unmountActive;
  document.getElementById('btn-upload').onclick = uploadFile;
  document.getElementById('btn-download').onclick = downloadSelected;
  document.getElementById('btn-import').onclick = importJson;
  document.getElementById('btn-export').onclick = exportJson;
  document.getElementById('btn-theme').onclick = toggleTheme;
  document.getElementById('btn-about').onclick = openAbout;
  document.getElementById('btn-settings').onclick = openSettings;
  document.getElementById('about-close').onclick = () => document.getElementById('about-dialog').close();
  document.getElementById('about-update').onclick = checkUpdate;
  document.getElementById('mount-cancel').onclick = () => document.getElementById('mount-dialog').close();
  document.getElementById('mount-ok').onclick = confirmMount;
  document.getElementById('input-cancel').onclick = () => { document.getElementById('input-value').value = ''; document.getElementById('input-dialog').close(); };
  document.getElementById('input-ok').onclick = () => document.getElementById('input-dialog').close();
  document.getElementById('info-close').onclick = () => document.getElementById('info-dialog').close();
  document.getElementById('text-cancel').onclick = () => document.getElementById('text-dialog').close();
  document.getElementById('text-save').onclick = saveText;  document.getElementById('about-log').onclick = openLog;
  document.getElementById('about-datadir').onclick = () => api().OpenDataDir().catch((err) => toast('打开失败：' + err, true));
  document.getElementById('log-close').onclick = () => document.getElementById('log-dialog').close();
  document.getElementById('edit-cancel').onclick = () => document.getElementById('edit-dialog').close();
  document.getElementById('edit-save').onclick = saveConnection;
  document.getElementById('policy-cancel').onclick = () => document.getElementById('policy-dialog').close();
  document.getElementById('policy-save').onclick = savePolicy;
  document.getElementById('policy-add').onclick = addStatement;
  document.getElementById('pd-apply').onclick = applyStatement;
  document.getElementById('settings-cancel').onclick = () => document.getElementById('settings-dialog').close();
  document.getElementById('settings-save').onclick = saveSettings;
}

async function boot() {
  renderShell();
  if (window.runtime && window.runtime.EventsOn) {
    window.runtime.EventsOn('mounts-changed', () => { refresh(); });
  }
  if (window.runtime && window.runtime.OnFileDrop) {
    window.runtime.OnFileDrop((x, y, paths) => { uploadPaths(paths); });
  }
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
  const target = String(remote || '').replace(/:$/, '');
  return Object.keys(state.mounts).find((drive) => String(state.mounts[drive] || '').replace(/:$/, '') === target) || '';
}

function renderConnections() {
  const host = document.getElementById('connections');
  if (!state.connections.length) { host.innerHTML = '<div class="empty">没有连接</div>'; return; }
  host.innerHTML = state.connections.map((c) => {
    const drive = mountDriveOf(c.name);
    const driveBadge = drive ? `<span class="badge mounted">${esc(drive)}</span>` : '';
    return `<div class="conn${state.active === c.name ? ' active' : ''}" data-name="${esc(c.name)}">
      <span class="title"><span class="name" title="${esc(c.displayName)}">${esc(c.displayName)}</span><span class="badge type">${esc(c.type || '')}</span></span>
      ${driveBadge}</div>`;
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
  state.active = name; state.path = ''; state.selected = null; state.multi.clear(); state.entries = [];
  renderConnections(); await loadEntries();
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
  let trail = `<a href="#" data-path="">${esc(state.active)}</a>`;
  parts.forEach((part, index) => {
    const target = parts.slice(0, index + 1).join('/');
    trail += ` / <a href="#" data-path="${esc(target)}">${esc(part)}</a>`;
  });
  const connection = state.connections.find((c) => c.name === state.active);
  const base = connection && connection.endpoint ? connection.endpoint.replace(/\/$/, '') : '';
  const absPath = base ? base + (state.path ? '/' + state.path : '') : '';
  crumbs.innerHTML = `<a href="#" id="go-up">↑ 上级</a><span class="trail">${trail}</span><span class="abs" title="${esc(absPath)}">${esc(absPath)}</span>`;
  document.getElementById('go-up').onclick = (e) => { e.preventDefault(); goUp(); };
  crumbs.querySelectorAll('a[data-path]').forEach((link) => {
    link.onclick = (e) => { e.preventDefault(); state.path = link.dataset.path; state.selected = null; loadEntries(); };
  });
  const absEl = crumbs.querySelector('.abs');
  if (absEl && absPath) {
    absEl.style.cursor = 'pointer';
    absEl.title = '点击复制绝对路径';
    absEl.onclick = () => { api().SetClipboard(absPath); notify('已复制绝对路径：' + absPath); };
  }

  const host = document.getElementById('entries');
  if (!state.entries.length) { host.innerHTML = '<div class="empty">此位置没有对象</div>'; return; }
  const rows = state.entries.map((en) => {
    const ops = en.isDir
      ? '<button data-op="enter" title="进入">📂</button><button data-op="size" title="统计占用">📊</button>'
      : '<button data-op="preview" title="预览">👁</button><button data-op="download" title="下载">⬇</button><button data-op="info" title="属性">ℹ</button><button data-op="link" title="复制下载链接">🔗</button>';
    const cls = en.isDir ? 'dir' : 'file';
    const icon = en.isDir ? '📁' : '📄';
    const size = en.isDir ? '' : fmtSize(en.size);
    return `<tr class="row ${cls}" data-name="${esc(en.name)}" data-dir="${en.isDir}">
      <td><span class="icon">${icon}</span>${esc(en.name)}</td>
      <td class="size">${esc(size)}</td>
      <td class="time">${esc(en.modTime || '')}</td>
      <td class="ops">${ops}</td>
    </tr>`;
  }).join('');
  host.innerHTML = `<table><thead><tr><th>名称</th><th class="size">大小</th><th class="time">修改时间</th><th class="ops">操作</th></tr></thead><tbody>${rows}</tbody></table>`;
  host.querySelectorAll('tr.row').forEach((row) => {
    row.onclick = (e) => {
      const name = row.dataset.name;
      if (e.ctrlKey || e.metaKey) {
        if (state.multi.has(name)) state.multi.delete(name);
        else state.multi.add(name);
      } else {
        state.multi.clear();
        state.multi.add(name);
      }
      host.querySelectorAll('tr.row').forEach((item) => item.classList.toggle('selected', state.multi.has(item.dataset.name)));
      state.selected = state.multi.has(name)
        ? { name, isDir: row.dataset.dir === 'true', path: state.active + ':' + (state.path ? state.path + '/' : '') + name }
        : null;
    };
    row.querySelectorAll('button[data-op]').forEach((button) => {
      button.onclick = (e) => {
        e.stopPropagation();
        const name = row.dataset.name;
        const remotePath = state.active + ':' + (state.path ? state.path + '/' : '') + name;
        const op = button.dataset.op;
        if (op === 'enter') enterDir(name);
        else if (op === 'size') showSize(remotePath);
        else if (op === 'preview') previewEntry(remotePath);
        else if (op === 'download') downloadEntry(name);
        else if (op === 'info') showInfo(remotePath);
        else if (op === 'link') copyLink(remotePath);
      };
    });
    row.ondblclick = () => {
      if (row.dataset.dir === 'true') enterDir(row.dataset.name);
      else downloadEntry(row.dataset.name);
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      const name = row.dataset.name;
      const isDir = row.dataset.dir === 'true';
      const remotePath = state.active + ':' + (state.path ? state.path + '/' : '') + name;
      const items = [];
      if (isDir) {
        items.push({ label: '进入', action: () => enterDir(name) });
        items.push({ label: '统计占用…', action: () => showSize(remotePath) });
        items.push({ label: '下载目录…', action: () => downloadFolder(remotePath) });
        if (!state.path) {
          items.push({ label: '编辑桶策略…', action: () => openPolicy(name) });
          items.push({ label: '新建桶…', action: () => createBucket() });
        }
      } else {
        items.push({ label: '预览', action: () => previewEntry(remotePath) });
        items.push({ label: '下载…', action: () => downloadEntry(name) });
        items.push({ label: '编辑文本…', action: () => editText(remotePath) });
        items.push({ label: '复制下载链接（7 天）', action: () => copyLink(remotePath) });
        items.push({ label: '对象属性…', action: () => showInfo(remotePath) });
        items.push({ label: '设置过期…', action: () => setExpiry(remotePath) });
      }
      items.push({ label: '复制路径', action: () => copyPath(remotePath, true) });
      items.push({ label: '复制 rclone 路径', action: () => copyPath(remotePath, false) });
      items.push({ label: '重命名…', action: () => renameEntry(name, isDir) });
      items.push({ label: '新建目录…', action: () => createDir() });
      items.push({ label: '上传文件夹…', action: () => uploadFolder() });
      const drive = mountDriveOf(state.active);
      if (drive) items.push({ label: '在文件管理器中打开', action: () => api().OpenFolder(drive + '\\' + state.path.replace(/\//g, '\\')) });
      items.push({ label: '删除…', danger: true, action: () => deleteEntry(name, isDir) });
      showMenu(e.clientX, e.clientY, items);
    };
  });
}

function enterDir(name) { state.selected = null; state.multi.clear(); state.path = state.path ? state.path + '/' + name : name; loadEntries(); }
function goUp() { state.selected = null; state.multi.clear(); const p = state.path.split('/').filter(Boolean); p.pop(); state.path = p.join('/'); loadEntries(); }

async function mountActive() {
  if (!state.active) { notify('请先选择连接', true); return; }
  const drives = (await api().FreeDrives()) || [];
  if (!drives.length) { notify('没有可用盘符', true); return; }
  const select = document.getElementById('mount-drive');
  select.innerHTML = drives.map((drive) => `<option value="${esc(drive)}">${esc(drive)}</option>`).join('');
  const connection = state.connections.find((item) => item.name === state.active);
  document.getElementById('mount-volume').value = connection ? connection.displayName : state.active;
  document.getElementById('mount-dialog').showModal();
}

async function confirmMount() {
  const drive = document.getElementById('mount-drive').value;
  const volume = document.getElementById('mount-volume').value.trim();
  if (!drive) return;
  document.getElementById('mount-dialog').close();
  setStatus('正在挂载 ' + state.active + ' → ' + drive + ' …');
  try { await api().Mount(state.active, drive, volume); await refresh(); notify('已挂载到 ' + drive); }
  catch (err) { notify('挂载失败：' + err, true); }
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
  const entry = state.entries.find((item) => item.name === state.selected.name);
  if (entry && entry.size > 200 * 1024 * 1024 && !confirm('文件较大（' + fmtSize(entry.size) + '），复制会先下载到本地缓存，继续？')) return;
  const remotePath = state.selected.path;
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
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if ((e.key === 'Backspace' || e.key === 'Escape') && state.active && state.path) {
    e.preventDefault();
    goUp();
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  const key = e.key.toLowerCase();
  if (key === 'c' && state.active) { e.preventDefault(); copySelected(); }
  else if (key === 'v' && state.active) { e.preventDefault(); pasteInto(); }
});

function askInput(title, value) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('input-dialog');
    document.getElementById('input-title').textContent = title;
    const input = document.getElementById('input-value');
    input.value = value || '';
    dialog.showModal();
    input.focus();
    dialog.addEventListener('close', () => resolve(input.value.trim()), { once: true });
  });
}

async function previewEntry(remotePath) {
  setStatus('正在准备预览…');
  try { const local = await api().PreviewRemote(remotePath); notify('已打开预览：' + local); }
  catch (err) { notify('预览失败：' + err, true); }
}

async function showInfo(remotePath) {
  try {
    const info = await api().ObjectInfo(remotePath);
    document.getElementById('info-body').innerHTML = Object.keys(info).map((key) => `<p>${esc(key)}：${esc(info[key])}</p>`).join('');
    document.getElementById('info-dialog').showModal();
  } catch (err) { notify('读取属性失败：' + err, true); }
}

async function copyPath(remotePath, absolute) {
  let value = remotePath;
  if (absolute) {
    const connection = state.connections.find((c) => c.name === state.active);
    if (connection && connection.endpoint) {
      const rest = remotePath.substring(remotePath.indexOf(':') + 1).replace(/^\//, '');
      value = connection.endpoint.replace(/\/$/, '') + '/' + rest;
    }
  }
  api().SetClipboard(value);
  notify('已复制：' + value);
}

async function copyLink(remotePath) {
  try {
    const link = await api().Presign(remotePath);
    api().SetClipboard(link);
    notify('已复制下载链接（7 天有效）');
  } catch (err) { notify('生成链接失败：' + err, true); }
}

async function showSize(remotePath) {
  setStatus('正在统计…');
  try { const text = await api().Size(remotePath); notify(text); }
  catch (err) { notify('统计失败：' + err, true); }
}

async function createDir() {
  if (!state.active) { notify('请先选择连接', true); return; }
  const name = await askInput('新建目录名称', '');
  if (!name) return;
  const target = state.active + ':' + (state.path ? state.path + '/' : '') + name;
  try { await api().Mkdir(target); await loadEntries(); notify('已创建目录'); }
  catch (err) { notify('创建失败：' + err, true); }
}

async function renameEntry(name) {
  const next = await askInput('新名称', name);
  if (!next || next === name) return;
  const base = state.active + ':' + (state.path ? state.path + '/' : '');
  try { await api().Move(base + name, base + next); await loadEntries(); notify('已重命名'); }
  catch (err) { notify('重命名失败：' + err, true); }
}

async function deleteEntry(name, isDir) {
  if (!window.confirm('确定删除 ' + name + (isDir ? '（目录及其内容）' : '') + '？')) return;
  const target = state.active + ':' + (state.path ? state.path + '/' : '') + name;
  setStatus('正在删除…');
  try { await api().Delete(target, isDir); await loadEntries(); notify('已删除'); }
  catch (err) { notify('删除失败：' + err, true); }
}

async function downloadFolder(remotePath) {
  const dir = await api().PickFolder();
  if (!dir) return;
  setStatus('正在下载目录…');
  try { await api().DownloadFolder(remotePath, dir); notify('目录下载完成'); }
  catch (err) { notify('下载失败：' + err, true); }
}

async function createBucket() {
  const name = await askInput('新桶名称', '');
  if (!name) return;
  try { await api().CreateBucket(state.active, name); await loadEntries(); notify('已创建桶'); }
  catch (err) { notify('创建桶失败：' + err, true); }
}

async function checkUpdate() {
  try {
    const info = await api().CheckUpdate();
    if (!info.hasUpdate) { notify('当前已是最新版（' + info.current + '）'); return; }
    if (!info.url) { notify('发现新版本 ' + info.latest + '，但没有可下载的 exe', true); return; }
    if (!window.confirm('发现新版本 ' + info.latest + '（当前 ' + info.current + '），现在下载并重启更新？')) return;
    notify('正在下载更新，完成后会自动重启…');
    await api().DownloadUpdate(info.url);
  } catch (err) { notify('检查更新失败：' + err, true); }
}

async function uploadFolder() {
  if (!state.active) { notify('请先选择连接', true); return; }
  const dir = await api().PickFolder();
  if (!dir) return;
  const remoteDir = state.active + ':' + state.path;
  setStatus('正在上传目录 ' + dir + ' …');
  try { await api().UploadFolder(remoteDir, dir); await loadEntries(); notify('目录上传完成'); }
  catch (err) { notify('上传失败：' + err, true); }
}

let editingText = null;

async function editText(remotePath) {
  try {
    const file = await api().ReadObjectText(remotePath);
    editingText = { remotePath, localPath: file.localPath };
    document.getElementById('text-title').textContent = '编辑文本：' + remotePath.split('/').pop();
    document.getElementById('text-content').value = file.text;
    document.getElementById('text-dialog').showModal();
  } catch (err) { notify('打开失败：' + err, true); }
}

async function saveText() {
  if (!editingText) return;
  try {
    await api().SaveObjectText(editingText.remotePath, editingText.localPath, document.getElementById('text-content').value);
    document.getElementById('text-dialog').close();
    await loadEntries();
    notify('已保存');
  } catch (err) { notify('保存失败：' + err, true); }
}

async function setExpiry(remotePath) {
  const days = await askInput('过期天数（例如 7）', '7');
  const value = parseInt(days, 10);
  if (!value || value <= 0) return;
  try { await api().SetExpiry(remotePath, value); notify('已设置 ' + value + ' 天过期'); }
  catch (err) { notify('设置过期失败：' + err, true); }
}

async function downloadSelected() {
  if (!state.active) { notify('请先选择连接', true); return; }
  const names = [...state.multi].filter((name) => {
    const entry = state.entries.find((item) => item.name === name);
    return entry && !entry.isDir;
  });
  if (!names.length) { notify('请先选择文件', true); return; }
  const dir = await api().PickFolder();
  if (!dir) return;
  const base = state.active + ':' + (state.path ? state.path + '/' : '');
  const paths = names.map((name) => base + name);
  setStatus('正在下载 ' + paths.length + ' 个文件…');
  try { const message = await api().DownloadBatch(paths, dir); notify(message); }
  catch (err) { notify('下载失败：' + err, true); }
}

async function downloadEntry(name) {
  const dir = await api().PickFolder();
  if (!dir) return;
  const remotePath = state.active + ':' + (state.path ? state.path + '/' : '') + name;
  setStatus('正在下载 ' + name + ' …');
  try { const local = await api().Download(remotePath, dir); notify('已下载到 ' + local); }
  catch (err) { setStatus('下载失败：' + err, true); }
}

async function uploadPaths(paths) {
  if (!state.active) { notify('请先选择连接', true); return; }
  const remoteDir = state.active + ':' + state.path;
  let ok = 0, fail = 0;
  for (const path of paths) {
    try { await api().UploadPath(remoteDir, path); ok++; }
    catch (err) { fail++; }
  }
  await loadEntries();
  notify(`上传完成：成功 ${ok}，失败 ${fail}`, fail > 0);
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

const COMMON_ACTIONS = [
  ['s3:GetObject', '读取对象'],
  ['s3:PutObject', '写入对象'],
  ['s3:DeleteObject', '删除对象'],
  ['s3:ListBucket', '列出桶'],
  ['s3:GetBucketLocation', '获取位置'],
  ['s3:ListBucketMultipartUploads', '列出分片'],
];

const policy = { bucket: '', statements: [], index: -1 };

function principalText(value) {
  if (!value) return '*';
  if (value === '*') return '*';
  if (value.AWS) return Array.isArray(value.AWS) ? value.AWS.join(',') : String(value.AWS);
  return JSON.stringify(value);
}

function parsePolicy(text) {
  try {
    const doc = JSON.parse(text || '{}');
    const list = Array.isArray(doc.Statement) ? doc.Statement : (doc.Statement ? [doc.Statement] : []);
    return list.map((item) => ({
      effect: item.Effect || 'Allow',
      principal: principalText(item.Principal),
      actions: Array.isArray(item.Action) ? item.Action : (item.Action ? [item.Action] : []),
      resource: Array.isArray(item.Resource) ? item.Resource[0] || '' : (item.Resource || ''),
    }));
  } catch (err) {
    return [];
  }
}

function buildPolicy() {
  const statements = policy.statements.map((item) => ({
    Effect: item.effect,
    Principal: item.principal === '*' ? '*' : { AWS: item.principal.split(',').map((x) => x.trim()).filter(Boolean) },
    Action: item.actions,
    Resource: item.resource ? [item.resource] : [],
  }));
  return JSON.stringify({ Version: '2012-10-17', Statement: statements }, null, 2);
}

function renderPolicyActions(selected) {
  const host = document.getElementById('pd-actions');
  host.innerHTML = COMMON_ACTIONS.map(([value, label]) =>
    `<label class="chk"><input type="checkbox" value="${value}" ${selected.includes(value) ? 'checked' : ''}/>${label}</label>`).join('');
}

function renderPolicy() {
  const list = document.getElementById('policy-list');
  list.innerHTML = policy.statements.length
    ? policy.statements.map((item, index) => `<div class="stmt ${index === policy.index ? 'active' : ''}" data-i="${index}">
        <b>${esc(item.effect)}</b> ${esc(item.principal)}
        <small>${esc(item.actions.join(', '))}</small>
        <span class="del" data-del="${index}">✕</span></div>`).join('')
    : '<div class="empty">没有声明</div>';
  list.querySelectorAll('.stmt').forEach((node) => {
    node.onclick = (e) => {
      if (e.target.dataset.del !== undefined) return;
      policy.index = Number(node.dataset.i);
      renderPolicy();
    };
  });
  list.querySelectorAll('.del').forEach((node) => {
    node.onclick = (e) => {
      e.stopPropagation();
      policy.statements.splice(Number(node.dataset.del), 1);
      if (policy.index >= policy.statements.length) policy.index = policy.statements.length - 1;
      renderPolicy();
    };
  });
  const item = policy.statements[policy.index];
  if (item) {
    document.getElementById('pd-effect').value = item.effect;
    document.getElementById('pd-principal').value = item.principal;
    document.getElementById('pd-resource').value = item.resource;
    const extra = item.actions.filter((action) => !COMMON_ACTIONS.some(([value]) => value === action));
    document.getElementById('pd-extra').value = extra.join(',');
    renderPolicyActions(item.actions);
  } else {
    renderPolicyActions([]);
  }
  document.getElementById('policy-text').value = buildPolicy();
}

function addStatement() {
  policy.statements.push({
    effect: 'Allow',
    principal: '*',
    actions: ['s3:GetObject'],
    resource: 'arn:aws:s3:::' + (policy.bucket || 'bucket') + '/*',
  });
  policy.index = policy.statements.length - 1;
  renderPolicy();
}

function applyStatement() {
  if (policy.index < 0 || !policy.statements[policy.index]) { notify('请先添加或选择一条声明', true); return; }
  const actions = Array.from(document.querySelectorAll('#pd-actions input:checked')).map((node) => node.value);
  const extra = document.getElementById('pd-extra').value.split(',').map((x) => x.trim()).filter(Boolean);
  policy.statements[policy.index] = {
    effect: document.getElementById('pd-effect').value,
    principal: document.getElementById('pd-principal').value.trim() || '*',
    actions: Array.from(new Set(actions.concat(extra))),
    resource: document.getElementById('pd-resource').value.trim(),
  };
  renderPolicy();
}

async function openPolicy(bucket) {
  policy.bucket = bucket;
  policy.statements = [];
  policy.index = -1;
  document.getElementById('policy-title').textContent = '桶策略：' + bucket;
  document.getElementById('policy-acl').textContent = '';
  try {
    const text = await api().GetPolicy(state.active, bucket);
    policy.statements = parsePolicy(text);
    if (policy.statements.length) policy.index = 0;
    const acl = await api().GetACL(state.active, bucket);
    document.getElementById('policy-acl').textContent = '所有者：' + (acl.owner || '未知') + '；授权条目：' + (acl.grants ? acl.grants.length : 0);
  } catch (err) { notify('读取策略失败：' + err, true); }
  renderPolicy();
  document.getElementById('policy-dialog').showModal();
}

async function savePolicy() {
  try {
    await api().PutPolicy(state.active, policy.bucket, buildPolicy());
    document.getElementById('policy-dialog').close();
    notify('策略已保存');
  } catch (err) { notify('保存策略失败：' + err, true); }
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
  document.getElementById('set-transfers').value = s.maxConcurrentTransfers || 4;
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
    maxConcurrentTransfers: parseInt(document.getElementById('set-transfers').value, 10) || 4,
  };
  try { await api().SaveSettings(next); state.settings = next; document.getElementById('settings-dialog').close(); await refresh(); setStatus('设置已保存'); }
  catch (err) { setStatus('保存设置失败：' + err, true); }
}

boot();
