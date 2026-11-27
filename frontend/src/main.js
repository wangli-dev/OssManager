import './style.css';

const api = () => window.go.main.App;

const state = {
  settings: null,
  connections: [],
  shares: [],
  mounts: {},
  active: null,
  path: '',
  entries: [],
  editing: null,
  selected: null,
  multi: new Set(),
  local: { path: '', entries: [], drives: [], visible: true },
  filter: '',
  sort: { key: 'name', dir: 1 },
  nameWidth: 320,
  connCollapsed: false,
  view: 'remote',
  localTab: null,
  localView: { path: '', entries: [], error: '' },
  localMulti: new Set(),
  home: '',
  treeVisible: false,
  favorites: [],
  connSelected: '',
};

let dragName = null;
// 应用内拖拽的远程文件列表：支持多选拖到其他页签或此电脑。
let dragRemotePaths = [];
// 应用内拖拽的本地文件列表：支持多选拖到远程页签上传。
let dragLocalPaths = [];
// 从传输记录跳转后，列表加载完成时要选中的文件名。
let pendingSelect = null;
// Shift 连选使用的锚点（远程/本地各一个）。
let multiAnchor = -1;
let localAnchor = -1;

// 远程侧多标签：每个打开的连接保留独立会话（路径、列表、选中、错误、滚动位置）。
const tabCache = {};
const tabOrder = [];
// 「此电脑」页签在完整页签栏中的位置；远程页签单独存放在 tabOrder。
let localTabPos = 0;
// 正在拖动的页签，用于拖动排序。
let tabDragItem = null;

function cacheOf(name) {
  if (!tabCache[name]) {
    tabCache[name] = { path: '', entries: [], selected: null, multi: [], error: null, scrollTop: 0, loaded: false };
    tabOrder.push(name);
  }
  return tabCache[name];
}

function saveActiveTab() {
  if (!state.active) return;
  const c = cacheOf(state.active);
  c.path = state.path;
  c.entries = state.entries;
  c.selected = state.selected;
  c.multi = Array.from(state.multi);
  const el = document.getElementById('entries');
  c.scrollTop = el ? el.scrollTop : 0;
}

function restoreActiveTab() {
  const c = cacheOf(state.active);
  state.path = c.path;
  state.entries = c.entries;
  state.selected = c.selected;
  state.multi = new Set(c.multi);
  if (c.error) showBrowseError(c.error.remote, c.error.err);
  else renderEntries();
  const el = document.getElementById('entries');
  if (el) el.scrollTop = c.scrollTop;
}

const SESSION_KEY = 'ossmanager.session';
const WINDOW_KEY = 'ossmanager.windowSize';
let sessionReady = false;

function saveSession() {
  if (!sessionReady) return;
  try {
    const tabs = tabOrder.map((name) => ({
      name,
      path: name === state.active ? state.path : (cacheOf(name).path || ''),
    }));
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      tabs,
      active: state.active,
      activePath: state.path,
      view: state.view,
      localTab: state.localTab,
      localViewPath: state.localView.path,
      localPos: localTabPos,
    }));
  } catch (err) { /* 存储失败不影响使用 */ }
}

// restoreSession 按上次关闭时的页签与视图恢复；无有效会话时返回 false。
function restoreSession() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (err) { data = null; }
  if (!data) return false;
  (data.tabs || []).forEach((tab) => {
    if (!tab || !tab.name || tabOrder.includes(tab.name)) return;
    if (!state.connections.some((connection) => connection.name === tab.name)) return;
    const cached = cacheOf(tab.name);
    cached.path = tab.path || '';
    cached.loaded = false;
  });
  // 恢复「此电脑」页签在标签栏中的位置；旧会话没有记录时排在远程页签之后。
  if (Number.isInteger(data.localPos)) localTabPos = Math.max(0, Math.min(data.localPos, tabOrder.length));
  else localTabPos = tabOrder.length;
  if (data.localTab && data.localTab.path) {
    const rawLabel = data.localTab.label || '';
    // 旧会话记录的是「本地文件」，统一改名为「此电脑」。
    const label = !rawLabel || rawLabel === '本地文件' ? '此电脑' : rawLabel;
    state.localTab = { path: data.localTab.path, label };
    state.localView = { path: data.localViewPath || data.localTab.path, entries: [], error: '' };
  }
  state.view = data.view === 'local' && state.localTab ? 'local' : 'remote';
  if (state.view === 'remote' && data.active && tabOrder.includes(data.active)) {
    state.active = data.active;
    state.path = data.activePath || '';
  }
  renderTabs();
  renderConnections();
  if (state.view === 'local') { loadLocalView(state.localView.path); return true; }
  if (state.active) { loadEntries(); return true; }
  return false;
}

function restoreWindowSize() {
  try {
    const saved = JSON.parse(localStorage.getItem(WINDOW_KEY) || 'null');
    if (saved && saved.w > 600 && saved.h > 400 && window.runtime && window.runtime.WindowSetSize) {
      window.runtime.WindowSetSize(saved.w, saved.h);
    }
  } catch (err) { /* 忽略 */ }
}

function bindWindowSize() {
  let timer = null;
  window.addEventListener('resize', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const size = window.runtime && window.runtime.WindowGetSize ? await window.runtime.WindowGetSize() : null;
        const w = size ? size.w : window.outerWidth;
        const h = size ? size.h : window.outerHeight;
        localStorage.setItem(WINDOW_KEY, JSON.stringify({ w, h }));
      } catch (err) { /* 忽略 */ }
    }, 500);
  });
}

// fullTabList 返回包含「此电脑」页签在内的完整顺序，用于渲染与拖动排序。
function fullTabList() {
  const list = tabOrder.map((name) => ({ kind: 'remote', name }));
  if (state.localTab) {
    const pos = Math.max(0, Math.min(localTabPos, list.length));
    list.splice(pos, 0, { kind: 'local' });
  }
  return list;
}

// applyTabLayout 把拖动后的完整顺序拆回远程页签数组与此电脑页签位置。
function applyTabLayout(layout) {
  tabOrder.length = 0;
  layout.forEach((item, index) => {
    if (item.kind === 'remote') tabOrder.push(item.name);
    else localTabPos = index;
  });
  renderTabs();
  saveSession();
}

function renderTabs() {
  const host = document.getElementById('tabs');
  if (!host) return;
  let html = fullTabList().map((item) => {
    if (item.kind === 'local') {
      const active = state.view === 'local';
      return `<div class="tab${active ? ' active' : ''}" data-local-tab="1" draggable="true" title="${esc(state.localTab.path)}"><span class="tab-label">${esc(state.localTab.label)}</span><span class="tab-close" data-close-local="1" title="关闭">${ICONS.close}</span></div>`;
    }
    const active = state.view !== 'local' && item.name === state.active;
    const label = connLabel(item.name);
    return `<div class="tab${active ? ' active' : ''}" data-name="${esc(item.name)}" draggable="true" title="${esc(label)}"><span class="tab-label">${esc(label)}</span><span class="tab-close" data-close="${esc(item.name)}" title="关闭">${ICONS.close}</span></div>`;
  }).join('');
  html += '<button id="tab-add" class="tab-add" title="打开连接 / 新建连接">+</button>';
  host.innerHTML = html;
  host.querySelectorAll('.tab').forEach((node) => {
    node.onclick = (e) => {
      if (e.target.dataset && e.target.dataset.closeLocal) { closeLocalTab(); return; }
      if (e.target.dataset && e.target.dataset.close) { closeTab(e.target.dataset.close); return; }
      if (node.dataset.localTab) { activateLocalTab(); return; }
      openTab(node.dataset.name);
    };
    // 拖动页签调整顺序：与拖入文件（上传/复制）互不干扰。
    node.ondragstart = (e) => {
      if (e.target.closest && e.target.closest('.tab-close')) { e.preventDefault(); return; }
      tabDragItem = { kind: node.dataset.localTab ? 'local' : 'remote', name: node.dataset.name || '' };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-oss-tab', '1');
      node.classList.add('dragging');
    };
    node.ondragend = () => {
      tabDragItem = null;
      node.classList.remove('dragging');
      host.querySelectorAll('.tab').forEach((item) => item.classList.remove('drop-target', 'drop-left', 'drop-right'));
    };
    // 拖到页签：远程 → 复制到该页签；本地文件 → 上传到该页签。
    node.ondragover = (e) => {
      if (e.dataTransfer.types.includes('application/x-oss-tab')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = node.getBoundingClientRect();
        node.classList.toggle('drop-left', e.clientX < rect.left + rect.width / 2);
        node.classList.toggle('drop-right', e.clientX >= rect.left + rect.width / 2);
        return;
      }
      const types = e.dataTransfer.types;
      if (types.includes('application/x-oss-remote') || types.includes('application/x-oss-local')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        node.classList.add('drop-target');
      }
    };
    node.ondragleave = () => node.classList.remove('drop-target', 'drop-left', 'drop-right');
    node.ondrop = (e) => {
      if (e.dataTransfer.types.includes('application/x-oss-tab')) {
        e.preventDefault();
        reorderTab(node, e);
        return;
      }
      e.preventDefault();
      node.classList.remove('drop-target');
      handleTabDrop(node, e);
    };
  });
  document.getElementById('tab-add').onclick = (e) => { e.stopPropagation(); openTabAddMenu(e); };
  updateFileActions();
  saveSession();
}

// reorderTab 把正在拖动的页签插入目标页签之前或之后。
function reorderTab(target, event) {
  if (!tabDragItem) return;
  const targetKind = target.dataset.localTab ? 'local' : 'remote';
  if (tabDragItem.kind === targetKind && (targetKind === 'local' || tabDragItem.name === target.dataset.name)) return;
  const layout = fullTabList();
  const from = layout.findIndex((item) => item.kind === tabDragItem.kind
    && (item.kind === 'local' || item.name === tabDragItem.name));
  if (from < 0) return;
  const [moved] = layout.splice(from, 1);
  let to = layout.findIndex((item) => item.kind === (target.dataset.localTab ? 'local' : 'remote')
    && (item.kind === 'local' || item.name === target.dataset.name));
  if (to < 0) to = layout.length;
  else {
    const rect = target.getBoundingClientRect();
    if (event.clientX >= rect.left + rect.width / 2) to += 1;
  }
  layout.splice(to, 0, moved);
  tabDragItem = null;
  applyTabLayout(layout);
}

// 上传/下载属于当前文件列表的操作，放在筛选行右侧；仅远程页签可用。
function updateFileActions() {
  const remote = state.view === 'remote' && !!state.active;
  const upload = document.getElementById('btn-upload');
  const download = document.getElementById('btn-download');
  if (upload) upload.style.display = remote ? '' : 'none';
  if (download) download.style.display = remote ? '' : 'none';
}

// handleTabDrop 处理拖拽到页签：远程文件复制到远程页签或下载到此电脑，本地文件上传到远程页签。
function handleTabDrop(node, event) {
  if (event.dataTransfer.types.includes('application/x-oss-tab')) return;
  const targetName = node.dataset.name || '';
  const isLocalTab = !!node.dataset.localTab;
  const localPath = event.dataTransfer.getData('application/x-oss-local');
  const localPaths = dragLocalPaths.length ? dragLocalPaths.slice() : [localPath].filter(Boolean);
  if (localPaths.length) {
    if (isLocalTab) { notify('此电脑页签之间无需上传', true); return; }
    const targetDir = targetName + ':' + (targetName === state.active ? state.path : (cacheOf(targetName).path || ''));
    uploadPathsTo(localPaths, targetName, targetDir, targetName + ' / ' + (targetDir.split(':')[1] || '/'));
    return;
  }
  const remotePaths = dragRemotePaths.length
    ? dragRemotePaths.slice()
    : [event.dataTransfer.getData('application/x-oss-remote')].filter(Boolean);
  if (!remotePaths.length) return;
  if (isLocalTab) {
    copyRemotePathsToLocal(remotePaths, state.localView.path);
    return;
  }
  if (targetName === state.active) { notify('不能拖到当前页签本身', true); return; }
  const targetDir = targetName + ':' + (cacheOf(targetName).path || '');
  copyRemotePathsTo(remotePaths, targetDir, targetName + ' / ' + (targetDir.split(':')[1] || '/'));
}

// openTabAddMenu 的「此电脑」入口使用统一名称。
function openTabAddMenu(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const items = state.connections.map((conn) => ({
    label: `${conn.displayName || conn.name}（${conn.type || ''}）`,
    action: () => openTab(conn.name),
  }));
  if (items.length) items.push({ separator: true });
  items.push({ label: '此电脑…', action: () => (state.localTab ? activateLocalTab() : openLocalTab(state.home || state.local.path || 'C:\\', '此电脑')) });
  visibleShares().forEach((share) => {
    items.push({ label: `共享：${shareLabel(share)}`, action: () => openLocalTab(share.local || share.remote, shareLabel(share)) });
  });
  items.push({ separator: true });
  items.push({ label: '新建连接…', action: () => openEdit(null) });
  items.push({ label: '添加网络共享…', action: openNetDialog });
  showMenu(rect.left, rect.bottom + 4, items);
}

function openMoreMenu(event) {
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 4, [
    { label: '导入连接…', action: importJson },
    { label: '导出连接…', action: exportJson },
    { separator: true },
    { label: '切换主题', action: toggleTheme },
    { separator: true },
    { label: '关于…', action: openAbout },
    { label: '设置…', action: openSettings },
  ]);
}

function refreshCurrentView() {
  if (state.view === 'local' && state.localTab) {
    loadLocalView(state.localView.path);
    return;
  }
  if (state.active) {
    showBrowseLoading(state.active + ':' + state.path);
    loadEntries();
  }
}

function openTab(name) {
  if (!name) return;
  if (state.active === name) {
    if (state.view !== 'remote') {
      state.view = 'remote';
      restoreActiveTab();
      renderTabs();
      updateFooter();
    } else {
      renderTabs();
    }
    return;
  }
  saveActiveTab();
  clearFilter();
  cancelAutoSize();
  state.view = 'remote';
  state.active = name;
  state.selected = null;
  state.multi.clear();
  const c = cacheOf(name);
  if (!c.loaded && !c.error) {
    // 首次打开：先显示加载中占位，不渲染空的「此位置没有对象」。
    state.path = c.path;
    state.entries = [];
    showBrowseLoading(name + ':' + (c.path || '/'));
  } else {
    restoreActiveTab();
  }
  renderConnections();
  renderTabs();
  toggleConnPopover(false);
  if (c.loaded) updateFooter();
  else loadEntries();
  syncTree();
}

function closeTab(name) {
  const idx = tabOrder.indexOf(name);
  if (state.active === name) cancelAutoSize();
  if (idx >= 0) tabOrder.splice(idx, 1);
  delete tabCache[name];
  if (state.active === name) {
    state.active = null;
    state.path = ''; state.entries = []; state.selected = null; state.multi.clear();
    const next = tabOrder[tabOrder.length - 1];
    if (next) openTab(next);
    else {
      renderTabs();
      renderEntries();
      updateFooter();
      state.connCollapsed = false;
      applyConnCollapsed();
    }
  } else {
    renderTabs();
  }
}

function pruneTabs(aliveNames) {
  for (const name of [...tabOrder]) {
    if (!aliveNames.has(name)) {
      const idx = tabOrder.indexOf(name);
      if (idx >= 0) tabOrder.splice(idx, 1);
      delete tabCache[name];
    }
  }
  renderTabs();
}

const app = document.getElementById('app');
let statusEl;
let menuEl;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 统一线性图标：16px 视口、1.3 描边，按钮与列表共用，避免 emoji 大小不一。
const ICON_ATTR = 'class="svg-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICONS = {
  tree: `<svg ${ICON_ATTR}><path d="M2.6 3.4h3.1M2.6 3.4v9.2M2.6 7.8h3.1M2.6 12.3h3.1"/><rect x="7" y="2" width="6.4" height="2.9" rx=".8"/><rect x="7" y="6.4" width="6.4" height="2.9" rx=".8"/><rect x="7" y="10.8" width="6.4" height="2.9" rx=".8"/></svg>`,
  folder: `<svg ${ICON_ATTR}><path d="M1.9 3.5h4.1l1.5 1.6h6.6v7.4H1.9z"/></svg>`,
  folderOpen: `<svg ${ICON_ATTR}><path d="M1.9 4.6V3.4h4l1.4 1.5h5.9v1.5"/><path d="M1.9 6.4h12.5l-1.3 6.1H3.1z"/></svg>`,
  file: `<svg ${ICON_ATTR}><path d="M4.1 1.9h5l2.8 2.8v9.4H4.1z"/><path d="M9.1 1.9v2.8h2.8"/></svg>`,
  drive: `<svg ${ICON_ATTR}><rect x="1.8" y="4.1" width="12.4" height="7.8" rx="1.4"/><path d="M4.2 9.8h.01M11.7 9.8h.01"/></svg>`,
  up: `<svg ${ICON_ATTR}><path d="M8 12.8V3.4M4.3 7.1 8 3.4l3.7 3.7"/></svg>`,
  refresh: `<svg ${ICON_ATTR}><path d="M12.9 8A4.9 4.9 0 1 1 11.5 4.4"/><path d="M13.1 2.7v3.2H9.9"/></svg>`,
  upload: `<svg ${ICON_ATTR}><path d="M8 11.6V3.2M4.3 6.9 8 3.2l3.7 3.7"/><path d="M2.7 13.5h10.6"/></svg>`,
  download: `<svg ${ICON_ATTR}><path d="M8 3.2v8.4M4.3 8 8 11.6 11.7 8"/><path d="M2.7 13.5h10.6"/></svg>`,
  eye: `<svg ${ICON_ATTR}><path d="M1.7 8S4 4.3 8 4.3 14.3 8 14.3 8 12 11.7 8 11.7 1.7 8 1.7 8z"/><circle cx="8" cy="8" r="1.8"/></svg>`,
  eyeOff: `<svg ${ICON_ATTR}><path d="M6.1 4.6A6.5 6.5 0 0 1 8 4.3c4 0 6.3 3.7 6.3 3.7a11 11 0 0 1-2 2.4M4.1 5.5A11 11 0 0 0 1.7 8S4 11.7 8 11.7c1 0 1.9-.2 2.7-.6"/><path d="M2.5 2.5l11 11"/></svg>`,
  copy: `<svg ${ICON_ATTR}><rect x="5.2" y="5.2" width="8" height="8" rx="1.3"/><path d="M11 5.2V3.7c0-.8-.6-1.4-1.4-1.4H3.7c-.8 0-1.4.6-1.4 1.4v6c0 .8.6 1.4 1.4 1.4H5"/></svg>`,
  info: `<svg ${ICON_ATTR}><circle cx="8" cy="8" r="6"/><path d="M8 7.3v3.5M8 5.1h.01"/></svg>`,
  trash: `<svg ${ICON_ATTR}><path d="M2.6 4.6h10.8M6.2 4.6V2.9h3.6v1.7M4.2 4.6l.6 8.3h6.4l.6-8.3M6.6 7v3.5M9.4 7v3.5"/></svg>`,
  chart: `<svg ${ICON_ATTR}><path d="M2.2 13.2V2.9M2.2 13.2h11.6"/><path d="M5.2 10.9V8.3M8 10.9V5.3M10.8 10.9V6.9"/></svg>`,
  pin: `<svg ${ICON_ATTR}><path d="M8 14s4.1-3.8 4.1-6.9A4.1 4.1 0 0 0 3.9 7.1C3.9 10.2 8 14 8 14z"/><circle cx="8" cy="6.9" r="1.5"/></svg>`,
  star: `<svg ${ICON_ATTR}><path d="M8 2.2l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 10.9l-3.4 1.8.7-3.8L2.5 6.2l3.8-.5z"/></svg>`,
  starFill: `<svg class="svg-icon" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 10.9l-3.4 1.8.7-3.8L2.5 6.2l3.8-.5z"/></svg>`,
  plus: `<svg ${ICON_ATTR}><path d="M8 3.3v9.4M3.3 8h9.4"/></svg>`,
  close: `<svg ${ICON_ATTR}><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>`,
};

// connLabel 返回连接在界面上显示的名称：优先 description，其次内部段名。
function connLabel(name) {
  const conn = state.connections.find((item) => item.name === name);
  return (conn && (conn.displayName || conn.name)) || name;
}

// ===== 文件列表栏：标题、筛选、排序与列宽 =====
const COL_CHECK = 24, COL_SIZE = 80, COL_TIME = 150, COL_OPS = 130, COL_NAME_MIN = 120, COL_NAME_MAX = 900;

function loadNameWidth() {
  const saved = parseInt(localStorage.getItem('ossmanager.nameWidth') || '', 10);
  return saved >= COL_NAME_MIN && saved <= COL_NAME_MAX ? saved : 320;
}

function clearFilter() {
  state.filter = '';
  const input = document.getElementById('filter-input');
  if (input) input.value = '';
}

// 标题栏显示当前标签与路径，关掉全部标签后恢复程序名。
function applyWindowTitle() {
  if (!(window.runtime && window.runtime.WindowSetTitle)) return;
  let title = 'OssManager';
  if (state.view === 'local' && state.localTab) {
    title = `OssManager — ${state.localTab.label} / ${state.localView.path}`;
  } else if (state.active) {
    const label = connLabel(state.active);
    title = state.path ? `OssManager — ${label} / ${state.path}` : `OssManager — ${label}`;
  }
  window.runtime.WindowSetTitle(title);
}

// 目录优先，再按当前列排序；对中文使用本地化比较。
function sortEntries(list) {
  const { key, dir } = state.sort;
  return list.slice().sort((left, right) => {
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
    let result = 0;
    if (key === 'size') result = (left.size || 0) - (right.size || 0);
    else if (key === 'time') result = String(left.modTime || '').localeCompare(String(right.modTime || ''));
    else result = String(left.name).localeCompare(String(right.name), 'zh-CN', { numeric: true, sensitivity: 'base' });
    return result * dir;
  });
}

// 拖动名称列右边缘调整列宽，其余列固定宽度并允许表格横向滚动。
function startNameResize(e) {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const startWidth = loadNameWidth();
  const table = document.querySelector('#entries table');
  const move = (event) => {
    const width = Math.max(COL_NAME_MIN, Math.min(COL_NAME_MAX, startWidth + event.clientX - startX));
    state.nameWidth = width;
    if (!table) return;
    const col = table.querySelector('col');
    if (col) col.style.width = width + 'px';
    table.style.width = `max(100%, ${width + COL_CHECK + COL_SIZE + COL_TIME + COL_OPS}px)`;
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    localStorage.setItem('ossmanager.nameWidth', String(state.nameWidth || startWidth));
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

// 把 rclone/底层错误翻译成人话；匹配不到时返回空串，由界面显示原始错误。
function describeError(raw) {
  const low = String(raw || '').toLowerCase();
  if (/unable to authenticate|permission denied \(publickey|auth fail|ssh: auth|wrong password|bad password/.test(low)) return '认证失败：账号、密码或密钥不正确（SFTP 密钥登录请检查 key_file 路径与格式）';
  if (/dial tcp|connection refused|i\/o timeout|connectex|no route|unreachable|lookup /.test(low)) return '无法连接主机：请检查地址、端口与网络可达性';
  if (/key_file|private key|open .*key|load .*key/.test(low)) return '密钥读取失败：检查密钥文件路径、格式或口令';
  if (/directory not found|no such object|does not exist|isn't a directory|file does not exist/.test(low)) return '路径不存在：远程目录可能已被删除或从未存在';
  if (/couldn't find backend|unknown backend/.test(low)) return '该连接类型未被支持';
  if (/access denied|forbidden|permission denied/.test(low)) return '无访问权限：账号对该目录受限';
  return '';
}
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

let subMenuEl = null;

function closeSubMenu() {
  if (subMenuEl) { subMenuEl.remove(); subMenuEl = null; }
  document.querySelectorAll('.menu-item.open').forEach((node) => node.classList.remove('open'));
}

function hideMenu() {
  closeSubMenu();
  if (menuEl) { menuEl.remove(); menuEl = null; }
}

// menuElement 构建菜单；支持分区标题、分隔符与二级子菜单。
// 子菜单自身不能在自己的菜单项上再次 closeSubMenu，否则鼠标一进入子菜单就会被移除。
function menuElement(items, isSub) {
  const el = document.createElement('div');
  el.className = 'menu';
  items.forEach((item) => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      el.appendChild(sep);
      return;
    }
    if (item.header) {
      const head = document.createElement('div');
      head.className = 'menu-head';
      head.textContent = item.label;
      el.appendChild(head);
      return;
    }
    const node = document.createElement('div');
    node.className = 'menu-item' + (item.danger ? ' danger' : '') + (item.children ? ' has-sub' : '');
    node.textContent = item.label;
    node.onmouseenter = () => {
      if (!isSub) closeSubMenu();
      if (item.children) openSubMenu(node, item.children);
    };
    if (item.children) {
      node.onclick = (e) => { e.stopPropagation(); openSubMenu(node, item.children); };
    } else {
      node.onclick = () => { const action = item.action; hideMenu(); action(); };
    }
    el.appendChild(node);
  });
  return el;
}

function openSubMenu(node, items) {
  closeSubMenu();
  node.classList.add('open');
  subMenuEl = menuElement(items, true);
  document.body.appendChild(subMenuEl);
  const rect = node.getBoundingClientRect();
  const size = subMenuEl.getBoundingClientRect();
  let left = rect.right - 4;
  if (left + size.width > window.innerWidth - 8) left = rect.left - size.width + 4;
  subMenuEl.style.left = Math.max(8, left) + 'px';
  subMenuEl.style.top = Math.min(rect.top - 4, window.innerHeight - size.height - 8) + 'px';
}

function showMenu(x, y, items) {
  hideMenu();
  menuEl = menuElement(items);
  document.body.appendChild(menuEl);
  const rect = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menuEl.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}

document.addEventListener('click', (e) => {
  if (menuEl && !menuEl.contains(e.target) && !(subMenuEl && subMenuEl.contains(e.target))) hideMenu();
  const popover = document.getElementById('conn-popover');
  const button = document.getElementById('conn-quick');
  const handleOpen = document.getElementById('conn-handle-open');
  if (popover && popover.style.display !== 'none' && button
    && !popover.contains(e.target) && !button.contains(e.target) && !(handleOpen && handleOpen.contains(e.target))) {
    popover.style.display = 'none';
  }
});

function renderShell() {
  app.innerHTML = `
    <header>
      <div class="header-side header-left">
        <button id="conn-add" class="primary" title="新建连接">新建连接</button>
        <button id="share-add" title="添加网络共享目录">新建共享</button>
      </div>
      <div class="header-center">
        <button id="conn-quick" class="conn-quick" title="选择连接" style="display:none">选择连接 ▾</button>
      </div>
      <div class="header-right">
        <span id="speed-indicator" class="speed" style="display:none" title="当前上传 / 下载速度"></span>
        <button id="update-install" class="primary update-ready" style="display:none" title="下载完成，重启并安装">重启安装</button>
        <button id="btn-autosize" class="chip" title="自动统计目录占用：关">统计占用</button>
        <button id="btn-transfer" title="传输记录">传输记录</button>
        <button id="btn-more">更多 ▾</button>
      </div>
    </header>
    <main>
      <div id="conn-handle-open" class="conn-handle open" title="展开连接栏" style="display:none">›</div>
      <aside id="conn-pane">
        <div class="list-head"><span class="list-title">连接</span><span class="list-tools-inline"><button id="btn-refresh" title="刷新连接列表">${ICONS.refresh}</button></span></div>
        <div id="connections"></div>
        <div class="fav-head" id="fav-head" style="display:none"><span>收藏</span></div>
        <div id="favorites" style="display:none"></div>
        <div id="conn-handle" class="conn-handle" title="收起连接栏">‹</div>
      </aside>
      <div class="resizer" data-target="conn-pane" title="拖动调整宽度"></div>
      <aside id="tree-pane" style="display:none">
        <div class="list-head"><span class="list-title">目录树</span><span class="list-tools-inline"><button id="tree-refresh" title="刷新目录树">${ICONS.refresh}</button><button id="tree-close" title="关闭目录树">${ICONS.close}</button></span></div>
        <div id="tree-body"></div>
      </aside>
      <section class="files">
        <div class="tabbar">
          <div id="tabs"></div>
          <div class="tab-tools">
            <button id="btn-upload" class="icon-btn" title="上传文件（可多选）">${ICONS.upload}</button>
            <button id="btn-download" class="icon-btn" title="下载选中的文件到默认目录（支持多选）">${ICONS.download}</button>
          </div>
        </div>
        <div class="crumbs" id="crumbs">
          <div class="crumb-nav" id="crumb-nav"></div>
          <input id="filter-input" placeholder="筛选当前目录（名称包含关键字）" />
          <span id="filter-stat"></span>
          <button id="btn-list-refresh" class="icon-btn" title="刷新当前目录">${ICONS.refresh}</button>
        </div>
        <div id="entries"></div>
      </section>
    </main>
    <footer id="status"></footer>
    <div id="conn-popover" class="conn-popover" style="display:none"><div id="conn-popover-body"></div></div>
    <dialog id="edit-dialog">
      <h2 id="edit-title">新建连接</h2>
      <label>名称</label><input id="edit-name" />
      <p class="hint" id="edit-name-hint"></p>
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
      <label>密钥（可点击右侧按钮查看）</label>
      <div class="secret-row">
        <input id="edit-secret" type="password" />
        <button id="edit-secret-eye" type="button" title="显示/隐藏密钥">${ICONS.eye}</button>
      </div>
      <label>区域（可空）</label><input id="edit-region" />
      <h3 class="form-head">挂载</h3>
      <div class="row">
        <div>
          <label>盘符（留空不挂载）</label>
          <select id="edit-drive"><option value="">不挂载</option></select>
        </div>
        <div>
          <label>磁盘名称（默认与名称一致）</label>
          <input id="edit-volume" />
        </div>
      </div>
      <div class="footer">
        <button id="edit-test">测试连接</button>
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
      <div class="row">
        <button id="acl-private">设为私有</button>
        <button id="acl-public-read">设为公共只读</button>
      </div>
      <div class="footer">
        <button id="policy-cancel">取消</button>
        <button id="policy-save" class="primary">保存策略</button>
      </div>
    </dialog>
    <dialog id="settings-dialog" class="settings">
      <h2>设置<button id="settings-x" class="dialog-x" title="关闭">${ICONS.close}</button></h2>
      <h3>启动</h3>
      <label>启动时显示</label>
      <select id="set-startup-view">
        <option value="home">首页</option>
        <option value="last">上次关闭时的画面</option>
      </select>
      <h3>连接与文件</h3>
      <label>连接配置文件</label><input id="set-config" />
      <label>文件管理器（留空自动探测）</label><input id="set-filemanager" />
      <h3>缓存</h3>
      <div class="row">
        <div><label>缓存目录</label><input id="set-cache-dir" /></div>
        <div><label>目录缓存时长</label><input id="set-dir-cache" /></div>
      </div>
      <div class="row">
        <div><label>缓存上限</label><input id="set-cache-size" /></div>
        <div><label>缓存保留时长</label><input id="set-cache-age" /></div>
      </div>
      <label>传输缓冲</label><input id="set-buffer" />
      <h3>传输</h3>
      <div class="row">
        <div><label>并发传输数（同时下载/上传的文件数）</label><input id="set-transfers" type="number" min="1" max="16" /></div>
        <div><label>下载线程数（单文件分片，1 为不分片）</label><input id="set-streams" type="number" min="1" max="16" /></div>
      </div>
      <label>拖拽远程文件时</label>
      <select id="set-drag-mode">
        <option value="panes">在应用内拖到页签（复制 / 上传 / 下载）</option>
        <option value="shell">拖到资源管理器（复制落盘）</option>
      </select>
      <h3>传输与目录统计</h3>
      <label>默认下载目录（留空则每次询问）</label><input id="set-download-dir" placeholder="例如 D:\Downloads" />
      <label class="chk"><input type="checkbox" id="set-autosize" /> 自动统计目录大小</label>
      <div class="row">
        <div><label>打开目录后延迟（秒）</label><input id="set-autosize-delay" type="number" min="0" max="60" /></div>
        <div><label>目录之间间隔（秒）</label><input id="set-autosize-interval" type="number" min="0" max="60" /></div>
      </div>
      <h3>更新</h3>
      <label class="chk"><input type="checkbox" id="set-auto-update" /> 启动后自动检查更新，并在后台下载新版本</label>
      <div class="row">
        <button id="set-check-update">立即检查更新</button>
        <span id="set-update-state" class="hint"></span>
      </div>
      <h3>配置迁移</h3>
      <div class="row">
        <button id="set-export-bundle">导出配置包…</button>
        <button id="set-import-bundle">导入配置包…</button>
      </div>
      <div class="footer">
        <button id="settings-save">保存</button>
        <button id="settings-save-close" class="primary">保存并关闭</button>
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
    <dialog id="share-dialog">
      <h2>修改共享挂载</h2>
      <p id="share-path" class="hint"></p>
      <label>盘符</label>
      <select id="share-drive"></select>
      <label>名称（仅本程序显示）</label>
      <input id="share-name" />
      <div class="footer">
        <button id="share-unmount" class="danger">断开映射</button>
        <button id="share-cancel">取消</button>
        <button id="share-save" class="primary">保存</button>
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
    <dialog id="history-dialog">
      <h2>传输记录 <span id="task-count" class="count"></span><button id="history-x" class="dialog-x" title="关闭">${ICONS.close}</button></h2>
      <div id="download-list" class="history-list"></div>
      <div class="footer">
        <button id="history-clear">清空记录</button>
        <button id="history-close" class="primary">关闭</button>
      </div>
    </dialog>
    <dialog id="export-dialog">
      <h2>导出连接</h2>
      <label class="chk"><input type="checkbox" id="export-secrets" /> 包含账号与密钥（导出文件可看到凭证）</label>
      <label class="chk"><input type="checkbox" id="export-settings" /> 包含程序设置（下载目录、缓存、主题等）</label>
      <label>文件名</label><input id="export-name" />
      <div class="footer">
        <button id="export-cancel">取消</button>
        <button id="export-ok" class="primary">选择位置并导出</button>
      </div>
    </dialog>
    <dialog id="import-dialog">
      <h2>导入连接</h2>
      <p id="import-path" class="hint"></p>
      <label class="chk"><input type="checkbox" id="import-settings" /> 文件包含程序设置时一并恢复</label>
      <p class="hint">导入会按名称新增或更新连接，不会删除现有连接。</p>
      <div class="footer">
        <button id="import-cancel">取消</button>
        <button id="import-ok" class="primary">开始导入</button>
      </div>
    </dialog>
    <dialog id="net-dialog">
      <h2>连接局域网共享</h2>
      <label>共享路径（如 \\\\192.168.1.10\\project）</label><input id="net-path" />
      <label>用户名（留空使用当前登录身份）</label><input id="net-user" />
      <label>密码</label><input id="net-pass" type="password" />
      <div class="footer">
        <button id="net-cancel">取消</button>
        <button id="net-ok" class="primary">连接</button>
      </div>
    </dialog>
    <dialog id="copy-dialog" class="copy">
      <h2><span id="copy-title">复制到</span><button id="copy-x" class="dialog-x" title="关闭">${ICONS.close}</button></h2>
      <label>目标位置</label>
      <select id="copy-target-select"></select>
      <div class="copy-bar">
        <button id="copy-up" class="icon-btn" title="上级目录">${ICONS.up}</button>
        <select id="copy-drive" class="drive-select" style="display:none"></select>
        <span id="copy-path" class="copy-path"></span>
        <button id="copy-new" class="icon-btn" title="新建文件夹">${ICONS.plus}</button>
      </div>
      <div id="copy-list" class="copy-list"></div>
      <p class="hint" id="copy-hint">单击文件夹进入，确认后复制到当前目录。</p>
      <div class="footer">
        <button id="copy-cancel">取消</button>
        <button id="copy-ok" class="primary">复制到此处</button>
      </div>
    </dialog>
    <dialog id="preview-dialog" class="preview">
      <h2><span id="preview-title">预览</span><button id="preview-x" class="dialog-x" title="关闭">${ICONS.close}</button></h2>
      <div id="preview-body" class="preview-body"></div>
      <div class="footer">
        <button id="preview-copy">复制地址</button>
        <button id="preview-system">用系统程序打开</button>
        <button id="preview-close" class="primary">关闭</button>
      </div>
    </dialog>
    <dialog id="confirm-dialog" class="confirm">
      <h2><span id="confirm-title">确认删除</span><button id="confirm-x" class="dialog-x" title="关闭">${ICONS.close}</button></h2>
      <p id="confirm-text" class="confirm-text"></p>
      <label class="chk" id="confirm-check-row"><input type="checkbox" id="confirm-check" /><span id="confirm-check-label"></span></label>
      <div class="footer">
        <button id="confirm-cancel">取消</button>
        <button id="confirm-ok" class="danger-solid">删除</button>
      </div>
    </dialog>
  `;
  statusEl = document.getElementById('status');
  // 状态栏右键可直接复制文本，避免依赖选中文字后再按 Ctrl+C。
  statusEl.oncontextmenu = (event) => {
    event.preventDefault();
    showMenu(event.clientX, event.clientY, [
      { label: '复制状态栏文本', action: () => { api().SetClipboard(statusEl.textContent); notify('状态栏文本已复制'); } },
    ]);
  };
  document.getElementById('conn-add').onclick = (e) => { e.stopPropagation(); openEdit(null); };
  document.getElementById('share-add').onclick = (e) => { e.stopPropagation(); openNetDialog(); };
  document.getElementById('btn-autosize').onclick = toggleAutoSize;
  document.getElementById('btn-transfer').onclick = openHistory;
  document.getElementById('update-install').onclick = installUpdate;
  document.getElementById('tree-close').onclick = () => toggleTree(false);
  document.getElementById('tree-refresh').onclick = () => { tree.key = ''; tree.nodes.clear(); syncTree(); };
  document.getElementById('conn-quick').onclick = (e) => {
    e.stopPropagation();
    toggleConnPopover();
  };
  document.getElementById('conn-handle').onclick = () => toggleConnPane(true);
  document.getElementById('conn-handle-open').onclick = () => toggleConnPane(false);
  document.getElementById('btn-more').onclick = openMoreMenu;
  state.connCollapsed = localStorage.getItem('ossmanager.connCollapsed') === '1';
  applyConnCollapsed();
  document.getElementById('btn-refresh').onclick = refresh;
  document.getElementById('btn-list-refresh').onclick = refreshCurrentView;
  document.getElementById('btn-upload').onclick = uploadFiles;
  document.getElementById('btn-download').onclick = downloadSelected;
  document.getElementById('filter-input').oninput = (e) => {
    state.filter = e.target.value;
    renderEntries();
  };
  bindResizers();
  restorePaneWidths();
  document.getElementById('history-close').onclick = () => document.getElementById('history-dialog').close();
  document.getElementById('history-x').onclick = () => document.getElementById('history-dialog').close();
  document.getElementById('history-dialog').addEventListener('close', () => stopTaskRefresh());
  document.getElementById('history-clear').onclick = clearHistory;
  document.getElementById('export-cancel').onclick = () => document.getElementById('export-dialog').close();
  document.getElementById('export-ok').onclick = confirmExport;
  document.getElementById('import-cancel').onclick = () => document.getElementById('import-dialog').close();
  document.getElementById('import-ok').onclick = confirmImport;
  document.getElementById('net-cancel').onclick = () => document.getElementById('net-dialog').close();
  document.getElementById('net-ok').onclick = confirmNet;
  document.getElementById('about-close').onclick = () => document.getElementById('about-dialog').close();
  document.getElementById('about-update').onclick = () => checkUpdate(false);
  document.getElementById('mount-cancel').onclick = () => document.getElementById('mount-dialog').close();
  document.getElementById('mount-ok').onclick = confirmMount;
  document.getElementById('share-cancel').onclick = () => document.getElementById('share-dialog').close();
  document.getElementById('share-save').onclick = confirmShareEdit;
  document.getElementById('share-unmount').onclick = unmountShareFromDialog;
  document.getElementById('input-cancel').onclick = () => { document.getElementById('input-value').value = ''; document.getElementById('input-dialog').close(); };
  document.getElementById('input-ok').onclick = () => document.getElementById('input-dialog').close();
  document.getElementById('info-close').onclick = () => document.getElementById('info-dialog').close();
  document.getElementById('text-cancel').onclick = () => document.getElementById('text-dialog').close();
  document.getElementById('text-save').onclick = saveText;  document.getElementById('about-log').onclick = openLog;
  document.getElementById('about-datadir').onclick = () => api().OpenDataDir().catch((err) => toast('打开失败：' + err, true));
  document.getElementById('log-close').onclick = () => document.getElementById('log-dialog').close();
  document.getElementById('edit-cancel').onclick = () => document.getElementById('edit-dialog').close();
  document.getElementById('edit-save').onclick = saveConnection;
  document.getElementById('edit-test').onclick = testConnectionInput;
  document.getElementById('edit-secret-eye').onclick = () => {
    const input = document.getElementById('edit-secret');
    const eye = document.getElementById('edit-secret-eye');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.innerHTML = show ? ICONS.eyeOff : ICONS.eye;
  };
  document.getElementById('policy-cancel').onclick = () => document.getElementById('policy-dialog').close();
  document.getElementById('policy-save').onclick = savePolicy;
  document.getElementById('policy-add').onclick = addStatement;
  document.getElementById('acl-private').onclick = () => applyACL('private');
  document.getElementById('acl-public-read').onclick = () => applyACL('public-read');
  document.getElementById('pd-apply').onclick = applyStatement;
  document.getElementById('settings-x').onclick = () => document.getElementById('settings-dialog').close();
  document.getElementById('settings-save').onclick = () => saveSettings(false);
  document.getElementById('settings-save-close').onclick = () => saveSettings(true);
  document.getElementById('confirm-x').onclick = () => finishConfirm(false);
  document.getElementById('confirm-cancel').onclick = () => finishConfirm(false);
  document.getElementById('confirm-ok').onclick = () => finishConfirm(true);
  document.getElementById('confirm-dialog').addEventListener('cancel', (e) => { e.preventDefault(); finishConfirm(false); });
  document.getElementById('set-export-bundle').onclick = exportBundle;
  document.getElementById('set-import-bundle').onclick = importBundle;
  document.getElementById('set-check-update').onclick = () => checkUpdate(false);
  document.getElementById('copy-x').onclick = closeCopyDialog;
  document.getElementById('copy-cancel').onclick = closeCopyDialog;
  document.getElementById('copy-up').onclick = copyUp;
  document.getElementById('copy-new').onclick = createCopyDir;
  document.getElementById('copy-ok').onclick = confirmCopy;
  document.getElementById('copy-dialog').addEventListener('close', () => { copyState = null; });
  document.getElementById('preview-x').onclick = () => document.getElementById('preview-dialog').close();
  document.getElementById('preview-close').onclick = () => document.getElementById('preview-dialog').close();
  document.getElementById('preview-copy').onclick = copyPreviewAddress;
  document.getElementById('preview-system').onclick = openPreviewInSystem;
  document.getElementById('preview-dialog').addEventListener('close', cleanupPreview);
  document.getElementById('settings-dialog').addEventListener('close', () => {
    const stateEl = document.getElementById('set-update-state');
    if (stateEl) stateEl.textContent = '';
  });
}

async function boot() {
  renderShell();
  renderTabs();
  if (window.runtime && window.runtime.EventsOn) {
    window.runtime.EventsOn('mounts-changed', () => { refresh(); });
    window.runtime.EventsOn('update-ready', (version) => {
      refreshUpdateState();
      notify('新版本 ' + (version || '') + ' 已下载，点击右上角「重启安装」完成更新');
    });
  }
  if (window.runtime && window.runtime.OnFileDrop) {
    window.runtime.OnFileDrop((x, y, paths) => { uploadPaths(paths); });
  }
  try {
    state.settings = await api().GetSettings();
    loadFavorites();
    applyTheme();
    await refresh();
    await initLocal();
    state.treeVisible = localStorage.getItem('ossmanager.treeVisible') === '1';
    toggleTree(state.treeVisible);
    restoreWindowSize();
    bindWindowSize();
    // 启动时展示连接列表；之后由用户通过边缘手柄收起。
    state.connCollapsed = false;
    applyConnCollapsed();
    if (state.settings && state.settings.startupView === 'last') restoreSession();
    sessionReady = true;
    saveSession();
    startSpeedPoll();
    await refreshUpdateState();
    // 自动更新只在启动后延迟执行，避免与首次目录加载抢带宽。
    if (state.settings && state.settings.autoUpdate) {
      setTimeout(() => checkUpdate(true), 6000);
    }
  } catch (err) { setStatus('启动失败：' + err, true); }
}

function applyTheme() {
  document.body.classList.toggle('dark', state.settings && state.settings.theme === 'dark');
}

async function refresh() {
  try {
    state.connections = (await api().ListConnections()) || [];
    state.mounts = (await api().ListMounts()) || {};
    try { state.shares = (await api().NetworkShares()) || []; } catch (err) { state.shares = []; }
    if (state.active && !state.connections.some((c) => c.name === state.active)) {
      state.active = null; state.path = ''; state.entries = [];
    }
    pruneTabs(new Set(state.connections.map((c) => c.name)));
    renderConnections();
    renderEntries();
    if (!state.active && state.view !== 'local') setStatus(`共 ${state.connections.length} 个连接`);
  } catch (err) { setStatus('读取连接失败：' + err, true); }
}

function mountDriveOf(remote) {
  const target = String(remote || '').replace(/:$/, '');
  return Object.keys(state.mounts).find((drive) => String(state.mounts[drive] || '').replace(/:$/, '') === target) || '';
}

// visibleShares 过滤掉由 rclone 挂载产生的网络盘，避免与 OSS 连接重复。
function visibleShares() {
  const mounted = new Set(Object.keys(state.mounts).map((drive) => drive.replace(/:$/, '').toUpperCase()));
  return state.shares.filter((share) => {
    const drive = String(share.local || '').replace(/:$/, '').toUpperCase();
    return !drive || !mounted.has(drive);
  });
}

// 网络共享的显示名：默认与本地映射盘一致（共享名 + 盘符），可自定义别名。
function shareAliases() {
  try {
    return JSON.parse(localStorage.getItem('ossmanager.shareNames') || '{}') || {};
  } catch (err) {
    return {};
  }
}

function defaultShareLabel(share) {
  const drive = String(share.local || '').replace(/\\$/, '');
  const custom = String(share.label || '').trim();
  const base = custom || String(share.remote || '').split('\\').filter(Boolean).pop() || share.remote;
  return drive ? `${base} (${drive})` : base;
}

function shareLabel(share) {
  const alias = shareAliases()[share.remote];
  if (alias) return alias;
  return defaultShareLabel(share);
}

async function renameShare(share) {
  const aliases = shareAliases();
  const next = await askInput('共享显示名称（仅本程序显示）', aliases[share.remote] || defaultShareLabel(share));
  if (!next) return;
  if (next === defaultShareLabel(share)) delete aliases[share.remote];
  else aliases[share.remote] = next;
  localStorage.setItem('ossmanager.shareNames', JSON.stringify(aliases));
  if (state.localTab && (state.localTab.path === share.local || state.localTab.path === share.remote)) {
    state.localTab.label = shareLabel(share);
  }
  renderTabs();
  renderConnections();
}

// ===== 目录收藏：保存常用远程/本地目录，显示在连接栏底部 =====
const FAV_KEY = 'ossmanager.favorites';

function loadFavorites() {
  try {
    const list = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    state.favorites = Array.isArray(list) ? list.filter((item) => item && item.path !== undefined && (item.kind === 'local' || item.kind === 'remote')) : [];
  } catch (err) { state.favorites = []; }
  state.favorites.forEach((item) => {
    if (!item.id) item.id = 'f' + Math.random().toString(36).slice(2, 10);
  });
}

function saveFavorites() {
  localStorage.setItem(FAV_KEY, JSON.stringify(state.favorites));
}

function favoriteKey(item) {
  return item.kind === 'local'
    ? 'local|' + String(item.path || '').toLowerCase()
    : 'remote|' + String(item.name || '').toLowerCase() + '|' + String(item.path || '');
}

function favoriteLabel(item) {
  if (item.kind === 'local') return item.path || '此电脑';
  const label = connLabel(item.name);
  return item.path ? `${label} / ${item.path}` : label;
}

function isFavorite(item) {
  const key = favoriteKey(item);
  return state.favorites.some((fav) => favoriteKey(fav) === key);
}

function currentFavoriteItem() {
  if (state.view === 'local' && state.localTab) {
    return { kind: 'local', path: state.localView.path || '' };
  }
  if (state.active) {
    return { kind: 'remote', name: state.active, path: state.path || '' };
  }
  return null;
}

function updateFavoriteButton() {
  const button = document.getElementById('btn-fav');
  if (!button) return;
  const item = currentFavoriteItem();
  const on = !!item && isFavorite(item);
  button.classList.toggle('active', on);
  button.innerHTML = on ? ICONS.starFill : ICONS.star;
  button.title = on ? '取消收藏当前目录' : '收藏当前目录';
}

function toggleFavorite() {
  const item = currentFavoriteItem();
  if (!item) { notify('请先打开一个目录', true); return; }
  toggleFavoriteOf(item);
}

function toggleFavoriteOf(item) {
  const key = favoriteKey(item);
  const index = state.favorites.findIndex((fav) => favoriteKey(fav) === key);
  if (index >= 0) {
    state.favorites.splice(index, 1);
    notify('已取消收藏：' + favoriteLabel(item));
  } else {
    state.favorites.unshift({ ...item, id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) });
    notify('已收藏：' + favoriteLabel(item));
  }
  saveFavorites();
  renderFavorites();
  updateFavoriteButton();
}

function removeFavoriteById(id) {
  const index = state.favorites.findIndex((fav) => fav.id === id);
  if (index < 0) return;
  const [removed] = state.favorites.splice(index, 1);
  saveFavorites();
  renderFavorites();
  updateFavoriteButton();
  notify('已移除收藏：' + favoriteLabel(removed));
}

function openFavorite(item) {
  if (item.kind === 'local') {
    if (state.localTab) {
      state.view = 'local';
      renderTabs();
      loadLocalView(item.path);
    } else {
      openLocalTab(item.path, '此电脑');
    }
    return;
  }
  if (!state.connections.some((connection) => connection.name === item.name)) {
    notify('连接已不存在：' + item.name, true);
    return;
  }
  if (state.active !== item.name) openTab(item.name);
  else state.view = 'remote';
  navigateRemote(item.path || '');
}

function renderFavorites() {
  const host = document.getElementById('favorites');
  const head = document.getElementById('fav-head');
  if (!host || !head) return;
  const visible = state.favorites.filter((item) => item.kind === 'local'
    || state.connections.some((connection) => connection.name === item.name));
  if (!visible.length) {
    head.style.display = 'none';
    host.style.display = 'none';
    host.innerHTML = '';
    return;
  }
  head.style.display = 'flex';
  host.style.display = '';
  host.innerHTML = visible.map((item) => `<div class="fav" data-fav="${esc(item.id)}" title="${esc(favoriteLabel(item))}">
      <span class="fav-star">${ICONS.starFill}</span>
      <span class="fav-name">${esc(favoriteLabel(item))}</span>
      <button class="fav-remove" data-remove="${esc(item.id)}" title="移除收藏">${ICONS.close}</button>
    </div>`).join('');
  host.querySelectorAll('.fav').forEach((row) => {
    const item = visible.find((fav) => fav.id === row.dataset.fav);
    if (!item) return;
    row.onclick = (e) => { if (e.target.closest('.fav-remove')) return; openFavorite(item); };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: '打开', action: () => openFavorite(item) },
        { label: '复制路径', action: () => {
          const value = item.kind === 'local' ? item.path : item.name + ':' + (item.path || '');
          api().SetClipboard(value);
          notify('已复制：' + value);
        } },
        { separator: true },
        { label: '移除收藏', danger: true, action: () => removeFavoriteById(item.id) },
      ]);
    };
    const remove = row.querySelector('.fav-remove');
    if (remove) remove.onclick = (e) => { e.stopPropagation(); removeFavoriteById(item.id); };
  });
}

function connectionListHTML() {
  const localPath = state.localTab ? state.localTab.path : (state.local.path || '');
  const localRows = `<div class="conn local-entry${state.connSelected === 'local' ? ' selected' : ''}" data-local="1" data-conn-key="local" title="双击打开此电脑">
      <span class="title"><span class="name">此电脑</span><span class="badge type">本地</span></span>
      <span class="badge">${esc(localPath)}</span></div>`
    + visibleShares().map((share) => `<div class="conn local-entry${state.connSelected === 'share:' + share.remote ? ' selected' : ''}" data-share="${esc(share.remote)}" data-conn-key="share:${esc(share.remote)}" title="双击打开 ${esc(share.remote)}">
      <span class="title"><span class="name">${esc(shareLabel(share))}</span><span class="badge type">网络</span></span>
      ${share.local ? `<span class="badge">${esc(share.local.replace(/\\$/, ''))}</span>` : ''}</div>`).join('');
  const connections = state.connections.map((c) => {
    const drive = mountDriveOf(c.name);
    const driveBadge = drive ? `<span class="badge mounted">${esc(drive)}</span>` : '';
    const active = state.view === 'remote' && state.active === c.name;
    const selected = state.connSelected === 'remote:' + c.name;
    return `<div class="conn${active ? ' active' : ''}${selected ? ' selected' : ''}" data-name="${esc(c.name)}" data-conn-key="remote:${esc(c.name)}" title="双击打开 ${esc(c.displayName || c.name)}">
      <span class="title"><span class="name" title="${esc(c.displayName || c.name)}">${esc(c.displayName || c.name)}</span><span class="badge type">${esc(c.type || '')}</span></span>
      ${driveBadge}</div>`;
  }).join('');
  return localRows + '<div class="conn-sep"></div>' + (connections || '<div class="empty">没有连接</div>');
}

// selectConnEntry 单击只选中，避免误触打开页签；双击才打开。
function selectConnEntry(key) {
  state.connSelected = key || '';
  document.querySelectorAll('#connections .conn, #conn-popover-body .conn').forEach((node) => {
    node.classList.toggle('selected', node.dataset.connKey === state.connSelected);
  });
}

function bindConnectionList(host) {
  host.querySelectorAll('.conn.local-entry').forEach((node) => {
    node.onclick = () => selectConnEntry(node.dataset.connKey);
    node.ondblclick = () => openLocalEntry(node);
    node.oncontextmenu = (e) => {
      const remote = node.dataset.share;
      e.preventDefault();
      selectConnEntry(node.dataset.connKey);
      if (!remote) {
        showMenu(e.clientX, e.clientY, [
          { label: '打开此电脑', action: () => openLocalEntry(node) },
          { separator: true },
          { label: '刷新映射', action: refresh },
        ]);
        return;
      }
      const share = state.shares.find((item) => item.remote === remote) || { remote, local: '' };
      showMenu(e.clientX, e.clientY, [
        { label: '打开', action: () => openLocalEntry(node) },
        { label: '修改挂载…', action: () => openShareEdit(share) },
        { label: '断开映射', danger: true, action: () => unmountShare(share) },
        { separator: true },
        { label: '在资源管理器中打开', action: () => api().OpenFolder(share.local || share.remote).catch((err) => notify('打开失败：' + err, true)) },
        { label: '复制路径', action: () => { api().SetClipboard(share.remote); notify('已复制：' + share.remote); } },
        { separator: true },
        { label: '刷新映射', action: refresh },
      ]);
    };
  });
  host.querySelectorAll('.conn[data-name]').forEach((node) => {
    node.onclick = () => selectConnEntry(node.dataset.connKey);
    node.ondblclick = () => selectConnection(node.dataset.name);
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
      selectConnEntry(node.dataset.connKey);
      showMenu(e.clientX, e.clientY, [
        { label: '编辑连接…', action: () => openEdit(name) },
        { label: '测试连接', action: () => testConnection(name) },
        { label: '修改名称…', action: () => renameConnection(name) },
        { separator: true },
        { label: mountDriveOf(name) ? '卸载' : '挂载', action: () => (mountDriveOf(name) ? unmountRemote(name) : mountRemote(name)) },
        { separator: true },
        { label: '删除连接', danger: true, action: () => deleteConnection(name) },
      ]);
    };
  });
}

function renderConnections() {
  const host = document.getElementById('connections');
  host.innerHTML = connectionListHTML();
  bindConnectionList(host);
  renderFavorites();
  renderConnQuick();
  if (document.getElementById('conn-popover').style.display !== 'none') refreshConnPopover();
}

// 收起连接栏后，顶部才显示连接选择框与展开按钮；展开时隐藏，避免与连接栏重复。
function renderConnQuick() {
  const button = document.getElementById('conn-quick');
  if (!button) return;
  if (state.view === 'local' && state.localTab) {
    button.textContent = `${state.localTab.label} ▾`;
    return;
  }
  button.textContent = state.active ? `${connLabel(state.active)} ▾` : '选择连接 ▾';
}

function refreshConnPopover() {
  const body = document.getElementById('conn-popover-body');
  if (!body) return;
  body.innerHTML = connectionListHTML();
  bindConnectionList(body);
}

function toggleConnPopover(force) {
  const popover = document.getElementById('conn-popover');
  const button = document.getElementById('conn-quick');
  if (!popover || !button) return;
  const open = force === undefined ? popover.style.display === 'none' : force;
  if (!open) { popover.style.display = 'none'; return; }
  refreshConnPopover();
  popover.style.display = 'block';
  const rect = button.getBoundingClientRect();
  const width = popover.offsetWidth;
  popover.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';
  popover.style.top = (rect.bottom + 4) + 'px';
}

function toggleConnPane(collapsed) {
  state.connCollapsed = collapsed;
  applyConnCollapsed();
}

function applyConnCollapsed() {
  const collapsed = !!state.connCollapsed;
  const pane = document.getElementById('conn-pane');
  const bar = document.querySelector('.resizer[data-target="conn-pane"]');
  const handleOpen = document.getElementById('conn-handle-open');
  const quick = document.getElementById('conn-quick');
  if (pane) pane.style.display = collapsed ? 'none' : '';
  // 收起后连拖动调整宽度的竖条也要隐藏；展开手柄保留在左边缘。
  if (bar) bar.style.display = collapsed ? 'none' : '';
  if (handleOpen) handleOpen.style.display = collapsed ? '' : 'none';
  if (quick) quick.style.display = collapsed ? '' : 'none';
  if (collapsed) toggleConnPopover(false);
  localStorage.setItem('ossmanager.connCollapsed', collapsed ? '1' : '0');
  renderConnQuick();
}

async function selectConnection(name) {
  openTab(name);
}

// openLocalEntry 从连接列表把本地文件或网络共享作为页签打开。
function openLocalEntry(node) {
  const share = node.dataset.share;
  toggleConnPopover(false);
  if (share) {
    const mapped = state.shares.find((item) => item.remote === share);
    const target = mapped || { remote: share, local: '' };
    const path = (mapped && mapped.local) || share;
    // 已经打开同一个位置时直接切回，保留原来的目录。
    if (state.localTab && state.localTab.path === path) activateLocalTab();
    else openLocalTab(path, shareLabel(target));
    return;
  }
  // 「此电脑」页签已打开时切换回去，不重置之前浏览的目录。
  if (state.localTab) { activateLocalTab(); return; }
  openLocalTab(state.home || state.local.drives[0]?.root || 'C:\\', '此电脑');
}

// openLocalTab 打开本地目录页签；与远程页签共用标签栏与文件区。
function openLocalTab(path, label) {
  saveActiveTab();
  cancelAutoSize();
  if (!state.localTab) localTabPos = tabOrder.length;
  state.localTab = { path, label };
  state.view = 'local';
  state.selected = null;
  state.multi.clear();
  state.localView = { path, entries: [], error: '' };
  clearFilter();
  renderTabs();
  renderConnections();
  showBrowseLoading(path);
  loadLocalView(path);
}

function activateLocalTab() {
  if (!state.localTab) return;
  if (state.view !== 'local') { saveActiveTab(); state.view = 'local'; }
  clearFilter();
  renderTabs();
  renderConnections();
  loadLocalView(state.localTab.path);
}

function closeLocalTab() {
  state.localTab = null;
  state.view = 'remote';
  renderTabs();
  renderConnections();
  if (state.active) restoreActiveTab();
  else {
    renderEntries();
    state.connCollapsed = false;
    applyConnCollapsed();
  }
}

async function loadLocalView(path) {
  state.localView.path = path;
  state.localMulti.clear();
  // 记录到当前本地页签，切换页签往返时回到这里，而不是最初打开的目录。
  if (state.localTab) state.localTab.path = path;
  if (state.view === 'local') renderTabs();
  setStatus('正在读取 ' + path + ' …');
  try {
    state.localView.entries = (await api().ListLocal(path)) || [];
    state.localView.error = '';
  } catch (err) {
    state.localView.entries = [];
    state.localView.error = String(err);
  }
  if (state.view === 'local') renderEntries();
  saveSession();
  syncTree();
}

function localViewUp() {
  const value = String(state.localView.path || '').replace(/[\\/]+$/, '');
  const index = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
  if (index <= 2) { loadLocalView(value.slice(0, 3)); return; }
  loadLocalView(value.slice(0, index));
}

// renderLocalView 把本地目录以与远程列表一致的表格形式渲染到文件区。
function renderLocalView() {
  const crumbs = document.getElementById('crumbs');
  crumbs.style.display = 'flex';
  updateAutoSizeButton();
  applyWindowTitle();
  renderLocalCrumbs();

  const host = document.getElementById('entries');
  // 双击空白处返回上一级。
  host.ondblclick = (e) => { if (e.target.closest && e.target.closest('tr.row')) return; localViewUp(); };
  const stat = document.getElementById('filter-stat');
  if (state.localView.error) {
    if (stat) stat.textContent = '';
    host.innerHTML = `<div class="browse-error"><div class="be-title">读取 ${esc(state.localView.path)} 失败</div><div class="be-detail">${esc(state.localView.error)}</div></div>`;
    setStatus('本地目录读取失败：' + state.localView.error, true);
    return;
  }
  const keyword = state.filter.trim().toLowerCase();
  const entries = state.localView.entries;
  const visible = entries.filter((entry) => !keyword || String(entry.name).toLowerCase().includes(keyword));
  if (stat) stat.textContent = keyword ? `筛选 ${visible.length} / 共 ${entries.length} 项` : '';
  const nameWidth = loadNameWidth();
  const totalWidth = nameWidth + COL_CHECK + COL_SIZE + COL_TIME + COL_OPS;
  const rows = visible.map((entry, index) => {
    const full = joinLocal(state.localView.path, entry.name);
    const icon = entry.isDir ? ICONS.folder : ICONS.file;
    const cls = entry.isDir ? 'dir' : 'file';
    const checked = state.localMulti.has(full);
    const size = entry.isDir ? '' : fmtSize(entry.size);
    return `<tr class="row ${cls}${checked ? ' selected' : ''}" data-full="${esc(full)}" data-select-key="${esc(full)}" data-name="${esc(entry.name)}" data-dir="${entry.isDir}" data-size="${entry.size || 0}" data-time="${esc(entry.modTime || '')}">
      <td class="check"><input type="checkbox" id="local-check-${index}" data-check="${esc(full)}"${checked ? ' checked' : ''} /></td>
      <td class="name"><span class="icon">${icon}</span>${esc(entry.name)}</td>
      <td class="size">${esc(size)}</td>
      <td class="time">${esc(entry.modTime || '')}</td>
      <td class="ops"><button id="local-upload-${index}" data-local-op="copy" title="复制到…">${ICONS.copy}</button><button id="local-open-${index}" data-local-op="open" title="在资源管理器中打开">${ICONS.folderOpen}</button></td>
    </tr>`;
  }).join('');
  const body = rows || `<tr><td colspan="5" class="empty">${keyword ? '没有匹配的条目' : '空目录'}</td></tr>`;
  host.innerHTML = `<table style="width:max(100%, ${totalWidth}px)">
    <colgroup><col style="width:${COL_CHECK}px"><col style="width:${nameWidth}px"><col style="width:${COL_SIZE}px"><col style="width:${COL_TIME}px"><col style="width:${COL_OPS}px"></colgroup>
    <thead><tr><th class="check"><input type="checkbox" id="local-select-all" title="全选当前列表" /></th><th class="name">名称</th><th class="size">大小</th><th class="time">修改时间</th><th class="ops">操作</th></tr></thead>
    <tbody>${body}</tbody></table>`;
  const selectAll = document.getElementById('local-select-all');
  if (selectAll) {
    selectAll.onchange = () => {
      const rows = Array.from(host.querySelectorAll('tr.row'));
      if (selectAll.checked) rows.forEach((item) => state.localMulti.add(item.dataset.full));
      else state.localMulti.clear();
      syncCheckboxes(host, state.localMulti, 'local-select-all');
    };
  }
  host.querySelectorAll('tr.row').forEach((row) => {
    const full = row.dataset.full;
    const isDir = row.dataset.dir === 'true';
    row.draggable = true;
    row.ondragstart = (e) => {
      const picked = state.localMulti.size > 1 && state.localMulti.has(full)
        ? Array.from(state.localMulti)
        : [full];
      dragLocalPaths = picked;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/x-oss-local', full);
    };
    row.ondragend = () => { dragLocalPaths = []; };
    const checkbox = row.querySelector('input[data-check]');
    if (checkbox) {
      checkbox.onclick = (e) => {
        e.stopPropagation();
        if (checkbox.checked) state.localMulti.add(full);
        else state.localMulti.delete(full);
        localAnchor = Array.from(host.querySelectorAll('tr.row')).indexOf(row);
        syncCheckboxes(host, state.localMulti, 'local-select-all');
      };
    }
    row.onclick = (e) => {
      const rows = Array.from(host.querySelectorAll('tr.row'));
      const index = rows.indexOf(row);
      if (e.shiftKey) {
        const anchor = localAnchor >= 0 && localAnchor < rows.length ? localAnchor : index;
        const from = Math.min(anchor, index);
        const to = Math.max(anchor, index);
        if (!e.ctrlKey && !e.metaKey) state.localMulti.clear();
        for (let i = from; i <= to; i++) state.localMulti.add(rows[i].dataset.full);
      } else {
        if (state.localMulti.has(full)) state.localMulti.delete(full);
        else state.localMulti.add(full);
        localAnchor = index;
      }
      syncCheckboxes(host, state.localMulti, 'local-select-all');
      const kind = isDir ? '目录' : `文件 ${fmtSize(Number(row.dataset.size || 0))}`;
      setStatus(`此电脑 · ${full} · ${kind} · 修改时间 ${row.dataset.time || '未知'}`);
    };
    row.ondblclick = () => { if (isDir) loadLocalView(full); else api().OpenFolder(full).catch(() => {}); };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        ...(isDir ? [{ label: '进入', action: () => loadLocalView(full) }] : []),
        { label: '复制到', children: copyTargetItems(localCopySource(full)) },
        { separator: true },
        { label: '复制路径', action: () => { api().SetClipboard(full); notify('已复制：' + full); } },
        { label: '在资源管理器中打开', action: () => api().OpenFolder(isDir ? full : dirOf(full)).catch((err) => notify('打开失败：' + err, true)) },
      ]);
    };
    row.querySelectorAll('button[data-local-op]').forEach((button) => {
      button.onclick = (e) => {
        e.stopPropagation();
        if (button.dataset.localOp === 'copy') openCopyMenu(button, localCopySource(full));
        else api().OpenFolder(isDir ? full : dirOf(full)).catch((err) => notify('打开失败：' + err, true));
      };
    });
  });
  const files = entries.filter((entry) => !entry.isDir);
  const total = files.reduce((sum, entry) => sum + (entry.size || 0), 0);
  syncCheckboxes(host, state.localMulti, 'local-select-all');
  setStatus(`${state.localView.path} · ${entries.length} 项（文件 ${files.length}，目录 ${entries.length - files.length}）· ${fmtSize(total)}`);
}

// 首次打开标签时在列表区显示加载中占位，避免误显示「此位置没有对象」。
function showBrowseLoading(remote) {
  const host = document.getElementById('entries');
  if (!host) return;
  host.innerHTML = `
    <div class="browse-loading">
      <div class="spinner"></div>
      <div>正在加载 ${esc(remote)} …</div>
    </div>`;
}

// 在文件列表区渲染错误卡片：友好分类 + 原始错误 + 重试按钮。
function showBrowseError(remote, err) {
  const host = document.getElementById('entries');
  if (!host) return;
  const hint = describeError(err);
  host.innerHTML = `
    <div class="browse-error">
      <div class="be-title">读取 ${esc(remote)} 失败</div>
      ${hint ? `<div class="be-hint">${esc(hint)}</div>` : ''}
      <div class="be-detail">${esc(String(err))}</div>
      <button class="primary" id="be-retry">重试</button>
    </div>`;
  document.getElementById('be-retry').onclick = loadEntries;
}

let browseSeq = 0;

async function loadEntries() {
  if (!state.active) { renderEntries(); return; }
  // 竞态防护：快速切换连接时，慢连接的迟到响应不得污染当前连接的视图。
  const seq = ++browseSeq;
  const reqName = state.active;
  const reqPath = state.path;
  const remote = reqName + ':' + reqPath;
  setStatus('正在读取 ' + remote + ' …');
  try {
    const entries = (await api().List(remote)) || [];
    if (seq !== browseSeq || state.active !== reqName) return;
    state.entries = entries;
    const c = cacheOf(reqName);
    c.entries = entries; c.path = state.path; c.loaded = true; c.error = null;
    renderEntries();
    applyPendingSelect(reqPath);
    renderTabs();
    updateFooter();
    scheduleAutoSize();
  } catch (err) {
    if (seq !== browseSeq || state.active !== reqName) {
      // 过期错误不打扰当前连接；仅以 toast 轻提示来源。
      toast(reqName + ' 读取失败：' + (describeError(err) || err), true);
      return;
    }
    // 失败不再渲染空表（看起来像正常），改为列表区显示错误卡片并给出分类提示。
    state.entries = [];
    const c = cacheOf(reqName);
    c.error = { remote, err }; c.loaded = true;
    renderEntries();
    showBrowseError(remote, err);
    renderTabs();
    const hint = describeError(err);
    setStatus(hint || ('读取失败：' + err), true);
  }
}

function updateAutoSizeButton() {
  const button = document.getElementById('btn-autosize');
  if (!button) return;
  const enabled = !!(state.settings && state.settings.autoSizeEnabled);
  const usable = state.view === 'remote' && !!state.active;
  button.textContent = '统计占用';
  button.classList.toggle('active', enabled);
  button.disabled = !usable;
  button.title = enabled ? '自动统计目录占用：开（点击关闭）' : '自动统计目录占用：关（点击开启）';
}

// toggleAutoSize 在页面直接开关目录大小自动统计，并持久化到设置。
async function toggleAutoSize() {
  const enabled = !(state.settings && state.settings.autoSizeEnabled);
  state.settings = { ...state.settings, autoSizeEnabled: enabled };
  updateAutoSizeButton();
  try { await api().SaveSettings(state.settings); }
  catch (err) { notify('保存设置失败：' + err, true); }
  if (enabled) scheduleAutoSize();
  else cancelAutoSize();
  notify(enabled ? '已开启目录占用自动统计' : '已关闭目录占用自动统计');
}

// ===== 目录大小自动统计：打开目录后延时逐个统计，间隔可配置 =====
let autoSizeTimer = null;
let autoSizeToken = 0;

function cancelAutoSize() {
  autoSizeToken++;
  if (autoSizeTimer) { clearTimeout(autoSizeTimer); autoSizeTimer = null; }
}

function scheduleAutoSize() {
  cancelAutoSize();
  const settings = state.settings || {};
  if (!settings.autoSizeEnabled) return;
  if (!state.entries.some((entry) => entry.isDir && !entry.sizeComputed)) return;
  const token = autoSizeToken;
  const delay = Math.max(0, Number(settings.autoSizeDelay ?? 5)) * 1000;
  autoSizeTimer = setTimeout(() => runAutoSize(token), delay);
}

async function runAutoSize(token) {
  const settings = state.settings || {};
  const interval = Math.max(0, Number(settings.autoSizeInterval ?? 2)) * 1000;
  const tab = state.active;
  const base = tab + ':' + (state.path ? state.path + '/' : '');
  for (const entry of state.entries) {
    if (token !== autoSizeToken || state.active !== tab) return;
    if (!entry.isDir || entry.sizeComputed) continue;
    try {
      const bytes = await api().DirSize(base + entry.name);
      entry.size = bytes;
      entry.sizeComputed = true;
      updateRowSize(entry.name, fmtSize(bytes));
    } catch (err) { /* 单个目录统计失败不影响其他目录 */ }
    if (token !== autoSizeToken) return;
    if (interval) await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function updateRowSize(name, text) {
  const cell = document.querySelector(`#entries tr.row[data-name="${CSS.escape(name)}"] td.size`);
  if (cell) cell.textContent = text;
}

// applyPendingSelect 在从传输记录跳转后选中并滚动到目标文件；只接受目标目录的响应。
function applyPendingSelect(path) {
  if (!pendingSelect || path !== pendingSelect.path) return;
  const name = pendingSelect.file;
  pendingSelect = null;
  if (!name) return;
  const row = document.querySelector(`#entries tr.row[data-name="${CSS.escape(name)}"]`);
  if (!row) return;
  state.multi = new Set([name]);
  row.classList.add('selected');
  row.scrollIntoView({ block: 'center' });
  const entry = state.entries.find((item) => item.name === name);
  const kind = entry ? (entry.isDir ? '目录' : fmtSize(entry.size)) : '';
  setStatus(`已定位：${name}${kind ? '（' + kind + '）' : ''}`);
}

// updateFooter 在状态栏汇总当前目录的路径、文件数、目录数与大小。
function updateFooter(extra) {
  if (!state.active) {
    setStatus(extra || `共 ${state.connections.length} 个连接`);
    return;
  }
  const files = state.entries.filter((entry) => !entry.isDir);
  const dirs = state.entries.length - files.length;
  const total = files.reduce((sum, entry) => sum + (entry.size || 0), 0);
  let text = `${connLabel(state.active)}:${state.path} · ${state.entries.length} 项（文件 ${files.length}，目录 ${dirs}）· ${fmtSize(total)}`;
  if (extra) text += ' · ' + extra;
  setStatus(text);
}

// syncCheckboxes 同步行选中样式、复选框与全选框状态。
function syncCheckboxes(host, selected, allId) {
  const rows = Array.from(host.querySelectorAll('tr.row'));
  let checked = 0;
  rows.forEach((row) => {
    const on = selected.has(row.dataset.selectKey);
    row.classList.toggle('selected', on);
    const box = row.querySelector('input[data-check]');
    if (box) box.checked = on;
    if (on) checked++;
  });
  const all = document.getElementById(allId);
  if (all) {
    all.checked = rows.length > 0 && checked === rows.length;
    all.indeterminate = checked > 0 && checked < rows.length;
  }
}

function renderEntries() {
  if (state.view === 'local' && state.localTab) { renderLocalView(); return; }
  const crumbs = document.getElementById('crumbs');
  updateAutoSizeButton();
  crumbs.style.display = state.active ? 'flex' : 'none';
  applyWindowTitle();
  if (!state.active) {
    const stat = document.getElementById('filter-stat');
    if (stat) stat.textContent = '';
    document.getElementById('crumb-nav').innerHTML = '<span>开始使用</span>';
    document.getElementById('entries').innerHTML = `
      <div class="welcome">
        <h2>开始使用</h2>
        <ol>
          <li>点击左上角「新建连接」创建连接，或从左侧连接列表中选择已有连接。</li>
          <li>双击目录进入；列表右侧操作列可预览、下载或复制到其他连接/此电脑。</li>
          <li>右键连接可挂载为本地盘符；右键文件可重命名、删除或复制下载链接。</li>
          <li>把文件拖到其他页签或「此电脑」可复制，拖入窗口可从资源管理器上传。</li>
        </ol>
        <button id="welcome-new" class="primary">新建连接</button>
      </div>`;
    document.getElementById('welcome-new').onclick = () => openEdit(null);
    return;
  }
  renderRemoteCrumbs();

  const host = document.getElementById('entries');
  // 双击空白处返回上一级。
  host.ondblclick = (e) => { if (e.target.closest && e.target.closest('tr.row')) return; goUp(); };
  const keyword = state.filter.trim().toLowerCase();
  const visible = sortEntries(keyword
    ? state.entries.filter((entry) => String(entry.name).toLowerCase().includes(keyword))
    : state.entries);
  const stat = document.getElementById('filter-stat');
  if (stat) stat.textContent = keyword ? `筛选 ${visible.length} / 共 ${state.entries.length} 项` : '';
  if (!state.entries.length) { host.innerHTML = '<div class="empty">此位置没有对象</div>'; return; }

  const nameWidth = loadNameWidth();
  const totalWidth = nameWidth + COL_CHECK + COL_SIZE + COL_TIME + COL_OPS;
  const arrow = (key) => (state.sort.key === key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : '');
  const rows = visible.map((en, index) => {
    const ops = en.isDir
      ? `<button id="op-copy-${index}" data-op="copy" title="复制到…">${ICONS.copy}</button><button id="op-size-${index}" data-op="size" title="统计占用">${ICONS.chart}</button><button id="op-delete-${index}" data-op="delete" class="danger-op" title="删除">${ICONS.trash}</button>`
      : `<button id="op-preview-${index}" data-op="preview" title="预览">${ICONS.eye}</button><button id="op-download-${index}" data-op="download" title="下载">${ICONS.download}</button><button id="op-copy-${index}" data-op="copy" title="复制到…">${ICONS.copy}</button><button id="op-info-${index}" data-op="info" title="属性">${ICONS.info}</button><button id="op-delete-${index}" data-op="delete" class="danger-op" title="删除">${ICONS.trash}</button>`;
    const cls = en.isDir ? 'dir' : 'file';
    const checked = state.multi.has(en.name);
    const icon = en.isDir ? ICONS.folder : ICONS.file;
    const size = en.isDir ? (en.sizeComputed ? fmtSize(en.size) : '') : fmtSize(en.size);
    return `<tr class="row ${cls}${checked ? ' selected' : ''}" data-name="${esc(en.name)}" data-select-key="${esc(en.name)}" data-dir="${en.isDir}">
      <td class="check"><input type="checkbox" id="check-${index}" data-check="${esc(en.name)}"${checked ? ' checked' : ''} /></td>
      <td class="name"><span class="icon">${icon}</span>${esc(en.name)}</td>
      <td class="size">${esc(size)}</td>
      <td class="time">${esc(en.modTime || '')}</td>
      <td class="ops">${ops}</td>
    </tr>`;
  }).join('');
  const body = rows || `<tr><td colspan="5" class="empty">没有匹配「${esc(state.filter.trim())}」的条目</td></tr>`;
  host.innerHTML = `<table style="width:max(100%, ${totalWidth}px)">
    <colgroup><col style="width:${COL_CHECK}px"><col style="width:${nameWidth}px"><col style="width:${COL_SIZE}px"><col style="width:${COL_TIME}px"><col style="width:${COL_OPS}px"></colgroup>
    <thead><tr>
      <th class="check"><input type="checkbox" id="select-all" title="全选当前列表" /></th>
      <th class="name sortable" data-sort="name">名称${arrow('name')}<span class="col-resizer" title="拖动调整名称列宽"></span></th>
      <th class="size sortable" data-sort="size">大小${arrow('size')}</th>
      <th class="time sortable" data-sort="time">修改时间${arrow('time')}</th>
      <th class="ops">操作</th>
    </tr></thead><tbody>${body}</tbody></table>`;
  const selectAll = document.getElementById('select-all');
  if (selectAll) {
    selectAll.onchange = () => {
      const rows = Array.from(host.querySelectorAll('tr.row'));
      if (selectAll.checked) rows.forEach((item) => state.multi.add(item.dataset.name));
      else state.multi.clear();
      state.selected = null;
      syncCheckboxes(host, state.multi, 'select-all');
      updateFooter(state.multi.size ? `已选 ${state.multi.size} 项` : undefined);
    };
  }
  host.querySelectorAll('th.sortable').forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = -state.sort.dir;
      else state.sort = { key, dir: key === 'name' ? 1 : -1 };
      renderEntries();
    };
  });
  const resizer = host.querySelector('.col-resizer');
  if (resizer) resizer.onmousedown = startNameResize;
  host.querySelectorAll('tr.row').forEach((row) => {
    row.draggable = true;
    row.ondragstart = (e) => {
      const prefix = state.active + ':' + (state.path ? state.path + '/' : '');
      const remotePath = prefix + row.dataset.name;
      const picked = state.multi.size > 1 && state.multi.has(row.dataset.name)
        ? Array.from(state.multi).filter((item) => {
          const entry = state.entries.find((one) => one.name === item);
          return entry && !entry.isDir;
        })
        : [row.dataset.name];
      const paths = (picked.length ? picked : [row.dataset.name]).map((name) => prefix + name);
      if (state.settings && state.settings.dragMode === 'shell') {
        e.preventDefault();
        if (row.dataset.dir === 'true') { toast('目录拖出暂不支持，请使用右键「下载目录…」'); return; }
        setStatus('正在准备拖拽（下载到本地缓存，请按住鼠标不放）…');
        api().DragOutFiles(paths)
          .then((message) => setStatus(message))
          .catch((err) => setStatus('拖拽失败：' + err, true));
        return;
      }
      dragRemotePaths = paths;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/x-oss-remote', remotePath);
    };
    row.ondragend = () => { dragRemotePaths = []; };
    const checkbox = row.querySelector('input[data-check]');
    if (checkbox) {
      checkbox.onclick = (e) => {
        e.stopPropagation();
        const name = row.dataset.name;
        if (checkbox.checked) state.multi.add(name);
        else state.multi.delete(name);
        multiAnchor = Array.from(host.querySelectorAll('tr.row')).indexOf(row);
        state.selected = checkbox.checked
          ? { name, isDir: row.dataset.dir === 'true', path: state.active + ':' + (state.path ? state.path + '/' : '') + name }
          : null;
        syncCheckboxes(host, state.multi, 'select-all');
        updateFooter(state.multi.size > 1 ? `已选 ${state.multi.size} 项` : undefined);
      };
    }
    row.onclick = (e) => {
      const name = row.dataset.name;
      const rows = Array.from(host.querySelectorAll('tr.row'));
      const index = rows.indexOf(row);
      if (e.shiftKey) {
        const anchor = multiAnchor >= 0 && multiAnchor < rows.length ? multiAnchor : index;
        const from = Math.min(anchor, index);
        const to = Math.max(anchor, index);
        if (!e.ctrlKey && !e.metaKey) state.multi.clear();
        for (let i = from; i <= to; i++) state.multi.add(rows[i].dataset.name);
      } else {
        // 直接点击也能逐个勾选/取消，不必每次按住 Ctrl。
        if (state.multi.has(name)) state.multi.delete(name);
        else state.multi.add(name);
        multiAnchor = index;
      }
      syncCheckboxes(host, state.multi, 'select-all');
      state.selected = state.multi.has(name)
        ? { name, isDir: row.dataset.dir === 'true', path: state.active + ':' + (state.path ? state.path + '/' : '') + name }
        : null;
      const picked = state.entries.find((item) => item.name === name);
      updateFooter(state.selected && picked && state.multi.size === 1
        ? `选中：${name}${picked.isDir ? '（目录）' : '（' + fmtSize(picked.size) + '）'}`
        : (state.multi.size > 1 ? `已选 ${state.multi.size} 项` : undefined));
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
        else if (op === 'download') {
          if (state.multi.size > 1 && state.multi.has(name)) downloadSelected();
          else downloadEntry(name);
        } else if (op === 'copy') openCopyMenu(button, remoteCopySource(name, row.dataset.dir === 'true'));
        else if (op === 'info') showInfo(remotePath);
        else if (op === 'link') copyLink(remotePath);
        else if (op === 'delete') deleteEntry(name, row.dataset.dir === 'true');
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
        items.push({ label: '复制到', children: copyTargetItems(remoteCopySource(name, true)) });
        if (!state.path) {
          items.push({ separator: true });
          items.push({ label: '编辑桶策略…', action: () => openPolicy(name) });
          items.push({ label: '新建桶…', action: () => createBucket() });
        }
      } else {
        items.push({ label: '预览', action: () => previewEntry(remotePath) });
        items.push({ label: '下载…', action: () => (state.multi.size > 1 && state.multi.has(name) ? downloadSelected() : downloadEntry(name)) });
        items.push({ label: '复制到', children: copyTargetItems(remoteCopySource(name, false)) });
        items.push({ label: '编辑文本…', action: () => editText(remotePath) });
        items.push({ separator: true });
        items.push({ label: '复制下载链接（7 天）', action: () => copyLink(remotePath) });
        items.push({ label: '对象属性…', action: () => showInfo(remotePath) });
        items.push({ label: '设置过期…', action: () => setExpiry(remotePath) });
      }
      items.push({ separator: true });
      items.push({ label: '复制绝对路径', action: () => copyPath(remotePath, true) });
      items.push({ label: '复制相对路径', action: () => copyPath(remotePath, false) });
      items.push({ separator: true });
      items.push({ label: '重命名…', action: () => renameEntry(name, isDir) });
      items.push({ label: '新建目录…', action: () => createDir() });
      items.push({ label: '上传文件夹…', action: () => uploadFolder() });
      const drive = mountDriveOf(state.active);
      if (drive) items.push({ label: '在文件管理器中打开', action: () => api().OpenFolder(drive + '\\' + state.path.replace(/\//g, '\\')) });
      items.push({ separator: true });
      items.push({ label: '删除…', danger: true, action: () => deleteEntry(name, isDir) });
      showMenu(e.clientX, e.clientY, items);
    };
  });
  host.ondragover = (e) => {
    if (e.dataTransfer.types.includes('application/x-oss-local')) {
      e.preventDefault();
      host.classList.add('drop-target');
    }
  };
  host.ondragleave = () => host.classList.remove('drop-target');
  host.ondrop = (e) => {
    const localPath = e.dataTransfer.getData('application/x-oss-local');
    if (!localPath) return;
    e.preventDefault();
    host.classList.remove('drop-target');
    // 从「此电脑」拖到远程列表：直接上传到当前目录。
    const paths = dragLocalPaths.length ? dragLocalPaths.slice() : [localPath];
    uploadPathsTo(paths, state.active, state.active + ':' + state.path, connLabel(state.active) + ' / ' + state.path);
  };
  syncCheckboxes(host, state.multi, 'select-all');
}

// ===== 本地文件栏 =====

// refreshDrives 重新读取盘符列表（含映射的网络盘），供此电脑页签使用。
async function refreshDrives() {
  try {
    state.local.drives = (await api().LocalDrives()) || [];
  } catch (err) { /* 盘符读取失败不影响远程浏览 */ }
}

async function initLocal() {
  await refreshDrives();
  try { state.home = (await api().HomeDir()) || ''; } catch (err) { state.home = ''; }
  // 「此电脑」默认打开用户目录（文档/桌面所在位置），而不是程序下载目录。
  state.local.path = state.home || state.local.drives[0]?.root || 'C:\\';
}

// splitLocalPath 把本地路径拆成根前缀与后续层级，用于面包屑。
function splitLocalPath(path) {
  const value = String(path || '').replace(/\//g, '\\');
  const unc = value.match(/^\\\\([^\\]+)\\([^\\]+)(.*)$/);
  if (unc) {
    return { base: '\\\\' + unc[1] + '\\' + unc[2], rest: unc[3].split('\\').filter(Boolean) };
  }
  const drive = value.match(/^([A-Za-z]:)(.*)$/);
  if (drive) return { base: drive[1] + '\\', rest: drive[2].split('\\').filter(Boolean) };
  return { base: value, rest: [] };
}

// localCrumbTrail 生成可点击的本地路径面包屑；盘符根目录由左侧下拉显示，不再重复。
function localCrumbTrail(path) {
  const { base, rest } = splitLocalPath(path);
  const driveRoot = /^[A-Za-z]:[\\/]?$/.test(base);
  let accumulated = base;
  const segments = rest.map((part) => {
    accumulated = joinLocal(accumulated, part);
    return { name: part, path: accumulated };
  });
  const links = [];
  if (!driveRoot) links.push(crumbLink(base, base));
  if (segments.length > 4) {
    links.push('<a href="#" class="elide" id="local-crumb-elide" title="显示被省略的层级">…</a>');
    const tail = segments.slice(-2);
    links.push(crumbLink(tail[0].name, tail[0].path));
    links.push(crumbLink(tail[1].name, tail[1].path, true));
  } else {
    segments.forEach((segment, index) => {
      links.push(crumbLink(segment.name, segment.path, index === segments.length - 1));
    });
  }
  if (!links.length) links.push(crumbLink(base, base, true));
  return links.join('<span class="sep">/</span>');
}

// ===== 路径栏：目录树按钮、地址编辑与省略 =====
function crumbLink(label, path, current = false) {
  return `<a href="#" data-path="${esc(path)}"${current ? ' class="current"' : ''}>${esc(label)}</a>`;
}

function treeButtonHTML() {
  return `<button id="btn-tree" class="icon-btn${state.treeVisible ? ' active' : ''}" title="显示/隐藏目录树">${ICONS.tree}</button>
    <button id="btn-fav" class="icon-btn" title="收藏当前目录">${ICONS.star}</button>`;
}

function bindTreeButton() {
  const button = document.getElementById('btn-tree');
  if (button) button.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleTree(); };
  const favButton = document.getElementById('btn-fav');
  if (favButton) favButton.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(); };
  updateFavoriteButton();
}

function showMenuAt(anchor, items) {
  const rect = anchor.getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 4, items.length ? items : [{ label: '没有更多层级' }]);
}

function renderRemoteCrumbs() {
  const parts = state.path ? state.path.split('/').filter(Boolean) : [];
  const rootLabel = connLabel(state.active);
  let trail = crumbLink(rootLabel, '', !parts.length);
  if (parts.length > 4) {
    trail += '<span class="sep">/</span><a href="#" class="elide" id="crumb-elide" title="显示被省略的路径">…</a>';
    parts.slice(-2).forEach((part, index) => {
      const position = parts.length - 2 + index;
      trail += '<span class="sep">/</span>' + crumbLink(part, parts.slice(0, position + 1).join('/'), index === 1);
    });
  } else {
    parts.forEach((part, index) => {
      trail += '<span class="sep">/</span>' + crumbLink(part, parts.slice(0, index + 1).join('/'), index === parts.length - 1);
    });
  }
  const full = state.active + ':' + state.path;
  const nav = document.getElementById('crumb-nav');
  nav.innerHTML = `${treeButtonHTML()}<a href="#" id="go-up" title="上级目录">${ICONS.up}</a>
    <span class="pathbar" title="${esc(full)}（点击编辑地址）">
      <span class="path-icon">${ICONS.folder}</span>
      <span class="trail">${trail}</span>
      <input id="path-input" class="path-input" style="display:none" />
    </span>`;
  document.getElementById('go-up').onclick = (e) => { e.preventDefault(); goUp(); };
  nav.querySelectorAll('a[data-path]').forEach((link) => {
    link.onclick = (e) => { e.preventDefault(); e.stopPropagation(); navigateRemote(link.dataset.path); };
  });
  bindTreeButton();
  const elide = document.getElementById('crumb-elide');
  if (elide) {
    elide.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hidden = parts.slice(0, Math.max(0, parts.length - 2));
      showMenuAt(elide, hidden.map((part, index) => {
        const target = parts.slice(0, index + 1).join('/');
        return { label: part, action: () => navigateRemote(target) };
      }));
    };
  }
  bindPathBar({
    value: () => full,
    apply: applyRemoteAddress,
    copy: () => { api().SetClipboard(full); notify('已复制：' + full); },
  });
}

function renderLocalCrumbs() {
  const nav = document.getElementById('crumb-nav');
  const drives = state.local.drives || [];
  const currentRoot = /^[A-Za-z]:[\\/]/.test(state.localView.path) ? state.localView.path.slice(0, 3) : '';
  const driveOptions = drives.map((drive) => {
    const root = drive.root;
    const letter = root.charAt(0).toUpperCase();
    const label = drive.label && drive.label !== letter ? `${root} ${drive.label}` : root;
    const selected = root.toUpperCase() === currentRoot.toUpperCase() ? ' selected' : '';
    return `<option value="${esc(root)}"${selected}>${esc(label)}</option>`;
  }).join('');
  const driveSelect = drives.length ? `<select id="local-view-drive" class="drive-select" title="选择磁盘">${driveOptions}</select>` : '';
  nav.innerHTML = `${treeButtonHTML()}<a href="#" id="local-view-up" title="上级目录">${ICONS.up}</a>${driveSelect}
    <span class="pathbar" title="${esc(state.localView.path)}（点击编辑地址）">
      <span class="path-icon">${ICONS.folder}</span>
      <span class="trail">${localCrumbTrail(state.localView.path)}</span>
      <input id="path-input" class="path-input" style="display:none" />
    </span>`;
  document.getElementById('local-view-up').onclick = (e) => { e.preventDefault(); localViewUp(); };
  const driveInput = document.getElementById('local-view-drive');
  if (driveInput) driveInput.onchange = (e) => loadLocalView(e.target.value);
  nav.querySelectorAll('a[data-path]').forEach((link) => {
    link.onclick = (e) => { e.preventDefault(); e.stopPropagation(); loadLocalView(link.dataset.path); };
  });
  bindTreeButton();
  const elide = document.getElementById('local-crumb-elide');
  if (elide) {
    elide.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const { base, rest } = splitLocalPath(state.localView.path);
      const hidden = rest.slice(0, Math.max(0, rest.length - 2));
      let accumulated = base;
      showMenuAt(elide, hidden.map((part) => {
        accumulated = joinLocal(accumulated, part);
        const value = accumulated;
        return { label: part, action: () => loadLocalView(value) };
      }));
    };
  }
  bindPathBar({
    value: () => state.localView.path,
    apply: (raw) => { if (raw) loadLocalView(raw); },
    copy: () => { api().SetClipboard(state.localView.path); notify('已复制：' + state.localView.path); },
  });
}

// bindPathBar 点击整条地址栏进入编辑并全选，Enter 跳转、Esc 取消；右键可复制完整地址。
function bindPathBar({ value, apply, copy }) {
  const bar = document.querySelector('#crumb-nav .pathbar');
  const input = document.getElementById('path-input');
  const trail = document.querySelector('#crumb-nav .pathbar .trail');
  if (!bar || !input || !trail) return;
  let handled = false;
  const close = () => { input.style.display = 'none'; trail.style.display = ''; input.value = ''; };
  const enterEdit = () => {
    if (input.style.display !== 'none') return;
    trail.style.display = 'none';
    input.style.display = '';
    input.value = value();
    input.focus();
    input.select();
  };
  bar.onclick = (e) => {
    if (e.target.closest('a') || e.target === input) return;
    e.preventDefault();
    enterEdit();
  };
  bar.oncontextmenu = (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: '编辑地址', action: enterEdit },
      { label: '复制地址', action: copy },
    ]);
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handled = true;
      const raw = input.value.trim();
      close();
      apply(raw);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handled = true;
      close();
    }
  };
  input.onblur = () => {
    if (handled) { handled = false; return; }
    close();
  };
}

// applyRemoteAddress 解析地址栏输入：支持连接:路径，也支持在当前连接内只填路径。
function applyRemoteAddress(raw) {
  const value = String(raw || '').trim();
  if (!value) return;
  const colon = value.indexOf(':');
  if (colon > 0) {
    const name = value.slice(0, colon);
    const rest = value.slice(colon + 1).replace(/^\/+/, '').replace(/\/+$/, '');
    if (state.connections.some((connection) => connection.name === name)) {
      if (name !== state.active) openTab(name);
      navigateRemote(rest);
      return;
    }
  }
  navigateRemote(value.replace(/^\/+/, '').replace(/\/+$/, ''));
}

// ===== 目录树：按需加载子目录，点击节点跳转 =====
const tree = { key: '', nodes: new Map(), current: '' };
let treeToken = 0;

function treeNode(path, name, options = {}) {
  let node = tree.nodes.get(path);
  if (!node) {
    node = {
      path,
      name: name || path,
      display: options.display || name || path,
      isDrive: !!options.isDrive,
      expanded: false,
      loading: false,
      loaded: false,
      children: [],
    };
    tree.nodes.set(path, node);
  }
  return node;
}

// findTreeNode 按路径查找节点；本地盘符大小写不敏感。
function findTreeNode(path) {
  if (tree.nodes.has(path)) return tree.nodes.get(path);
  const lower = String(path).toLowerCase();
  for (const [key, node] of tree.nodes) {
    if (String(key).toLowerCase() === lower) return node;
  }
  return null;
}

function treeKey() {
  if (state.view === 'local') return state.localTab ? 'local' : '';
  return state.active ? 'remote:' + state.active : '';
}

// treeFavoriteItem 把树节点转成收藏项：远程保存连接名与相对路径，本地保存绝对路径。
function treeFavoriteItem(node) {
  if (tree.key === 'local') {
    return { kind: 'local', path: node.path || state.home || 'C:\\' };
  }
  return { kind: 'remote', name: tree.key.slice('remote:'.length), path: node.path || '' };
}

async function treeInitRoot(key) {
  tree.key = key;
  tree.nodes.clear();
  tree.current = '';
  if (key === 'local') {
    const root = treeNode('', '此电脑');
    root.loaded = true;
    root.expanded = true;
    root.children = (state.local.drives || []).map((drive) => {
      const letter = drive.root.charAt(0).toUpperCase();
      const label = drive.label && drive.label !== letter ? `${drive.root} ${drive.label}` : drive.root;
      return treeNode(drive.root, drive.root, { display: label, isDrive: true });
    });
  } else {
    const name = key.slice('remote:'.length);
    const root = treeNode('', name);
    root.display = '根目录';
    root.expanded = true;
    await treeLoadChildren(root);
  }
  renderTree();
}

async function treeLoadChildren(node) {
  if (node.loading || node.loaded) return;
  node.loading = true;
  renderTree();
  try {
    let dirs = [];
    if (tree.key === 'local') {
      dirs = ((await api().ListLocal(node.path)) || []).filter((entry) => entry.isDir);
      node.children = dirs.map((entry) => treeNode(joinLocal(node.path, entry.name), entry.name));
    } else {
      const name = tree.key.slice('remote:'.length);
      dirs = ((await api().List(name + ':' + node.path)) || []).filter((entry) => entry.isDir);
      node.children = dirs.map((entry) => treeNode(node.path ? node.path + '/' + entry.name : entry.name, entry.name));
    }
    node.loaded = true;
  } catch (err) {
    node.children = [];
    node.loaded = true;
  }
  node.loading = false;
  renderTree();
}

function treeNodeHTML(node, depth) {
  const isLeaf = node.loaded && !node.children.length && !node.isDrive;
  const marker = node.loading ? '⋯' : (node.expanded ? '▾' : (isLeaf ? '' : '▸'));
  const children = node.expanded ? node.children.map((child) => treeNodeHTML(child, depth + 1)).join('') : '';
  const current = node.path === tree.current ? ' current' : '';
  const title = node.path || node.display;
  return `<div class="tree-node">
    <div class="tree-row${current}" data-tree-path="${esc(node.path)}" style="padding-left:${8 + depth * 14}px">
      <span class="tree-toggle">${marker}</span>
      <span class="tree-icon">${node.isDrive ? ICONS.drive : ICONS.folder}</span>
      <span class="tree-name" title="${esc(title)}">${esc(node.display)}</span>
    </div>${children}
  </div>`;
}

function renderTree() {
  const body = document.getElementById('tree-body');
  const pane = document.getElementById('tree-pane');
  if (!body || !pane || pane.style.display === 'none') return;
  if (!tree.key) { body.innerHTML = '<div class="empty">打开一个页签后显示目录树</div>'; return; }
  const root = tree.nodes.get('');
  if (!root) { body.innerHTML = ''; return; }
  body.innerHTML = treeNodeHTML(root, 0);
  body.querySelectorAll('.tree-row').forEach((row) => {
    row.onclick = (event) => { event.stopPropagation(); handleTreeRow(row, event); };
    row.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const node = tree.nodes.get(row.dataset.treePath);
      if (!node) return;
      const item = treeFavoriteItem(node);
      const on = isFavorite(item);
      showMenu(event.clientX, event.clientY, [
        { label: on ? '取消收藏此目录' : '收藏此目录', action: () => toggleFavoriteOf(item) },
        { label: '复制路径', action: () => {
          const value = item.kind === 'local' ? item.path : item.name + ':' + (item.path || '');
          api().SetClipboard(value);
          notify('已复制：' + value);
        } },
      ]);
    };
  });
  const current = body.querySelector('.tree-row.current');
  if (current) current.scrollIntoView({ block: 'nearest' });
}

async function handleTreeRow(row, event) {
  const node = tree.nodes.get(row.dataset.treePath);
  if (!node) return;
  if (event.target.closest('.tree-toggle')) {
    if (node.expanded) { node.expanded = false; renderTree(); return; }
    if (!node.loaded) await treeLoadChildren(node);
    node.expanded = true;
    renderTree();
    return;
  }
  if (!node.loaded) await treeLoadChildren(node);
  node.expanded = true;
  if (tree.key === 'local') {
    const path = node.path || state.home || 'C:\\';
    if (!state.localTab) { openLocalTab(path, '此电脑'); return; }
    state.view = 'local';
    renderTabs();
    renderConnections();
    showBrowseLoading(path);
    loadLocalView(path);
    return;
  }
  const name = tree.key.slice('remote:'.length);
  if (!state.active || state.active !== name) openTab(name);
  state.view = 'remote';
  navigateRemote(node.path);
}

async function syncTree() {
  if (!state.treeVisible) return;
  const key = treeKey();
  if (!key) { tree.key = ''; renderTree(); return; }
  const token = ++treeToken;
  if (tree.key !== key) await treeInitRoot(key);
  if (token !== treeToken) return;
  if (key === 'local') await treeRevealLocal(token);
  else await treeRevealRemote(token);
}

async function treeRevealRemote(token) {
  const root = tree.nodes.get('');
  if (!root) return;
  if (!root.loaded) await treeLoadChildren(root);
  root.expanded = true;
  if (token !== treeToken) return;
  const parts = state.path ? state.path.split('/').filter(Boolean) : [];
  let prefix = '';
  for (const part of parts) {
    prefix = prefix ? prefix + '/' + part : part;
    const node = findTreeNode(prefix);
    if (!node) break;
    if (!node.loaded) await treeLoadChildren(node);
    if (token !== treeToken) return;
    node.expanded = true;
  }
  tree.current = state.path;
  renderTree();
}

async function treeRevealLocal(token) {
  const root = tree.nodes.get('');
  if (!root) return;
  root.expanded = true;
  const path = state.localView.path;
  const { base, rest } = splitLocalPath(path);
  if (base && !root.children.some((node) => node.path.toUpperCase() === base.toUpperCase())) {
    root.children.push(treeNode(base, base, { isDrive: true }));
  }
  let prefix = base;
  const chain = [base];
  rest.forEach((part) => { prefix = joinLocal(prefix, part); chain.push(prefix); });
  for (const value of chain) {
    if (token !== treeToken) return;
    const node = findTreeNode(value);
    if (!node) continue;
    if (!node.loaded) await treeLoadChildren(node);
    if (token !== treeToken) return;
    node.expanded = true;
  }
  tree.current = path;
  renderTree();
}

function toggleTree(force) {
  state.treeVisible = force === undefined ? !state.treeVisible : !!force;
  localStorage.setItem('ossmanager.treeVisible', state.treeVisible ? '1' : '0');
  const pane = document.getElementById('tree-pane');
  if (pane) pane.style.display = state.treeVisible ? '' : 'none';
  // 目录树已列出磁盘，展开时不再占用路径栏宽度重复显示磁盘下拉。
  document.body.classList.toggle('tree-open', state.treeVisible);
  document.querySelectorAll('#btn-tree').forEach((node) => node.classList.toggle('active', state.treeVisible));
  if (state.treeVisible) syncTree();
}

// bindResizers 让连接栏宽度可以拖动调整。
function bindResizers() {
  document.querySelectorAll('.resizer').forEach((bar) => {
    bar.onmousedown = (event) => {
      event.preventDefault();
      const pane = document.getElementById(bar.dataset.target);
      if (!pane) return;
      const startX = event.clientX;
      const startWidth = pane.getBoundingClientRect().width;
      const move = (moveEvent) => {
        const next = Math.max(150, Math.min(720, startWidth + moveEvent.clientX - startX));
        pane.style.width = next + 'px';
        pane.style.flex = '0 0 ' + next + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        localStorage.setItem('ossmanager.width.' + bar.dataset.target, pane.style.width);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    };
  });
}

function restorePaneWidths() {
  document.querySelectorAll('.resizer').forEach((bar) => {
    const saved = localStorage.getItem('ossmanager.width.' + bar.dataset.target);
    const pane = document.getElementById(bar.dataset.target);
    if (pane && saved) {
      pane.style.width = saved;
      pane.style.flex = '0 0 ' + saved;
    }
  });
}

function joinLocal(base, name) {
  const value = String(base || '');
  if (!value) return name;
  if (/[\\/]$/.test(value)) return value + name;
  return value + (value.includes('/') && !value.includes('\\') ? '/' : '\\') + name;
}

function dirOf(path) {
  const value = String(path || '');
  const index = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
  return index > 0 ? value.slice(0, index) : value;
}

function openNetDialog() {
  document.getElementById('net-path').value = '';
  document.getElementById('net-user').value = '';
  document.getElementById('net-pass').value = '';
  document.getElementById('net-dialog').showModal();
}

async function confirmNet() {
  const path = document.getElementById('net-path').value.trim();
  if (!path) return;
  const user = document.getElementById('net-user').value.trim();
  const password = document.getElementById('net-pass').value;
  document.getElementById('net-dialog').close();
  setStatus('正在连接 ' + path + ' …');
  try {
    await api().MountNetworkLocation(path, user, password);
    await refresh();
    await initLocal();
    const share = state.shares.find((item) => item.remote === path);
    openLocalTab((share && share.local) || path, share ? shareLabel(share) : path);
    notify('已连接 ' + path);
  } catch (err) { notify('连接失败：' + err, true); }
}

// navigateRemote 先显示加载占位再请求列表，双击进入时反馈更快。
function navigateRemote(path) {
  state.selected = null;
  state.multi.clear();
  clearFilter();
  state.path = path;
  if (state.active) {
    showBrowseLoading(state.active + ':' + path);
    renderTabs();
  }
  loadEntries();
  syncTree();
}

function enterDir(name) { navigateRemote(state.path ? state.path + '/' + name : name); }
function goUp() { const parts = state.path.split('/').filter(Boolean); parts.pop(); navigateRemote(parts.join('/')); }

async function mountActive() {
  return mountRemote(state.active);
}

// mountRemote 挂载指定连接到盘符；右键菜单不切换当前页签也能挂载。
async function mountRemote(name) {
  if (!name) { notify('请先选择连接', true); return; }
  const drives = (await api().FreeDrives()) || [];
  if (!drives.length) { notify('没有可用盘符', true); return; }
  state.mountTarget = name;
  const select = document.getElementById('mount-drive');
  select.innerHTML = drives.map((drive) => `<option value="${esc(drive)}">${esc(drive)}</option>`).join('');
  document.getElementById('mount-volume').value = connLabel(name);
  document.getElementById('mount-dialog').showModal();
}

async function confirmMount() {
  const target = state.mountTarget || state.active;
  const drive = document.getElementById('mount-drive').value;
  const volume = document.getElementById('mount-volume').value.trim();
  if (!target || !drive) return;
  document.getElementById('mount-dialog').close();
  setStatus('正在挂载 ' + target + ' → ' + drive + ' …');
  try { await api().Mount(target, drive, volume); await refresh(); notify('已挂载到 ' + drive); }
  catch (err) { notify('挂载失败：' + err, true); }
  finally { state.mountTarget = null; }
}

async function unmountActive() {
  return unmountRemote(state.active);
}

async function unmountRemote(name) {
  if (!name) { setStatus('请先选择连接', true); return; }
  setStatus('正在卸载 ' + name + ' …');
  try { await api().UnmountByRemote(name); await refresh(); notify('已卸载 ' + name); }
  catch (err) { setStatus('卸载失败：' + err, true); }
}

// ===== 网络共享：修改盘符 / 名称 / 断开映射 =====
let shareEditing = null;

async function openShareEdit(share) {
  shareEditing = share;
  document.getElementById('share-path').textContent = share.remote + (share.local ? ' → ' + share.local : '');
  const select = document.getElementById('share-drive');
  let options = '<option value="">（不映射）</option>';
  const current = String(share.local || '').replace(/\\$/, '');
  if (current) options += `<option value="${esc(current)}">${esc(current)}（当前）</option>`;
  try {
    const free = (await api().FreeDrives()) || [];
    free.forEach((drive) => { options += `<option value="${esc(drive)}">${esc(drive)}</option>`; });
  } catch (err) { /* 盘符读取失败时只保留当前盘符 */ }
  select.innerHTML = options;
  select.value = current;
  document.getElementById('share-name').value = shareAliases()[share.remote] || defaultShareLabel(share);
  document.getElementById('share-dialog').showModal();
}

async function confirmShareEdit() {
  const share = shareEditing;
  if (!share) return;
  const drive = document.getElementById('share-drive').value;
  const name = document.getElementById('share-name').value.trim();
  document.getElementById('share-dialog').close();
  shareEditing = null;
  const current = String(share.local || '').replace(/\\$/, '');
  if (drive && drive.toUpperCase() !== current.toUpperCase()) {
    try {
      await api().RemapNetworkLocation(share.remote, drive);
      // 已打开的此电脑页签跟随换盘符。
      if (state.localTab && state.localTab.path.toUpperCase().startsWith(current.toUpperCase())) {
        state.localTab.path = drive + state.localTab.path.slice(current.length);
      }
      notify('已改挂到 ' + drive);
    } catch (err) { notify('修改盘符失败：' + err, true); }
  }
  await refresh();
  await refreshDrives();
  const updated = state.shares.find((item) => item.remote === share.remote) || share;
  const aliases = shareAliases();
  if (!name || name === defaultShareLabel(updated)) delete aliases[share.remote];
  else aliases[share.remote] = name;
  localStorage.setItem('ossmanager.shareNames', JSON.stringify(aliases));
  if (state.localTab && (state.localTab.path === updated.local || state.localTab.path === share.remote
    || state.localTab.path.toUpperCase().startsWith(String(updated.local || '').replace(/\\$/, '').toUpperCase()))) {
    state.localTab.label = shareLabel(updated);
    renderTabs();
  }
  if (state.view === 'local') renderEntries();
  renderConnections();
}

async function unmountShare(share) {
  if (!share) return;
  const result = await showConfirm({
    title: '断开共享映射',
    text: `${shareLabel(share)}\n\n${share.remote}`,
    okText: '断开映射',
  });
  if (!result.ok) return;
  try {
    await api().UnmountNetworkLocation(share.remote);
    await refresh();
    await refreshDrives();
    if (state.view === 'local') renderEntries();
    notify('已断开 ' + shareLabel(share));
  } catch (err) { notify('断开失败：' + err, true); }
}

async function unmountShareFromDialog() {
  const share = shareEditing;
  if (!share) return;
  document.getElementById('share-dialog').close();
  shareEditing = null;
  await unmountShare(share);
}

async function openEdit(name) {
  state.editing = name || null;
  document.getElementById('edit-title').textContent = name ? '编辑连接' : '新建连接';
  // 密钥默认为隐藏，并清空上次残留值。
  const secretInput = document.getElementById('edit-secret');
  secretInput.type = 'password';
  secretInput.value = '';
  document.getElementById('edit-secret-eye').innerHTML = ICONS.eye;
  const fields = { 'edit-name': '', 'edit-endpoint': '', 'edit-account': '', 'edit-region': '', 'edit-volume': '' };
  Object.keys(fields).forEach((id) => { document.getElementById(id).value = fields[id]; });
  document.getElementById('edit-name').disabled = false;
  document.getElementById('edit-name-hint').textContent = name
    ? '这里修改的是界面显示名称，连接标识与已有挂载保持不变。'
    : '新建连接时名称同时作为连接标识，不能包含空格或方括号。';
  document.getElementById('edit-type').value = 'minio';
  let info = { drive: '', volume: '' };
  let displayName = '';
  if (name) {
    try {
      const def = await api().GetConnection(name);
      displayName = def.displayName || def.name || name;
      document.getElementById('edit-name').value = displayName;
      document.getElementById('edit-type').value = def.type || 'minio';
      document.getElementById('edit-endpoint').value = def.endpoint || '';
      document.getElementById('edit-account').value = def.account || '';
      document.getElementById('edit-region').value = def.region || '';
      // 编辑时回显已有密钥，便于核对；仍默认以密码形式隐藏。
      document.getElementById('edit-secret').value = def.secret || '';
      info = (await api().GetMountInfo(name)) || info;
    } catch (err) { setStatus('读取连接失败：' + err, true); }
  }
  // 盘符下拉：不挂载 + 空闲盘符 + 当前挂载盘符。
  const select = document.getElementById('edit-drive');
  let options = '<option value="">不挂载</option>';
  try {
    const free = (await api().FreeDrives()) || [];
    free.forEach((drive) => { options += `<option value="${esc(drive)}">${esc(drive)}</option>`; });
  } catch (err) { /* 盘符读取失败时只保留不挂载 */ }
  if (info.drive) options += `<option value="${esc(info.drive)}">${esc(info.drive)}（当前）</option>`;
  select.innerHTML = options;
  select.value = info.drive || '';
  const volume = document.getElementById('edit-volume');
  volume.value = info.volume || displayName || name || '';
  volume.placeholder = displayName || name || '与名称一致';
  document.getElementById('edit-dialog').showModal();
}

// sanitizeRemoteName 去掉段名不允许的空白与方括号，保住新建连接可用。
function sanitizeRemoteName(value) {
  return String(value || '').replace(/[\[\]\s]+/g, '_').replace(/^_+|_+$/g, '');
}

function readConnectionForm() {
  const typed = document.getElementById('edit-name').value.trim();
  const internal = state.editing || sanitizeRemoteName(typed);
  return {
    name: internal,
    displayName: typed || internal,
    type: document.getElementById('edit-type').value,
    endpoint: document.getElementById('edit-endpoint').value.trim(),
    account: document.getElementById('edit-account').value.trim(),
    secret: document.getElementById('edit-secret').value,
    region: document.getElementById('edit-region').value.trim(),
  };
}

// testConnectionInput 在保存前用当前表单参数测试连通性。
async function testConnectionInput() {
  const def = readConnectionForm();
  setStatus('正在测试连接 ' + (def.endpoint || '') + ' …');
  try {
    await api().TestConnectionInput(def);
    notify('连接正常');
  } catch (err) {
    notify('连接失败：' + (describeError(err) || err), true);
  }
}

async function saveConnection() {
  const def = readConnectionForm();
  const isNew = !state.editing;
  const drive = document.getElementById('edit-drive').value;
  const volume = document.getElementById('edit-volume').value.trim() || def.displayName || def.name;
  let previous = { drive: '', volume: '' };
  try {
    if (!isNew) previous = (await api().GetMountInfo(state.editing)) || previous;
    await api().SaveConnection(def, !isNew);
    document.getElementById('edit-dialog').close();
    await refresh();
    renderTabs();
    notify('连接已保存');
    await applyMountChoice(def.name, drive, volume, previous);
  } catch (err) { setStatus('保存失败：' + err, true); }
}

// applyMountChoice 按编辑框里的盘符与名称调整挂载：未选盘符则卸载，与原来不同则重挂。
async function applyMountChoice(name, drive, volume, previous) {
  const oldDrive = (previous && previous.drive) || '';
  const oldVolume = (previous && previous.volume) || name;
  if (!drive) {
    if (oldDrive) {
      await unmountRemoteQuiet(name);
      notify('已保存并卸载 ' + oldDrive);
    }
    return;
  }
  if (oldDrive && oldDrive.toUpperCase() === drive.toUpperCase() && oldVolume === volume) return;
  if (oldDrive) await unmountRemoteQuiet(name);
  try {
    await api().Mount(name, drive, volume);
    await refresh();
    notify('已保存并挂载到 ' + drive);
  } catch (err) {
    notify('保存成功，但挂载失败：' + err, true);
  }
}

async function unmountRemoteQuiet(name) {
  try { await api().UnmountByRemote(name); await refresh(); }
  catch (err) { /* 未挂载时忽略 */ }
}

async function deleteConnection(name) {
  const result = await showConfirm({
    title: '删除连接',
    text: `${connLabel(name)}\n\n连接配置、挂载与开机恢复记录都会一并移除，且不可恢复。`,
    okText: '删除连接',
  });
  if (!result.ok) return;
  try { await api().DeleteConnection(name); await refresh(); notify('已删除'); }
  catch (err) { setStatus('删除失败：' + err, true); }
}

async function renameConnection(name) {
  const next = prompt('新的内部名称', name);
  if (!next || next === name) return;
  try {
    const finalName = next.trim();
    await api().RenameConnection(name, finalName);
    if (tabCache[name]) {
      tabCache[finalName] = tabCache[name];
      delete tabCache[name];
      const idx = tabOrder.indexOf(name);
      if (idx >= 0) tabOrder[idx] = finalName;
      if (state.active === name) state.active = finalName;
    }
    await refresh(); notify('已改名');
  }
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
  if (key === 'c' && state.active && state.view === 'remote') {
    const selection = window.getSelection();
    const hasText = selection && !selection.isCollapsed && String(selection).trim().length > 0;
    // 正在复制状态栏/路径文字、或没有任何文件被选中时，不拦截 Ctrl+C，交给浏览器复制文本。
    if (hasText) return;
    if (!state.multi.size && !state.selected) return;
    e.preventDefault();
    copySelected();
  } else if (key === 'v' && state.active && state.view === 'remote') {
    e.preventDefault();
    pasteInto();
  }
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

// ===== 在线预览：图片/文本/PDF/音视频在应用内打开，不支持的类型回退到系统程序 =====
let previewState = null;
let previewToken = 0;

async function previewEntry(remotePath) {
  const token = ++previewToken;
  setStatus('正在准备在线预览…');
  try {
    const data = await api().PreviewData(remotePath);
    if (token !== previewToken) return;
    showPreview(data, remotePath);
  } catch (err) {
    if (token !== previewToken) return;
    const message = String(err);
    if (message.includes('较大')) {
      const result = await showConfirm({
        title: '无法在线预览',
        text: message + '\n\n是否用系统默认程序打开？',
        okText: '用系统程序打开',
        okDanger: false,
      });
      if (result.ok) openPreviewInSystemPath(remotePath);
      return;
    }
    notify('预览失败：' + message, true);
  }
}

function base64Bytes(value) {
  return Uint8Array.from(atob(value || ''), (c) => c.charCodeAt(0));
}

function showPreview(data, remotePath) {
  const dialog = document.getElementById('preview-dialog');
  const body = document.getElementById('preview-body');
  cleanupPreview();
  previewState = { remotePath, localPath: data.localPath, url: '' };
  const mime = String(data.mime || '').toLowerCase();
  let html = '';
  if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/') || mime.startsWith('application/pdf')) {
    const blob = new Blob([base64Bytes(data.data)], { type: data.mime });
    previewState.url = URL.createObjectURL(blob);
    if (mime.startsWith('image/')) {
      html = `<img class="preview-image" src="${previewState.url}" alt="${esc(data.name)}" />`;
    } else if (mime.startsWith('video/')) {
      html = `<video class="preview-media" src="${previewState.url}" controls autoplay></video>`;
    } else if (mime.startsWith('audio/')) {
      html = `<audio class="preview-media" src="${previewState.url}" controls autoplay></audio>`;
    } else {
      html = `<iframe class="preview-frame" src="${previewState.url}" title="${esc(data.name)}"></iframe>`;
    }
  } else if (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime.includes('javascript')) {
    html = `<pre class="preview-text">${esc(new TextDecoder('utf-8').decode(base64Bytes(data.data)))}</pre>`;
  } else {
    html = '<div class="empty">该类型暂不支持在线预览，可点击「用系统程序打开」。</div>';
  }
  body.innerHTML = html;
  document.getElementById('preview-title').textContent = data.name;
  if (!dialog.open) dialog.showModal();
  notify('预览：' + data.name);
}

function cleanupPreview() {
  if (previewState && previewState.url) URL.revokeObjectURL(previewState.url);
  previewState = null;
  const body = document.getElementById('preview-body');
  if (body) body.innerHTML = '';
}

function copyPreviewAddress() {
  if (!previewState) return;
  api().SetClipboard(previewState.remotePath);
  notify('已复制：' + previewState.remotePath);
}

function openPreviewInSystem() {
  if (!previewState) return;
  openPreviewInSystemPath(previewState.remotePath);
}

function openPreviewInSystemPath(remotePath) {
  api().PreviewRemote(remotePath)
    .then((local) => notify('已用系统程序打开：' + local))
    .catch((err) => notify('打开失败：' + err, true));
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
  } else {
    const colon = remotePath.indexOf(':');
    value = colon >= 0 ? remotePath.slice(colon + 1).replace(/^\//, '') : remotePath;
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
  const result = await showConfirm({
    title: isDir ? '删除目录' : '删除文件',
    text: `${name}\n\n${isDir ? '目录及其内容将被删除' : '文件将被删除'}，且不可恢复。`,
    okText: '删除',
  });
  if (!result.ok) return;
  const target = state.active + ':' + (state.path ? state.path + '/' : '') + name;
  setStatus('正在删除…');
  try { await api().Delete(target, isDir); await loadEntries(); notify('已删除'); }
  catch (err) { notify('删除失败：' + err, true); }
}

// 有默认下载目录时直接使用，否则每次询问。
async function chooseDownloadDir() {
  const preset = (state.settings && state.settings.downloadDirectory) || '';
  if (preset) return preset;
  return await api().PickFolder();
}

async function createBucket() {
  const name = await askInput('新桶名称', '');
  if (!name) return;
  try { await api().CreateBucket(state.active, name); await loadEntries(); notify('已创建桶'); }
  catch (err) { notify('创建桶失败：' + err, true); }
}

// ===== 自动更新：检查后在后台下载，右上角按钮负责重启安装 =====
async function checkUpdate(silent = false) {
  try {
    const info = await api().CheckUpdate();
    if (!info.hasUpdate) {
      // 自动检查保持状态栏原内容，避免覆盖目录信息。
      if (!silent) notify('当前已是最新版（' + info.current + '）');
      return;
    }
    if (!info.url) {
      if (!silent) notify('发现新版本 ' + info.latest + '，但没有可下载的 exe', true);
      return;
    }
    notify('发现新版本 ' + info.latest + '，正在后台下载…');
    await api().DownloadUpdate(info.url, info.latest);
    await refreshUpdateState();
    notify('新版本 ' + info.latest + ' 已下载，点击右上角「重启安装」完成更新');
  } catch (err) {
    // 自动检查在后台进行，失败（离线、GitHub 限流等）不弹错误提示，避免每次启动打扰。
    if (!silent) notify('检查更新失败：' + err, true);
  }
}

async function refreshUpdateState() {
  try {
    const stateValue = await api().GetUpdateState();
    const button = document.getElementById('update-install');
    if (button) {
      button.style.display = stateValue.ready ? '' : 'none';
      button.textContent = '重启安装 ' + String(stateValue.version || '').replace(/^v/, '');
      button.title = '已下载 ' + (stateValue.version || '') + '，点击重启并安装';
    }
    const label = document.getElementById('set-update-state');
    if (label) {
      label.textContent = stateValue.ready ? '已下载 ' + stateValue.version + '，可重启安装' : '';
    }
  } catch (err) { /* 状态读取失败不影响主流程 */ }
}

async function installUpdate() {
  const stateValue = await api().GetUpdateState();
  if (!stateValue.ready) { notify('还没有下载好的更新', true); return; }
  const result = await showConfirm({
    title: '重启并安装更新',
    text: '将关闭程序并替换为 ' + stateValue.version + '，完成后自动重新打开。正在进行的传输会中断。',
    okText: '重启并安装',
    okDanger: false,
  });
  if (!result.ok) return;
  try { await api().ApplyUpdate(); }
  catch (err) { notify('安装失败：' + err, true); }
}

// 顶部实时速度：每秒读取一次上传/下载字节增量，没有传输时隐藏。
function startSpeedPoll() {
  setInterval(async () => {
    try {
      const stats = await api().TransferStats();
      const element = document.getElementById('speed-indicator');
      if (!element) return;
      const parts = [];
      if (stats.upSpeed > 1) parts.push('↑ ' + fmtSize(stats.upSpeed) + '/s');
      if (stats.downSpeed > 1) parts.push('↓ ' + fmtSize(stats.downSpeed) + '/s');
      element.textContent = parts.join('  ');
      element.style.display = parts.length ? '' : 'none';
    } catch (err) { /* 轮询失败忽略 */ }
  }, 1000);
}

async function uploadFolder() {
  const dir = await api().PickFolder();
  if (!dir) return;
  const source = {
    kind: 'local',
    paths: [dir],
    title: dir.split(/[\\/]/).filter(Boolean).pop() || dir,
  };
  await openCopyPicker(source, currentCopyTarget());
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
  if (state.view === 'local') { notify('请先切换到远程页签', true); return; }
  if (!state.active) { notify('请先选择连接', true); return; }
  const names = [...state.multi].filter((name) => {
    const entry = state.entries.find((item) => item.name === name);
    return entry && !entry.isDir;
  });
  if (!names.length) { notify('请先选择文件', true); return; }
  const dir = await chooseDownloadDir();
  if (!dir) return;
  const base = state.active + ':' + (state.path ? state.path + '/' : '');
  const paths = names.map((name) => base + name);
  setStatus('正在下载 ' + paths.length + ' 个文件…');
  try { const message = await api().DownloadBatch(paths, dir); notify(message + '（' + dir + '）'); }
  catch (err) { notify('下载失败：' + err, true); }
}

async function downloadEntry(name) {
  const dir = await chooseDownloadDir();
  if (!dir) return;
  const remotePath = state.active + ':' + (state.path ? state.path + '/' : '') + name;
  setStatus('正在下载 ' + name + ' …');
  try { const local = await api().Download(remotePath, dir); notify('已下载到 ' + local); }
  catch (err) { setStatus('下载失败：' + err, true); }
}

// downloadPathsFor 返回当前操作涉及的远程文件：多选时包含所有选中的文件。
function downloadPathsFor(name) {
  const prefix = state.active + ':' + (state.path ? state.path + '/' : '');
  const picked = state.multi.size > 1 && state.multi.has(name)
    ? Array.from(state.multi).filter((item) => {
      const entry = state.entries.find((one) => one.name === item);
      return entry && !entry.isDir;
    })
    : [];
  return (picked.length ? picked : [name]).map((item) => prefix + item);
}

// ===== 复制到：先选目标连接，再在对话框里选择目录 =====
// 已打开页签使用它的当前目录，未打开的连接使用根目录。
function copyTargetList(sourceKind) {
  const targets = [];
  if (sourceKind === 'remote') {
    targets.push({
      kind: 'local',
      label: '此电脑',
      start: state.localTab ? state.localView.path : (state.home || state.local.path || 'C:\\'),
    });
  }
  state.connections.forEach((connection) => {
    const opened = tabOrder.includes(connection.name);
    const dir = opened
      ? (connection.name === state.active && state.view === 'remote' ? state.path : (cacheOf(connection.name).path || ''))
      : '';
    targets.push({
      kind: 'remote',
      name: connection.name,
      label: (connection.displayName || connection.name) + (opened ? '（已打开）' : ''),
      start: dir,
    });
  });
  return targets;
}

function copyTargetItems(source) {
  return copyTargetList(source.kind).map((target) => ({
    label: target.kind === 'local'
      ? `此电脑 / ${target.start || '用户目录'}`
      : `${target.label} / ${target.start || '根目录'}`,
    action: () => openCopyPicker(source, target),
  }));
}

function remoteCopySource(name, isDir) {
  if (isDir) {
    const path = state.active + ':' + (state.path ? state.path + '/' : '') + name;
    return { kind: 'remoteDir', paths: [path], title: name };
  }
  const paths = downloadPathsFor(name);
  return { kind: 'remoteFile', paths, title: paths.length > 1 ? paths.length + ' 个文件' : name };
}

function localCopySource(full) {
  const picked = state.localMulti.size > 1 && state.localMulti.has(full)
    ? Array.from(state.localMulti)
    : [full];
  const name = full.split(/[\\/]/).filter(Boolean).pop() || full;
  return { kind: 'local', paths: picked, title: picked.length > 1 ? picked.length + ' 个项目' : name };
}

function openCopyMenu(anchor, source) {
  if (!source.paths.length) { notify('请先选择文件', true); return; }
  const rect = anchor.getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 2, copyTargetItems(source));
}

function currentCopyTarget() {
  if (state.active) {
    const path = state.view === 'remote' ? state.path : (cacheOf(state.active).path || '');
    return { kind: 'remote', name: state.active, start: path };
  }
  const first = tabOrder[0] || (state.connections[0] && state.connections[0].name);
  if (first) return { kind: 'remote', name: first, start: cacheOf(first).path || '' };
  return { kind: 'local', start: state.localView.path || state.home || 'C:\\' };
}

let copyState = null;
let copySeq = 0;

async function openCopyPicker(source, target) {
  const targets = copyTargetList(source.kind);
  if (!targets.length) { notify('请先新建一个连接', true); return; }
  let index = targets.findIndex((item) => item.kind === target.kind
    && (item.kind === 'local' || item.name === target.name));
  if (index < 0) index = 0;
  copyState = { source, targets, target: targets[index], path: '', entries: [] };
  document.getElementById('copy-title').textContent = `复制 ${source.title || ''} 到`;
  const select = document.getElementById('copy-target-select');
  select.innerHTML = targets.map((item, i) => `<option value="${i}">${esc(targetLabel(item))}</option>`).join('');
  select.value = String(index);
  select.onchange = () => {
    const next = copyState && copyState.targets[Number(select.value)];
    if (!next || !copyState) return;
    copyState.target = next;
    loadCopyDir(next.start || '');
  };
  document.getElementById('copy-dialog').showModal();
  await loadCopyDir(targets[index].start || '');
}

function targetLabel(target) {
  if (target.kind === 'local') return '此电脑 / ' + (target.start || '用户目录');
  return target.label + ' / ' + (target.start || '根目录');
}

function closeCopyDialog() {
  copyState = null;
  const dialog = document.getElementById('copy-dialog');
  if (dialog.open) dialog.close();
}

async function loadCopyDir(path) {
  if (!copyState) return;
  const seq = ++copySeq;
  copyState.path = path;
  copyState.entries = [];
  const list = document.getElementById('copy-list');
  document.getElementById('copy-path').textContent = copyState.target.kind === 'local'
    ? (path || '此电脑')
    : copyState.target.name + ':' + path;
  list.innerHTML = '<div class="empty">正在读取…</div>';
  try {
    const entries = copyState.target.kind === 'local'
      ? (await api().ListLocal(path)) || []
      : (await api().List(copyState.target.name + ':' + path)) || [];
    if (!copyState || seq !== copySeq) return;
    copyState.entries = entries.filter((entry) => entry.isDir);
  } catch (err) {
    if (!copyState || seq !== copySeq) return;
    copyState.entries = [];
    list.innerHTML = `<div class="empty error">${esc(describeError(err) || String(err))}</div>`;
    return;
  }
  renderCopyList();
}

function renderCopyList() {
  if (!copyState) return;
  const list = document.getElementById('copy-list');
  const target = copyState.target;
  const driveSelect = document.getElementById('copy-drive');
  if (target.kind === 'local') {
    driveSelect.style.display = '';
    const drives = state.local.drives || [];
    const currentRoot = /^[A-Za-z]:[\\/]/.test(copyState.path) ? copyState.path.slice(0, 3) : '';
    driveSelect.innerHTML = drives.map((drive) => {
      const letter = drive.root.charAt(0).toUpperCase();
      const label = drive.label && drive.label !== letter ? drive.root + ' ' + drive.label : drive.root;
      return `<option value="${esc(drive.root)}"${drive.root.toUpperCase() === currentRoot.toUpperCase() ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
    driveSelect.onchange = () => loadCopyDir(driveSelect.value);
  } else {
    driveSelect.style.display = 'none';
  }
  document.getElementById('copy-new').style.display = target.kind === 'remote' ? '' : 'none';
  const rows = copyState.entries
    .map((entry) => `<div class="copy-row" data-name="${esc(entry.name)}" title="单击进入">${ICONS.folder}<span>${esc(entry.name)}</span></div>`)
    .join('');
  list.innerHTML = rows || '<div class="empty">没有子目录，可直接复制到当前目录</div>';
  list.querySelectorAll('.copy-row').forEach((row) => {
    row.onclick = () => loadCopyDir(joinTargetPath(copyState.path, row.dataset.name));
  });
}

function joinTargetPath(base, name) {
  if (!base) return name;
  if (copyState && copyState.target.kind === 'local') return joinLocal(base, name);
  return base.replace(/\/+$/, '') + '/' + name;
}

function copyParentPath(path) {
  if (!path) return '';
  if (copyState && copyState.target.kind === 'local') {
    const value = String(path).replace(/[\\/]+$/, '');
    const index = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
    if (index <= 2) return value.slice(0, 3);
    return value.slice(0, index);
  }
  const value = String(path).replace(/\/+$/, '');
  const index = value.lastIndexOf('/');
  return index > 0 ? value.slice(0, index) : '';
}

function copyUp() {
  if (!copyState) return;
  loadCopyDir(copyParentPath(copyState.path));
}

async function createCopyDir() {
  if (!copyState || copyState.target.kind !== 'remote') return;
  const name = await askInput('新建文件夹名称', '');
  if (!name) return;
  const target = copyState.target.name + ':' + joinTargetPath(copyState.path, name);
  try {
    await api().Mkdir(target);
    await loadCopyDir(copyState.path);
    toast('已创建：' + name);
  } catch (err) { notify('创建失败：' + err, true); }
}

async function confirmCopy() {
  if (!copyState) return;
  const { source, target, path } = copyState;
  closeCopyDialog();
  await performCopy(source, target, path);
}

async function performCopy(source, target, path) {
  const label = target.kind === 'local' ? path : `${target.name}:${path || '/'}`;
  if (target.kind === 'local') {
    if (source.kind === 'remoteFile') { await copyRemotePathsToLocal(source.paths, path); return; }
    if (source.kind === 'remoteDir') {
      // 保留目录本身的名字：复制文件夹到 D:\x 时落到 D:\x\<文件夹名>。
      const name = source.paths[0].split('/').filter(Boolean).pop() || 'folder';
      const dest = joinLocal(path, name);
      setStatus(`正在复制目录到 ${dest} …`);
      try {
        await api().DownloadFolder(source.paths[0], dest);
        if (state.view === 'local' && state.localView.path === path) await loadLocalView(path);
        notify('目录已复制到 ' + dest);
      } catch (err) { notify('复制失败：' + err, true); }
      return;
    }
    notify('此电脑内部暂不支持复制', true);
    return;
  }
  const remoteDir = target.name + ':' + path;
  if (source.kind === 'remoteFile') { await copyRemotePathsTo(source.paths, remoteDir, label); return; }
  if (source.kind === 'remoteDir') {
    setStatus(`正在复制目录到 ${label} …`);
    try {
      const dest = await api().CopyRemoteDir(source.paths[0], remoteDir);
      await refreshAfterRemoteWrite(remoteDir);
      notify('目录已复制到 ' + dest);
    } catch (err) { notify('复制失败：' + err, true); }
    return;
  }
  await uploadPathsTo(source.paths, target.name, remoteDir, label);
}

function refreshAfterRemoteWrite(dir) {
  const name = dir.split(':')[0];
  if (name === state.active && state.view === 'remote') return loadEntries();
  if (tabCache[name]) cacheOf(name).loaded = false;
  return Promise.resolve();
}

// copyRemotePathsTo 把多个远程文件复制到另一个远程目录。
async function copyRemotePathsTo(paths, dir, label) {
  setStatus(`正在复制 ${paths.length} 个文件到 ${label} …`);
  let ok = 0, fail = 0, firstError = '';
  for (const path of paths) {
    try { await api().CopyRemote(path, dir); ok++; }
    catch (err) { fail++; if (!firstError) firstError = String(err); }
  }
  const targetName = dir.split(':')[0];
  if (targetName === state.active) await loadEntries();
  else if (tabCache[targetName]) cacheOf(targetName).loaded = false;
  const detail = fail && firstError ? '：' + firstError : '';
  notify(`复制到 ${label}：成功 ${ok}，失败 ${fail}${detail}`, fail > 0);
}

// copyRemotePathsToLocal 把多个远程文件下载到此电脑的指定目录。
async function copyRemotePathsToLocal(paths, dir) {
  setStatus(`正在下载 ${paths.length} 个文件到 ${dir} …`);
  let ok = 0, fail = 0, firstError = '';
  for (const path of paths) {
    try { await api().Download(path, dir); ok++; }
    catch (err) { fail++; if (!firstError) firstError = String(err); }
  }
  if (state.view === 'local' && state.localView.path === dir) await loadLocalView(dir);
  const detail = fail && firstError ? '：' + firstError : '';
  notify(`下载到 ${dir}：成功 ${ok}，失败 ${fail}${detail}`, fail > 0);
}

// uploadPathsTo 把多个本地文件上传到指定页签，并刷新目标。
async function uploadPathsTo(paths, targetName, remoteDir, label) {
  setStatus(`正在上传 ${paths.length} 个文件 …`);
  let ok = 0, fail = 0, firstError = '';
  for (const path of paths) {
    try { await api().UploadPath(remoteDir, path); ok++; }
    catch (err) { fail++; if (!firstError) firstError = String(err); }
  }
  if (targetName === state.active) await loadEntries();
  else if (tabCache[targetName]) cacheOf(targetName).loaded = false;
  const detail = fail && firstError ? '：' + firstError : '';
  notify(`上传到 ${label || remoteDir} 完成：成功 ${ok}，失败 ${fail}${detail}`, fail > 0);
}

// uploadPaths 把本地文件复制到远程：弹出目标选择框，默认目标为当前页签的目录。
async function uploadPaths(paths) {
  if (!paths.length) return;
  const source = {
    kind: 'local',
    paths,
    title: paths.length > 1 ? paths.length + ' 个文件' : (paths[0].split(/[\\/]/).filter(Boolean).pop() || ''),
  };
  const target = currentCopyTarget();
  if (target.kind === 'local') { notify('请先打开一个远程连接再上传', true); return; }
  await openCopyPicker(source, target);
}

// uploadFiles 打开多选文件对话框，选择目标连接与目录后复制过去。
async function uploadFiles() {
  if (state.view === 'local') { notify('请先切换到远程页签', true); return; }
  const files = await api().PickFiles();
  if (!files || !files.length) return;
  const source = {
    kind: 'local',
    paths: files,
    title: files.length > 1 ? files.length + ' 个文件' : (files[0].split(/[\\/]/).filter(Boolean).pop() || ''),
  };
  await openCopyPicker(source, currentCopyTarget());
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
        <span class="del" data-del="${index}">${ICONS.close}</span></div>`).join('')
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

async function applyACL(acl) {
  if (!policy.bucket || !state.active) return;
  const label = acl === 'private' ? '私有' : '公共只读';
  if (!confirm('确认将桶 ' + policy.bucket + ' 的 ACL 设为' + label + '？')) return;
  try {
    await api().SetACL(state.active, policy.bucket, acl);
    notify('ACL 已更新为' + label);
    const aclInfo = await api().GetACL(state.active, policy.bucket);
    document.getElementById('policy-acl').textContent = '所有者：' + (aclInfo.owner || '未知') + '；授权条目：' + (aclInfo.grants ? aclInfo.grants.length : 0);
  } catch (err) { notify('设置 ACL 失败：' + err, true); }
}

async function savePolicy() {
  try {
    await api().PutPolicy(state.active, policy.bucket, buildPolicy());
    document.getElementById('policy-dialog').close();
    notify('策略已保存');
  } catch (err) { notify('保存策略失败：' + err, true); }
}

function exportJson() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  document.getElementById('export-name').value = `OssManager-连接-${stamp}.json`;
  document.getElementById('export-secrets').checked = false;
  document.getElementById('export-settings').checked = true;
  document.getElementById('export-dialog').showModal();
}

async function confirmExport() {
  const name = document.getElementById('export-name').value.trim() || 'OssManager-连接.json';
  const includeSecrets = document.getElementById('export-secrets').checked;
  const includeSettings = document.getElementById('export-settings').checked;
  document.getElementById('export-dialog').close();
  const path = await api().PickSaveFile(name);
  if (!path) return;
  try { await api().ExportConnections(path, includeSecrets, includeSettings); notify('已导出到 ' + path); }
  catch (err) { notify('导出失败：' + err, true); }
}

let importTarget = '';

async function importJson() {
  const path = await api().PickFile();
  if (!path) return;
  importTarget = path;
  document.getElementById('import-path').textContent = path;
  document.getElementById('import-settings').checked = false;
  document.getElementById('import-dialog').showModal();
}

async function confirmImport() {
  if (!importTarget) return;
  const applySettings = document.getElementById('import-settings').checked;
  document.getElementById('import-dialog').close();
  try {
    const message = await api().ImportConnections(importTarget, applySettings);
    if (applySettings) {
      state.settings = await api().GetSettings();
      applyTheme();
    }
    await refresh();
    notify(message);
  } catch (err) { notify('导入失败：' + err, true); }
}

async function openHistory() {
  try {
    const running = await refreshDownloadList();
    document.getElementById('history-dialog').showModal();
    if (running) startTaskRefresh();
  } catch (err) { notify('读取传输记录失败：' + err, true); }
}

let taskTimer = null;

function startTaskRefresh() {
  stopTaskRefresh();
  taskTimer = setInterval(refreshDownloadList, 800);
}

function stopTaskRefresh() {
  if (taskTimer) { clearInterval(taskTimer); taskTimer = null; }
}

function fmtElapsed(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

// refreshDownloadList 把正在下载、失败任务与历史记录合成同一个列表，按时间倒序展示。
async function refreshDownloadList() {
  let tasks = [];
  let records = [];
  try { tasks = (await api().DownloadTasks()) || []; } catch (err) { /* 任务表不可用时只显示历史 */ }
  try { records = (await api().DownloadHistory()) || []; } catch (err) { /* 历史不可用时只显示任务 */ }
  // 已完成任务已由后端写入历史记录，这里只保留运行中与失败的任务，避免重复。
  const pending = tasks.filter((task) => task.status !== 'done');
  const running = pending.filter((task) => task.status === 'running');
  document.getElementById('task-count').textContent = running.length ? `正在下载 ${running.length} 个` : '';
  const items = [
    ...pending.map((task) => ({
      time: task.started,
      name: task.name,
      percent: task.total > 0 ? Math.min(100, Math.round((task.done / task.total) * 100)) : 0,
      status: task.status,
      size: task.status === 'running' ? `${fmtSize(task.done)} / ${fmtSize(task.total)}` : fmtSize(task.total),
      speed: task.status === 'running' ? `${fmtSize(task.speed)}/s` : '',
      elapsed: task.status === 'running' ? '已用 ' + fmtElapsed(task.elapsedMs) : (task.elapsedMs ? '耗时 ' + fmtElapsed(task.elapsedMs) : ''),
      error: task.error || '',
      remote: task.path || '',
      localPath: task.localPath || '',
    })),
    ...records.map((record) => ({
      time: record.time,
      name: record.name,
      percent: 100,
      status: 'done',
      size: record.size ? fmtSize(record.size) : '目录',
      speed: '',
      elapsed: '',
      error: '',
      remote: record.path || '',
      localPath: record.localPath || '',
    })),
  ];
  items.sort((left, right) => String(right.time).localeCompare(String(left.time)));
  // 没有进行中的任务时停止轮询，避免持续重建表格导致选择与焦点抖动。
  if (!running.length) stopTaskRefresh();
  const host = document.getElementById('download-list');
  if (!items.length) { host.innerHTML = '<div class="empty">还没有传输记录</div>'; return running.length; }
  const rows = items.map((item, index) => {
    const status = item.status === 'running'
      ? `下载中 ${item.percent}%`
      : item.status === 'error' ? '失败' : '已完成';
    const badgeClass = item.status === 'running' ? '' : item.status === 'error' ? ' error' : ' done';
    const bar = item.status === 'running'
      ? `<div class="hbar"><div class="hfill" style="width:${item.percent}%"></div></div>`
      : '';
    const detail = [item.speed, item.elapsed].filter(Boolean).join(' · ');
    const error = item.error ? `<div class="herr" title="${esc(item.error)}">${esc(item.error)}</div>` : '';
    return `<tr class="hrow" data-path="${esc(item.localPath)}" data-remote="${esc(item.remote)}">
      <td class="hname" title="${esc(item.remote || item.name)}">${esc(item.name)}${bar}${error}</td>
      <td class="hstatus"><span class="badge${badgeClass}">${status}</span></td>
      <td class="hsize">${esc(item.size)}${detail ? `<div class="hdetail">${esc(detail)}</div>` : ''}</td>
      <td class="htime">${esc(item.time)}</td>
      <td class="hremote" title="${esc(item.remote)}">${esc(item.remote)}</td>
      <td class="hpath" title="${esc(item.localPath)}">${esc(item.localPath)}</td>
      <td class="hops"><button id="transfer-open-${index}" data-open="1" title="在连接中打开并定位">${ICONS.pin}</button><button id="transfer-del-${index}" data-del="1" class="danger-op" title="删除记录">${ICONS.trash}</button></td>
    </tr>`;
  }).join('');
  host.innerHTML = `<table class="history-table">
    <colgroup><col style="width:170px"><col style="width:70px"><col style="width:130px"><col style="width:120px"><col style="width:200px"><col style="width:200px"><col style="width:62px"></colgroup>
    <thead><tr><th>名称</th><th>状态</th><th>大小 / 速度</th><th>时间</th><th>连接位置</th><th>本地路径</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  host.querySelectorAll('.hrow').forEach((node) => {
    const path = node.dataset.path;
    const remote = node.dataset.remote;
    const open = node.querySelector('button[data-open]');
    if (open) open.onclick = (e) => { e.stopPropagation(); openTransferInConnection(remote); };
    const remove = node.querySelector('button[data-del]');
    if (remove) remove.onclick = async (e) => { e.stopPropagation(); await deleteDownloadRecord(path); };
    node.ondblclick = () => (remote ? openTransferInConnection(remote) : openDownloadLocation(path));
    node.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        ...(remote ? [{ label: '在连接中打开并定位', action: () => openTransferInConnection(remote) }] : []),
        { label: '在资源管理器中定位', action: () => openDownloadLocation(path) },
        ...(remote ? [{ label: '复制远程路径', action: () => { api().SetClipboard(remote); notify('已复制：' + remote); } }] : []),
        ...(path ? [{ label: '复制本地路径', action: () => { api().SetClipboard(path); notify('已复制：' + path); } }] : []),
        { separator: true },
        ...(path ? [{ label: '删除记录…', danger: true, action: () => deleteDownloadRecord(path) }] : []),
      ]);
    };
  });
  return running.length;
}

// openDownloadLocation 在资源管理器中定位到文件。
function openDownloadLocation(path) {
  if (!path) { notify('没有本地路径', true); return; }
  api().RevealInExplorer(path).catch((err) => notify('打开失败：' + err, true));
}

// openTransferInConnection 在对应连接中打开文件所在目录，并选中定位到文件。
function openTransferInConnection(remotePath) {
  const value = String(remotePath || '');
  const colon = value.indexOf(':');
  if (colon <= 0) { notify('这条记录没有远程路径', true); return; }
  const name = value.slice(0, colon);
  if (!state.connections.some((conn) => conn.name === name)) {
    notify('连接已不存在：' + name, true);
    return;
  }
  const rest = value.slice(colon + 1).replace(/^\//, '');
  const slash = rest.lastIndexOf('/');
  const file = slash >= 0 ? rest.slice(slash + 1) : rest;
  const dir = slash >= 0 ? rest.slice(0, slash) : '';
  const dialog = document.getElementById('history-dialog');
  if (dialog.open) dialog.close();
  stopTaskRefresh();
  openTab(name);
  state.active = name;
  state.view = 'remote';
  pendingSelect = file ? { file, path: dir } : null;
  navigateRemote(dir);
  renderTabs();
}

// 删除传输记录，可勾选同时删除本地文件。
async function deleteDownloadRecord(path) {
  if (!path) return;
  const result = await showConfirm({
    title: '删除传输记录',
    text: path,
    okText: '删除记录',
    checkboxLabel: '同时删除本地文件',
  });
  if (!result.ok) return;
  try {
    await api().RemoveDownload(path, result.checked);
    await refreshDownloadList();
    notify(result.checked ? '记录与本地文件已删除' : '记录已删除');
  } catch (err) { notify('删除失败：' + err, true); }
}

async function clearHistory() {
  const result = await showConfirm({
    title: '清空传输记录',
    text: '全部传输记录将被清空，正在传输的任务不受影响。',
    okText: '清空',
  });
  if (!result.ok) return;
  try {
    await api().ClearDownloadHistory();
    await api().ClearDownloadTasks();
    await refreshDownloadList();
    notify('已清空传输记录');
  } catch (err) { notify('清空失败：' + err, true); }
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
      <p>连接内核版本：${esc(info.rcloneVersion)}</p>
      <p>连接配置：${esc(info.configPath)}</p>
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

// openSettings 打开设置对话框并回填当前值。
async function openSettings() {
  const s = state.settings;
  document.getElementById('set-config').value = s.rcloneConfig || '';
  document.getElementById('set-startup-view').value = s.startupView || 'home';
  document.getElementById('set-filemanager').value = s.fileManager || '';
  document.getElementById('set-cache-dir').value = s.cacheDirectory || '';
  document.getElementById('set-dir-cache').value = s.dirCacheTime || '';
  document.getElementById('set-cache-size').value = s.vfsCacheMaxSize || '';
  document.getElementById('set-cache-age').value = s.vfsCacheMaxAge || '';
  document.getElementById('set-buffer').value = s.bufferSize || '';
  document.getElementById('set-transfers').value = s.maxConcurrentTransfers || 4;
  document.getElementById('set-streams').value = s.downloadStreams || 4;
  document.getElementById('set-autosize').checked = !!s.autoSizeEnabled;
  document.getElementById('set-autosize-delay').value = s.autoSizeDelay ?? 5;
  document.getElementById('set-autosize-interval').value = s.autoSizeInterval ?? 2;
  document.getElementById('set-download-dir').value = s.downloadDirectory || '';
  document.getElementById('set-drag-mode').value = s.dragMode || 'shell';
  document.getElementById('set-auto-update').checked = s.autoUpdate !== false;
  document.getElementById('set-update-state').textContent = '';
  document.getElementById('settings-dialog').showModal();
  refreshUpdateState();
}

async function exportBundle() {
  const path = await api().PickSaveFile('ossmanager-config.zip');
  if (!path) return;
  try { const msg = await api().ExportBundle(path); notify(msg); }
  catch (err) { notify('导出配置包失败：' + err, true); }
}

async function importBundle() {
  const path = await api().PickFile();
  if (!path) return;
  if (!confirm('导入配置包将覆盖当前设置、连接配置与挂载记录（原文件备份为 .bak），继续？')) return;
  try {
    const msg = await api().ImportBundle(path);
    state.settings = await api().GetSettings();
    openSettings();
    await refresh();
    notify(msg);
  } catch (err) { notify('导入配置包失败：' + err, true); }
}

async function saveSettings(closeAfter = false) {
  const next = {
    ...state.settings,
    rcloneConfig: document.getElementById('set-config').value.trim(),
    startupView: document.getElementById('set-startup-view').value,
    fileManager: document.getElementById('set-filemanager').value.trim(),
    cacheDirectory: document.getElementById('set-cache-dir').value.trim(),
    dirCacheTime: document.getElementById('set-dir-cache').value.trim(),
    vfsCacheMaxSize: document.getElementById('set-cache-size').value.trim(),
    vfsCacheMaxAge: document.getElementById('set-cache-age').value.trim(),
    bufferSize: document.getElementById('set-buffer').value.trim(),
    maxConcurrentTransfers: parseInt(document.getElementById('set-transfers').value, 10) || 4,
    downloadStreams: Math.min(16, Math.max(1, parseInt(document.getElementById('set-streams').value, 10) || 4)),
    autoSizeEnabled: document.getElementById('set-autosize').checked,
    autoSizeDelay: Math.min(60, Math.max(0, parseInt(document.getElementById('set-autosize-delay').value, 10) || 0)),
    autoSizeInterval: Math.min(60, Math.max(0, parseInt(document.getElementById('set-autosize-interval').value, 10) || 0)),
    downloadDirectory: document.getElementById('set-download-dir').value.trim(),
    dragMode: document.getElementById('set-drag-mode').value,
    autoUpdate: document.getElementById('set-auto-update').checked,
  };
  try {
    await api().SaveSettings(next);
    state.settings = next;
    updateAutoSizeButton();
    await refresh();
    if (closeAfter) document.getElementById('settings-dialog').close();
    notify(closeAfter ? '设置已保存并关闭' : '设置已保存');
  } catch (err) { setStatus('保存设置失败：' + err, true); }
}

// ===== 通用确认框：与主题一致的删除确认，替代系统原生 confirm =====
let confirmResolve = null;

function showConfirm({ title, text, okText = '删除', checkboxLabel = '', okDanger = true }) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-text').textContent = text || '';
    const ok = document.getElementById('confirm-ok');
    ok.textContent = okText;
    // 删除类操作使用红色实心按钮；普通确认使用主题色。
    ok.className = okDanger ? 'danger-solid' : 'primary';
    const checkRow = document.getElementById('confirm-check-row');
    const check = document.getElementById('confirm-check');
    check.checked = false;
    document.getElementById('confirm-check-label').textContent = checkboxLabel;
    checkRow.style.display = checkboxLabel ? 'flex' : 'none';
    document.getElementById('confirm-dialog').showModal();
  });
}

function finishConfirm(ok) {
  const resolve = confirmResolve;
  confirmResolve = null;
  const dialog = document.getElementById('confirm-dialog');
  const checked = document.getElementById('confirm-check').checked;
  if (dialog.open) dialog.close();
  if (resolve) resolve({ ok, checked });
}

boot();
