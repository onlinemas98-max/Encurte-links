/**
 * analytics.js
 * Motor de estatísticas, gráficos SVG responsivos, histórico de acessos,
 * CRUD administrativo, CSV, Backup/Restore e autenticação segura para admin.html.
 */
import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  query,
  orderBy,
  onSnapshot,
  writeBatch,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';
import {
  db,
  testConnection,
  handleFirestoreError,
  OperationType,
  loginWithGoogle,
  logoutAccount,
  subscribeAuth,
} from './firebase-config.js';
import {
  validateHttpUrl,
  buildShortUrl,
  copyToClipboard,
  formatDateBR,
  showToast,
  escapeHtml,
  downloadProjectZip,
  createShortLinkInFirestore,
  deleteLinkAndClicks,
} from './script.js';

const PRIMARY_ADMIN_EMAIL = 'onlinemakting590@gmail.com';
const PASSCODE_SESSION_KEY = 'lp_admin_unlocked_uid';

// ==========================================================================
// Utilitários de Segurança Web Crypto (SHA-256 + Salt)
// ==========================================================================

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateSaltHex(len = 16) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sha256Salted(passcode, salt) {
  const data = new TextEncoder().encode(`${salt}:${passcode}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

// ==========================================================================
// Helpers de Data e Formatação
// ==========================================================================

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseClickDate(click) {
  if (click.clickedAt && typeof click.clickedAt.toDate === 'function') {
    return click.clickedAt.toDate();
  }
  if (click.dateKey) {
    const [y, m, d] = click.dateKey.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1, Number(click.hour || 0), 0, 0);
  }
  return new Date();
}

function formatTimeBR(click) {
  const d = parseClickDate(click);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatShortDay(dateKey) {
  const parts = dateKey.split('-');
  if (parts.length !== 3) return dateKey;
  return `${parts[2]}/${parts[1]}`;
}

function getLastNDaysKeys(n) {
  const keys = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    keys.push(toDateKey(d));
  }
  return keys;
}

function translateDevice(device) {
  if (device === 'mobile') return 'Celular';
  if (device === 'tablet') return 'Tablet';
  return 'Computador';
}

// ==========================================================================
// Gráficos SVG Responsivos em JavaScript Puro
// ==========================================================================

function renderDailyLineChart(container, dayCounts) {
  if (!container) return;
  if (!dayCounts.length) {
    container.innerHTML = '<div class="empty-state"><p>Sem dados suficientes para exibir o gráfico diário.</p></div>';
    return;
  }

  const width = 680;
  const height = 240;
  const pad = { top: 20, right: 16, bottom: 34, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxVal = Math.max(4, ...dayCounts.map((d) => d.count));
  const stepX = dayCounts.length > 1 ? plotW / (dayCounts.length - 1) : plotW;

  const points = dayCounts.map((item, idx) => {
    const x = pad.left + (dayCounts.length === 1 ? plotW / 2 : idx * stepX);
    const y = pad.top + plotH - (item.count / maxVal) * plotH;
    return { ...item, x, y };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${(pad.top + plotH).toFixed(1)} L ${points[0].x.toFixed(1)} ${(pad.top + plotH).toFixed(1)} Z`;

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = pad.top + plotH - ratio * plotH;
    const val = Math.round(ratio * maxVal);
    return `
      <line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-dasharray="3 3" />
      <text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#64748b" font-family="JetBrains Mono, monospace">${val}</text>
    `;
  }).join('');

  const labelStep = Math.max(1, Math.ceil(points.length / 7));
  const xLabels = points
    .filter((_, idx) => idx % labelStep === 0 || idx === points.length - 1)
    .map((p) => `<text x="${p.x.toFixed(1)}" y="${height - 10}" text-anchor="middle" font-size="11" fill="#64748b">${formatShortDay(p.dateKey)}</text>`)
    .join('');

  const dots = points
    .map(
      (p) => `
      <circle
        class="chart-point"
        cx="${p.x.toFixed(1)}"
        cy="${p.y.toFixed(1)}"
        r="4.5"
        fill="#2563eb"
        stroke="#ffffff"
        stroke-width="2"
        data-tip="${escapeHtml(`${formatShortDay(p.dateKey)}: ${p.count} clique${p.count === 1 ? '' : 's'}`)}"
        style="cursor: pointer;"
      />`
    )
    .join('');

  container.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Gráfico de cliques por dia">
      <defs>
        <linearGradient id="blueAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2563eb" stop-opacity="0.20" />
          <stop offset="100%" stop-color="#2563eb" stop-opacity="0.01" />
        </linearGradient>
      </defs>
      ${gridLines}
      <path d="${areaPath}" fill="url(#blueAreaGrad)" />
      <path d="${linePath}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
      ${xLabels}
      ${dots}
    </svg>
    <div class="chart-tooltip hidden"></div>
  `;

  attachChartTooltips(container);
}

function renderHourlyBarChart(container, hourCounts) {
  if (!container) return;
  const width = 680;
  const height = 240;
  const pad = { top: 20, right: 12, bottom: 34, left: 38 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxVal = Math.max(4, ...hourCounts);
  const slotW = plotW / 24;
  const barW = Math.max(6, slotW - 5);

  const gridLines = [0, 0.5, 1].map((ratio) => {
    const y = pad.top + plotH - ratio * plotH;
    const val = Math.round(ratio * maxVal);
    return `
      <line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-dasharray="3 3" />
      <text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#64748b" font-family="JetBrains Mono, monospace">${val}</text>
    `;
  }).join('');

  const bars = hourCounts
    .map((count, hr) => {
      const h = (count / maxVal) * plotH;
      const x = pad.left + hr * slotW + (slotW - barW) / 2;
      const y = pad.top + plotH - h;
      const hrLabel = `${String(hr).padStart(2, '0')}h`;
      const showLabel = hr % 3 === 0;
      return `
        <rect
          class="chart-point"
          x="${x.toFixed(1)}"
          y="${y.toFixed(1)}"
          width="${barW.toFixed(1)}"
          height="${Math.max(2, h).toFixed(1)}"
          rx="3"
          fill="${count > 0 ? '#2563eb' : '#cbd5e1'}"
          data-tip="${escapeHtml(`${hrLabel}–${String((hr + 1) % 24).padStart(2, '0')}h: ${count} acesso${count === 1 ? '' : 's'}`)}"
          style="cursor: pointer;"
        />
        ${showLabel ? `<text x="${(x + barW / 2).toFixed(1)}" y="${height - 10}" text-anchor="middle" font-size="11" fill="#64748b">${hrLabel}</text>` : ''}
      `;
    })
    .join('');

  container.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Gráfico de acessos por horário">
      ${gridLines}
      ${bars}
    </svg>
    <div class="chart-tooltip hidden"></div>
  `;

  attachChartTooltips(container);
}

function attachChartTooltips(container) {
  const tooltip = container.querySelector('.chart-tooltip');
  if (!tooltip) return;

  container.querySelectorAll('.chart-point').forEach((node) => {
    const show = () => {
      const rect = node.getBoundingClientRect();
      const parentRect = container.getBoundingClientRect();
      tooltip.textContent = node.getAttribute('data-tip') || '';
      tooltip.style.left = `${rect.left - parentRect.left + rect.width / 2}px`;
      tooltip.style.top = `${rect.top - parentRect.top}px`;
      tooltip.classList.remove('hidden');
    };
    const hide = () => tooltip.classList.add('hidden');
    node.addEventListener('mouseenter', show);
    node.addEventListener('mouseleave', hide);
    node.addEventListener('touchstart', show, { passive: true });
  });
}

function renderBreakdownList(container, items, emptyMessage = 'Sem dados no período') {
  if (!container) return;
  if (!items.length) {
    container.innerHTML = `<p style="font-size: 0.875rem; color: var(--text-muted);">${escapeHtml(emptyMessage)}</p>`;
    return;
  }

  const total = items.reduce((acc, i) => acc + i.count, 0) || 1;
  const max = Math.max(...items.map((i) => i.count), 1);

  container.innerHTML = items
    .map((item) => {
      const pct = Math.round((item.count / total) * 100);
      const widthPct = Math.max(4, Math.round((item.count / max) * 100));
      return `
        <div class="breakdown-item">
          <div class="breakdown-row">
            <span class="breakdown-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>
            <span class="breakdown-val">${item.count.toLocaleString('pt-BR')} (${pct}%)</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width: ${widthPct}%;"></div>
          </div>
        </div>
      `;
    })
    .join('');
}

// ==========================================================================
// Exportação CSV Segura (com UTF-8 BOM para Excel)
// ==========================================================================

function downloadCsv(filename, headers, rows) {
  const escapeCell = (val) => {
    const str = String(val ?? '').replace(/\r?\n/g, ' ');
    return `"${str.replace(/"/g, '""')}"`;
  };
  const csvLines = [
    headers.map(escapeCell).join(';'),
    ...rows.map((r) => r.map(escapeCell).join(';')),
  ];
  const blob = new Blob(['\uFEFF' + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ==========================================================================
// Controlador Principal do Painel Administrativo
// ==========================================================================

function initAdminPanel() {
  const authGate = document.getElementById('admin-auth-gate');
  const adminApp = document.getElementById('admin-app');
  const loginView = document.getElementById('auth-login-view');
  const passcodeView = document.getElementById('auth-passcode-view');
  const deniedView = document.getElementById('auth-denied-view');
  const authErrorBox = document.getElementById('auth-error-box');

  let currentUser = null;
  let allLinks = [];
  let allClicks = [];
  let securitySettings = { passcodeEnabled: false, passcodeHash: '', passcodeSalt: '' };
  let appName = 'LinkPulse';

  let unsubLinks = null;
  let unsubClicks = null;

  let activeSection = 'overview';
  let linkStatusFilter = 'all';
  let analyticsPeriod = '30';
  let pendingDeleteCode = null;

  const SECTION_TITLES = {
    overview: 'Visão geral',
    links: 'Meus links',
    analytics: 'Analytics',
    history: 'Histórico de acessos',
    settings: 'Configurações',
  };

  function showAuthError(msg) {
    if (!msg) {
      authErrorBox.classList.add('hidden');
      authErrorBox.textContent = '';
      return;
    }
    authErrorBox.textContent = msg;
    authErrorBox.classList.remove('hidden');
  }

  function showAuthView(view) {
    loginView.classList.toggle('hidden', view !== 'login');
    passcodeView.classList.toggle('hidden', view !== 'passcode');
    deniedView.classList.toggle('hidden', view !== 'denied');
  }

  async function verifyAdminAndUnlock(user) {
    showAuthError('');
    if (!user || !user.emailVerified) {
      authGate.classList.remove('hidden');
      adminApp.classList.add('hidden');
      showAuthView('login');
      return;
    }

    try {
      let isAdminUser = user.email === PRIMARY_ADMIN_EMAIL;
      if (!isAdminUser) {
        const adminDoc = await getDoc(doc(db, 'admins', user.uid));
        isAdminUser = adminDoc.exists();
      }

      if (!isAdminUser) {
        document.getElementById('auth-denied-text').textContent =
          `A conta ${user.email} não tem permissão administrativa.`;
        authGate.classList.remove('hidden');
        adminApp.classList.add('hidden');
        showAuthView('denied');
        return;
      }

      // Carrega configurações de marca e segurança
      const [pubSnap, secSnap] = await Promise.all([
        getDoc(doc(db, 'settings', 'public')),
        getDoc(doc(db, 'settings', 'security')),
      ]);

      if (pubSnap.exists() && pubSnap.data().appName) {
        applyAppName(pubSnap.data().appName);
      }

      if (secSnap.exists()) {
        securitySettings = secSnap.data();
      } else {
        securitySettings = { passcodeEnabled: false, passcodeHash: '', passcodeSalt: '' };
      }

      document.getElementById('settings-passcode-enabled').checked = Boolean(securitySettings.passcodeEnabled);

      const alreadyUnlocked = sessionStorage.getItem(PASSCODE_SESSION_KEY) === user.uid;
      if (securitySettings.passcodeEnabled && securitySettings.passcodeHash && !alreadyUnlocked) {
        authGate.classList.remove('hidden');
        adminApp.classList.add('hidden');
        showAuthView('passcode');
        return;
      }

      enterDashboard(user);
    } catch (err) {
      console.error(err);
      showAuthError('Erro ao verificar permissões no banco de dados. Tente novamente.');
    }
  }

  function applyAppName(name) {
    appName = name;
    document.querySelectorAll('.app-brand-name').forEach((el) => {
      el.textContent = name;
    });
    document.title = `Painel Administrativo — ${name}`;
    const input = document.getElementById('settings-app-name');
    if (input) input.value = name;
  }

  function enterDashboard(user) {
    authGate.classList.add('hidden');
    adminApp.classList.remove('hidden');

    const emailEl = document.getElementById('admin-user-email');
    const avatarEl = document.getElementById('admin-avatar-initials');
    const label = user.email || user.displayName || 'Admin';
    emailEl.textContent = label;
    avatarEl.textContent = label.slice(0, 2).toUpperCase();

    attachAdminListeners();
  }

  function detachAdminListeners() {
    if (unsubLinks) {
      unsubLinks();
      unsubLinks = null;
    }
    if (unsubClicks) {
      unsubClicks();
      unsubClicks = null;
    }
  }

  function attachAdminListeners() {
    detachAdminListeners();

    unsubLinks = onSnapshot(
      query(collection(db, 'links'), orderBy('createdAt', 'desc')),
      (snap) => {
        allLinks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        syncLinkSelectors();
        renderAllViews();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'links')
    );

    unsubClicks = onSnapshot(
      query(collection(db, 'clicks'), orderBy('clickedAt', 'desc')),
      (snap) => {
        allClicks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderAllViews();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'clicks')
    );
  }

  function syncLinkSelectors() {
    const analyticsSelect = document.getElementById('analytics-link-select');
    const historySelect = document.getElementById('history-link-filter');
    const prevAnalytics = analyticsSelect.value;
    const prevHistory = historySelect.value;

    const optionsHtml = ['<option value="ALL">Todos os links</option>']
      .concat(
        allLinks.map(
          (l) =>
            `<option value="${escapeHtml(l.code)}">${escapeHtml(l.title || l.code)} (/?c=${escapeHtml(l.code)})</option>`
        )
      )
      .join('');

    analyticsSelect.innerHTML = optionsHtml;
    historySelect.innerHTML = optionsHtml;

    if (allLinks.some((l) => l.code === prevAnalytics)) analyticsSelect.value = prevAnalytics;
    if (allLinks.some((l) => l.code === prevHistory)) historySelect.value = prevHistory;
  }

  function renderAllViews() {
    renderOverview();
    renderLinksTable();
    renderAnalytics();
    renderHistoryTable();
  }

  // ========================================================================
  // 1. Visão Geral
  // ========================================================================
  function renderOverview() {
    const todayKey = toDateKey(new Date());
    const last7Set = new Set(getLastNDaysKeys(7));
    const last30Set = new Set(getLastNDaysKeys(30));

    const totalLinks = allLinks.length;
    const activeLinks = allLinks.filter((l) => l.active).length;
    const totalClicks = allLinks.reduce((sum, l) => sum + Number(l.clickCount || 0), 0);

    let todayClicks = 0;
    let clicks7d = 0;
    let clicks30d = 0;

    for (const c of allClicks) {
      if (c.dateKey === todayKey) todayClicks++;
      if (last7Set.has(c.dateKey)) clicks7d++;
      if (last30Set.has(c.dateKey)) clicks30d++;
    }

    const bestLink = [...allLinks].sort((a, b) => Number(b.clickCount || 0) - Number(a.clickCount || 0))[0];

    document.getElementById('kpi-total-links').textContent = totalLinks.toLocaleString('pt-BR');
    document.getElementById('kpi-active-links').textContent = `${activeLinks} ativos no momento`;
    document.getElementById('kpi-total-clicks').textContent = totalClicks.toLocaleString('pt-BR');
    document.getElementById('kpi-today-clicks').textContent = todayClicks.toLocaleString('pt-BR');
    document.getElementById('kpi-7d-clicks').textContent = clicks7d.toLocaleString('pt-BR');
    document.getElementById('kpi-30d-clicks').textContent = clicks30d.toLocaleString('pt-BR');

    if (bestLink && Number(bestLink.clickCount || 0) > 0) {
      document.getElementById('kpi-best-link').textContent = bestLink.title || bestLink.code;
      document.getElementById('kpi-best-link-sub').textContent =
        `${Number(bestLink.clickCount).toLocaleString('pt-BR')} cliques · /?c=${bestLink.code}`;
    } else {
      document.getElementById('kpi-best-link').textContent = '—';
      document.getElementById('kpi-best-link-sub').textContent = 'Sem cliques registrados ainda';
    }

    // Gráfico dos últimos 14 dias
    const days14 = getLastNDaysKeys(14);
    const countMap = new Map(days14.map((k) => [k, 0]));
    for (const c of allClicks) {
      if (countMap.has(c.dateKey)) {
        countMap.set(c.dateKey, countMap.get(c.dateKey) + 1);
      }
    }
    const dayCounts = days14.map((k) => ({ dateKey: k, count: countMap.get(k) || 0 }));
    renderDailyLineChart(document.getElementById('overview-daily-chart'), dayCounts);

    // Top 5 links
    const top5 = [...allLinks]
      .sort((a, b) => Number(b.clickCount || 0) - Number(a.clickCount || 0))
      .slice(0, 5)
      .map((l) => ({
        label: `${l.title || l.code} (/?c=${l.code})`,
        count: Number(l.clickCount || 0),
      }));
    renderBreakdownList(document.getElementById('overview-top-links'), top5, 'Crie links para acompanhar o ranking.');
  }

  // ========================================================================
  // 2. Meus Links
  // ========================================================================
  function renderLinksTable() {
    const tbody = document.getElementById('admin-links-tbody');
    const emptyEl = document.getElementById('admin-links-empty');
    const search = (document.getElementById('admin-links-search').value || '').trim().toLowerCase();

    const filtered = allLinks.filter((l) => {
      if (linkStatusFilter === 'active' && !l.active) return false;
      if (linkStatusFilter === 'inactive' && l.active) return false;
      if (!search) return true;
      return (
        l.code.toLowerCase().includes(search) ||
        (l.title || '').toLowerCase().includes(search) ||
        l.originalUrl.toLowerCase().includes(search) ||
        (l.description || '').toLowerCase().includes(search)
      );
    });

    if (!filtered.length) {
      tbody.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }

    emptyEl.classList.add('hidden');
    tbody.innerHTML = filtered
      .map((l) => {
        const shortUrl = buildShortUrl(l.code);
        return `
          <tr>
            <td data-label="Nome / Destino">
              <div class="cell-title">${escapeHtml(l.title || l.code)}</div>
              <div class="cell-sub" title="${escapeHtml(l.originalUrl)}">${escapeHtml(l.originalUrl)}</div>
            </td>
            <td data-label="Link encurtado">
              <a href="${escapeHtml(shortUrl)}" target="_blank" rel="noopener noreferrer" class="mono" style="color: var(--blue-primary); font-size: 0.82rem; font-weight: 600;">/?c=${escapeHtml(l.code)}</a>
            </td>
            <td data-label="Status">
              <button type="button" class="btn btn-ghost btn-sm status-text ${l.active ? 'status-active' : 'status-inactive'}" data-action="toggle" data-code="${escapeHtml(l.code)}" title="Alternar status">
                ${l.active ? 'Ativo' : 'Desativado'}
              </button>
            </td>
            <td data-label="Cliques" class="num mono">${Number(l.clickCount || 0).toLocaleString('pt-BR')}</td>
            <td data-label="Criado em">${escapeHtml(formatDateBR(l.createdAt))}</td>
            <td data-label="Ações" class="num">
              <div class="row-actions">
                <button type="button" class="btn btn-soft btn-sm" data-action="copy" data-url="${escapeHtml(shortUrl)}">Copiar</button>
                <button type="button" class="btn btn-secondary btn-sm" data-action="stats" data-code="${escapeHtml(l.code)}">Estatísticas</button>
                <button type="button" class="btn btn-secondary btn-sm" data-action="edit" data-code="${escapeHtml(l.code)}">Editar</button>
                <button type="button" class="btn btn-danger btn-sm" data-action="delete" data-code="${escapeHtml(l.code)}">Excluir</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  // ========================================================================
  // 3. Analytics Detalhado
  // ========================================================================
  function renderAnalytics() {
    const selectedCode = document.getElementById('analytics-link-select').value;
    const validDays = analyticsPeriod === 'all' ? null : new Set(getLastNDaysKeys(Number(analyticsPeriod)));

    const scopedClicks = allClicks.filter((c) => {
      if (selectedCode !== 'ALL' && c.linkCode !== selectedCode) return false;
      if (validDays && !validDays.has(c.dateKey)) return false;
      return true;
    });

    // Gráfico diário
    let dayKeys = [];
    if (analyticsPeriod === '7' || analyticsPeriod === '30') {
      dayKeys = getLastNDaysKeys(Number(analyticsPeriod));
    } else {
      const uniqueDays = Array.from(new Set(scopedClicks.map((c) => c.dateKey))).sort();
      dayKeys = uniqueDays.length ? uniqueDays : getLastNDaysKeys(14);
    }

    const dayMap = new Map(dayKeys.map((k) => [k, 0]));
    const hourCounts = new Array(24).fill(0);
    const deviceMap = new Map();
    const browserMap = new Map();
    const locationMap = new Map();
    const linkMap = new Map();

    for (const c of scopedClicks) {
      if (dayMap.has(c.dateKey)) {
        dayMap.set(c.dateKey, dayMap.get(c.dateKey) + 1);
      }
      const hr = Number(c.hour);
      if (hr >= 0 && hr <= 23) hourCounts[hr]++;

      const devLabel = translateDevice(c.device);
      deviceMap.set(devLabel, (deviceMap.get(devLabel) || 0) + 1);

      const br = c.browser || 'Outro';
      browserMap.set(br, (browserMap.get(br) || 0) + 1);

      const loc = c.city && c.city !== 'Não identificada' ? `${c.country || 'Não identificado'} · ${c.city}` : c.country || 'Não identificado';
      locationMap.set(loc, (locationMap.get(loc) || 0) + 1);

      linkMap.set(c.linkCode, (linkMap.get(c.linkCode) || 0) + 1);
    }

    renderDailyLineChart(
      document.getElementById('analytics-daily-chart'),
      dayKeys.map((k) => ({ dateKey: k, count: dayMap.get(k) || 0 }))
    );

    renderHourlyBarChart(document.getElementById('analytics-hourly-chart'), hourCounts);

    const toSortedList = (map) =>
      Array.from(map.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);

    renderBreakdownList(document.getElementById('analytics-devices-list'), toSortedList(deviceMap));
    renderBreakdownList(document.getElementById('analytics-browsers-list'), toSortedList(browserMap));
    renderBreakdownList(document.getElementById('analytics-countries-list'), toSortedList(locationMap).slice(0, 8));

    // Comparação entre links
    const comparisonItems = allLinks
      .map((l) => ({
        label: `${l.title || l.code} (/?c=${l.code})`,
        count: analyticsPeriod === 'all' && selectedCode === 'ALL'
          ? Number(l.clickCount || 0)
          : linkMap.get(l.code) || 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    renderBreakdownList(
      document.getElementById('analytics-comparison-list'),
      comparisonItems,
      'Nenhum link com cliques neste filtro.'
    );
  }

  // ========================================================================
  // 4. Histórico de Acessos
  // ========================================================================
  function getFilteredHistoryClicks() {
    const linkFilter = document.getElementById('history-link-filter').value;
    const deviceFilter = document.getElementById('history-device-filter').value;
    return allClicks.filter((c) => {
      if (linkFilter !== 'ALL' && c.linkCode !== linkFilter) return false;
      if (deviceFilter !== 'ALL' && c.device !== deviceFilter) return false;
      return true;
    });
  }

  function renderHistoryTable() {
    const tbody = document.getElementById('history-tbody');
    const emptyEl = document.getElementById('history-empty');
    const rows = getFilteredHistoryClicks().slice(0, 200);

    if (!rows.length) {
      tbody.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }

    emptyEl.classList.add('hidden');
    tbody.innerHTML = rows
      .map((c) => {
        const loc = c.city && c.city !== 'Não identificada'
          ? `${c.country} · ${c.city}`
          : c.country || 'Não identificado';
        const origin = c.referer && c.referer !== 'Acesso direto'
          ? `${c.source} (${c.referer})`
          : c.source || 'Direto';

        return `
          <tr>
            <td data-label="Link acessado"><span class="mono" style="color: var(--blue-primary); font-weight: 600;">/?c=${escapeHtml(c.linkCode)}</span></td>
            <td data-label="Data" class="mono">${escapeHtml(formatShortDay(c.dateKey))}/${escapeHtml(c.dateKey.slice(0, 4))}</td>
            <td data-label="Horário" class="mono">${escapeHtml(formatTimeBR(c))}</td>
            <td data-label="Dispositivo">${escapeHtml(translateDevice(c.device))}</td>
            <td data-label="Navegador">${escapeHtml(c.browser || 'Outro')}</td>
            <td data-label="Localização">${escapeHtml(loc)}</td>
            <td data-label="Origem / Referer">${escapeHtml(origin)}</td>
          </tr>
        `;
      })
      .join('');
  }

  // ========================================================================
  // Navegação Lateral & Modais
  // ========================================================================
  function switchSection(section) {
    activeSection = section;
    document.querySelectorAll('.admin-section').forEach((el) => el.classList.add('hidden'));
    document.getElementById(`section-${section}`)?.classList.remove('hidden');

    document.querySelectorAll('.sidebar-nav .nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.section === section);
    });

    document.getElementById('topbar-section-title').textContent = SECTION_TITLES[section] || 'Painel';

    // Fecha drawer mobile ao navegar
    document.getElementById('admin-sidebar').classList.remove('mobile-open');
    document.getElementById('sidebar-overlay').classList.remove('active');
  }

  document.querySelectorAll('.sidebar-nav .nav-item[data-section]').forEach((btn) => {
    btn.addEventListener('click', () => switchSection(btn.dataset.section));
  });

  document.getElementById('sidebar-collapse-btn')?.addEventListener('click', () => {
    document.getElementById('admin-sidebar').classList.toggle('collapsed');
  });

  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  mobileMenuBtn?.addEventListener('click', () => {
    document.getElementById('admin-sidebar').classList.add('mobile-open');
    sidebarOverlay.classList.add('active');
  });
  sidebarOverlay?.addEventListener('click', () => {
    document.getElementById('admin-sidebar').classList.remove('mobile-open');
    sidebarOverlay.classList.remove('active');
  });

  // Modal Criar/Editar Link
  const linkModal = document.getElementById('admin-link-modal');
  const modalMode = document.getElementById('modal-mode');
  const modalTitleHeading = document.getElementById('admin-modal-title');
  const modalUrl = document.getElementById('modal-original-url');
  const modalCode = document.getElementById('modal-code');
  const modalTitle = document.getElementById('modal-title');
  const modalDesc = document.getElementById('modal-desc');
  const modalActive = document.getElementById('modal-active');

  function openCreateModal() {
    modalMode.value = 'create';
    modalTitleHeading.textContent = 'Novo Link Curto';
    modalUrl.value = '';
    modalCode.value = '';
    modalCode.disabled = false;
    modalTitle.value = '';
    modalDesc.value = '';
    modalActive.checked = true;
    linkModal.classList.remove('hidden');
    modalUrl.focus();
  }

  function openEditModal(link) {
    modalMode.value = 'edit';
    modalTitleHeading.textContent = `Editar Link (/?c=${link.code})`;
    modalUrl.value = link.originalUrl;
    modalCode.value = link.code;
    modalCode.disabled = true;
    modalTitle.value = link.title || '';
    modalDesc.value = link.description || '';
    modalActive.checked = Boolean(link.active);
    linkModal.classList.remove('hidden');
  }

  function closeLinkModal() {
    linkModal.classList.add('hidden');
  }

  document.getElementById('topbar-new-link-btn')?.addEventListener('click', openCreateModal);
  document.getElementById('links-new-btn')?.addEventListener('click', openCreateModal);
  document.getElementById('empty-create-link-btn')?.addEventListener('click', openCreateModal);
  document.getElementById('admin-modal-close')?.addEventListener('click', closeLinkModal);
  document.getElementById('admin-modal-cancel')?.addEventListener('click', closeLinkModal);

  document.getElementById('admin-link-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const check = validateHttpUrl(modalUrl.value);
    if (!check.valid) {
      showToast(check.error, 'error');
      return;
    }

    try {
      if (modalMode.value === 'create') {
        const created = await createShortLinkInFirestore({
          originalUrl: check.url,
          customCode: modalCode.value,
          title: modalTitle.value,
          description: modalDesc.value,
          ownerId: currentUser.uid,
        });
        if (!modalActive.checked) {
          await updateDoc(doc(db, 'links', created.code), {
            active: false,
            updatedAt: serverTimestamp(),
          });
        }
        showToast('Link criado com sucesso!', 'success');
      } else {
        const code = modalCode.value;
        await updateDoc(doc(db, 'links', code), {
          originalUrl: check.url,
          title: String(modalTitle.value || '').trim().slice(0, 120) || new URL(check.url).hostname,
          description: String(modalDesc.value || '').trim().slice(0, 400),
          active: modalActive.checked,
          updatedAt: serverTimestamp(),
        });
        showToast('Link atualizado!', 'success');
      }
      closeLinkModal();
    } catch (err) {
      showToast(err.message || 'Erro ao salvar link.', 'error');
    }
  });

  // Ações da tabela Meus Links
  const confirmDeleteModal = document.getElementById('confirm-delete-modal');
  function closeDeleteModal() {
    pendingDeleteCode = null;
    confirmDeleteModal.classList.add('hidden');
  }

  document.getElementById('delete-modal-close')?.addEventListener('click', closeDeleteModal);
  document.getElementById('delete-modal-cancel')?.addEventListener('click', closeDeleteModal);
  document.getElementById('delete-modal-confirm')?.addEventListener('click', async () => {
    if (!pendingDeleteCode) return;
    const code = pendingDeleteCode;
    closeDeleteModal();
    try {
      await deleteLinkAndClicks(code);
      showToast('Link e histórico excluídos.', 'success');
    } catch {
      showToast('Não foi possível excluir o link.', 'error');
    }
  });

  document.getElementById('admin-links-tbody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const code = btn.dataset.code;

    if (action === 'copy') {
      await copyToClipboard(btn.dataset.url);
      showToast('Link curto copiado!', 'success');
      return;
    }

    const link = allLinks.find((l) => l.code === code);
    if (!link) return;

    if (action === 'toggle') {
      try {
        await updateDoc(doc(db, 'links', code), {
          active: !link.active,
          updatedAt: serverTimestamp(),
        });
        showToast(link.active ? 'Link desativado.' : 'Link ativado!', 'success');
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `links/${code}`);
      }
      return;
    }

    if (action === 'stats') {
      document.getElementById('analytics-link-select').value = code;
      switchSection('analytics');
      renderAnalytics();
      return;
    }

    if (action === 'edit') {
      openEditModal(link);
      return;
    }

    if (action === 'delete') {
      pendingDeleteCode = code;
      document.getElementById('delete-modal-desc').textContent =
        `Deseja excluir permanentemente o link "/?c=${code}" (${link.title || link.originalUrl}) e todos os seus cliques?`;
      confirmDeleteModal.classList.remove('hidden');
    }
  });

  // Filtros de Links, Analytics e Histórico
  document.getElementById('admin-links-search')?.addEventListener('input', renderLinksTable);
  document.querySelectorAll('[data-link-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      linkStatusFilter = btn.dataset.linkFilter;
      document.querySelectorAll('[data-link-filter]').forEach((b) => b.classList.toggle('active', b === btn));
      renderLinksTable();
    });
  });

  document.getElementById('analytics-link-select')?.addEventListener('change', renderAnalytics);
  document.querySelectorAll('[data-period]').forEach((btn) => {
    btn.addEventListener('click', () => {
      analyticsPeriod = btn.dataset.period;
      document.querySelectorAll('[data-period]').forEach((b) => b.classList.toggle('active', b === btn));
      renderAnalytics();
    });
  });

  document.getElementById('history-link-filter')?.addEventListener('change', renderHistoryTable);
  document.getElementById('history-device-filter')?.addEventListener('change', renderHistoryTable);

  // ========================================================================
  // Configurações: Marca, Senha SHA-256, CSV, Backup, Restore & ZIP
  // ========================================================================
  document.getElementById('settings-brand-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newName = (document.getElementById('settings-app-name').value || '').trim();
    if (newName.length < 2 || newName.length > 60) {
      showToast('O nome deve ter entre 2 e 60 caracteres.', 'error');
      return;
    }
    try {
      await setDoc(doc(db, 'settings', 'public'), {
        appName: newName,
        updatedAt: serverTimestamp(),
      });
      applyAppName(newName);
      showToast('Nome do aplicativo atualizado!', 'success');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/public');
    }
  });

  document.getElementById('settings-security-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const enabled = document.getElementById('settings-passcode-enabled').checked;
    const rawPass = (document.getElementById('settings-new-passcode').value || '').trim();

    if (enabled && !rawPass && !securitySettings.passcodeHash) {
      showToast('Informe uma nova senha administrativa com pelo menos 4 caracteres.', 'error');
      return;
    }
    if (rawPass && rawPass.length < 4) {
      showToast('A senha administrativa deve ter pelo menos 4 caracteres.', 'error');
      return;
    }

    try {
      let passcodeSalt = securitySettings.passcodeSalt || '';
      let passcodeHash = securitySettings.passcodeHash || '';
      if (rawPass) {
        passcodeSalt = generateSaltHex(16);
        passcodeHash = await sha256Salted(rawPass, passcodeSalt);
      }
      await setDoc(doc(db, 'settings', 'security'), {
        passcodeHash,
        passcodeSalt,
        passcodeEnabled: enabled,
        updatedAt: serverTimestamp(),
        updatedBy: currentUser.uid,
      });
      securitySettings = { passcodeHash, passcodeSalt, passcodeEnabled: enabled };
      document.getElementById('settings-new-passcode').value = '';
      if (enabled) sessionStorage.setItem(PASSCODE_SESSION_KEY, currentUser.uid);
      showToast('Configurações de segurança salvas com criptografia SHA-256!', 'success');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/security');
    }
  });

  function exportLinksCsv() {
    const headers = ['Codigo', 'Nome', 'URL Original', 'URL Encurtada', 'Status', 'Cliques', 'Criado em'];
    const rows = allLinks.map((l) => [
      l.code,
      l.title || '',
      l.originalUrl,
      buildShortUrl(l.code),
      l.active ? 'Ativo' : 'Desativado',
      Number(l.clickCount || 0),
      formatDateBR(l.createdAt),
    ]);
    downloadCsv(`links-relatorio-${toDateKey(new Date())}.csv`, headers, rows);
    showToast('Relatório de links exportado em CSV!', 'success');
  }

  function exportClicksCsv(list = allClicks) {
    const headers = ['Link', 'Data', 'Horario', 'Dispositivo', 'Navegador', 'Sistema', 'Pais', 'Cidade', 'Origem', 'Referer'];
    const rows = list.map((c) => [
      `/?c=${c.linkCode}`,
      c.dateKey,
      formatTimeBR(c),
      translateDevice(c.device),
      c.browser,
      c.os,
      c.country,
      c.city,
      c.source,
      c.referer,
    ]);
    downloadCsv(`acessos-relatorio-${toDateKey(new Date())}.csv`, headers, rows);
    showToast('Histórico de acessos exportado em CSV!', 'success');
  }

  document.getElementById('export-links-csv-btn')?.addEventListener('click', exportLinksCsv);
  document.getElementById('export-clicks-csv-btn')?.addEventListener('click', () => exportClicksCsv(allClicks));
  document.getElementById('history-export-csv-btn')?.addEventListener('click', () => exportClicksCsv(getFilteredHistoryClicks()));

  // Backup JSON
  document.getElementById('backup-json-btn')?.addEventListener('click', () => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      appName,
      links: allLinks.map((l) => ({
        code: l.code,
        originalUrl: l.originalUrl,
        title: l.title || '',
        description: l.description || '',
        active: Boolean(l.active),
        clickCount: Number(l.clickCount || 0),
      })),
      clicks: allClicks.map((c) => ({
        linkCode: c.linkCode,
        dateKey: c.dateKey,
        hour: Number(c.hour || 0),
        device: c.device || 'desktop',
        browser: c.browser || 'Outro',
        os: c.os || 'Outro',
        country: c.country || 'Não identificado',
        city: c.city || 'Não identificada',
        source: c.source || 'Direto',
        referer: c.referer || 'Acesso direto',
      })),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `linkpulse-backup-${toDateKey(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Backup JSON baixado com sucesso!', 'success');
  });

  // Restaurar Backup JSON
  document.getElementById('restore-json-btn')?.addEventListener('click', async () => {
    const fileInput = document.getElementById('restore-json-input');
    const file = fileInput.files?.[0];
    if (!file) {
      showToast('Selecione um arquivo .json de backup primeiro.', 'error');
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.links)) {
        throw new Error('Formato de backup inválido.');
      }

      let restoredLinks = 0;
      const validCodes = new Set();

      for (const item of parsed.links) {
        const code = String(item.code || '').trim();
        const urlCheck = validateHttpUrl(item.originalUrl);
        if (!/^[a-zA-Z0-9_-]{3,40}$/.test(code) || !urlCheck.valid) continue;

        const ref = doc(db, 'links', code);
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          await setDoc(ref, {
            code,
            originalUrl: urlCheck.url,
            title: String(item.title || '').slice(0, 120) || code,
            description: String(item.description || '').slice(0, 400),
            active: item.active !== false,
            clickCount: Math.max(0, Math.floor(Number(item.clickCount || 0))),
            ownerId: currentUser.uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            lastClickedAt: serverTimestamp(),
          });
        } else {
          await updateDoc(ref, {
            originalUrl: urlCheck.url,
            title: String(item.title || '').slice(0, 120) || code,
            description: String(item.description || '').slice(0, 400),
            active: item.active !== false,
            updatedAt: serverTimestamp(),
          });
        }
        validCodes.add(code);
        restoredLinks++;
      }

      let restoredClicks = 0;
      if (Array.isArray(parsed.clicks)) {
        const validClicks = parsed.clicks.filter((c) => validCodes.has(String(c.linkCode || '').trim()));
        for (let i = 0; i < validClicks.length; i += 300) {
          const batch = writeBatch(db);
          for (const c of validClicks.slice(i, i + 300)) {
            const dev = ['mobile', 'tablet', 'desktop'].includes(c.device) ? c.device : 'desktop';
            const hr = Math.min(23, Math.max(0, Math.floor(Number(c.hour || 0))));
            const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(c.dateKey || '')) ? c.dateKey : toDateKey(new Date());
            batch.set(doc(collection(db, 'clicks')), {
              linkCode: String(c.linkCode).trim(),
              linkOwnerId: currentUser.uid,
              clickedAt: serverTimestamp(),
              dateKey,
              hour: hr,
              device: dev,
              browser: String(c.browser || 'Outro').slice(0, 40) || 'Outro',
              os: String(c.os || 'Outro').slice(0, 40) || 'Outro',
              country: String(c.country || 'Não identificado').slice(0, 80) || 'Não identificado',
              city: String(c.city || 'Não identificada').slice(0, 80) || 'Não identificada',
              source: String(c.source || 'Direto').slice(0, 60) || 'Direto',
              referer: String(c.referer || 'Acesso direto').slice(0, 200) || 'Acesso direto',
            });
            restoredClicks++;
          }
          await batch.commit();
        }
      }

      if (parsed.appName && String(parsed.appName).trim().length >= 2) {
        await setDoc(doc(db, 'settings', 'public'), {
          appName: String(parsed.appName).trim().slice(0, 60),
          updatedAt: serverTimestamp(),
        });
        applyAppName(String(parsed.appName).trim().slice(0, 60));
      }

      fileInput.value = '';
      showToast(`Restauração concluída: ${restoredLinks} links e ${restoredClicks} registros.`, 'success');
    } catch (err) {
      console.error(err);
      showToast('Falha ao restaurar o arquivo JSON. Verifique o formato.', 'error');
    }
  });

  // Download do Projeto ZIP
  const adminZipBtn = document.getElementById('admin-download-zip-btn');
  const settingsZipBtn = document.getElementById('settings-download-zip-btn');
  adminZipBtn?.addEventListener('click', () => downloadProjectZip(adminZipBtn));
  settingsZipBtn?.addEventListener('click', () => downloadProjectZip(settingsZipBtn));

  // Eventos do Portal de Autenticação
  document.getElementById('admin-google-login-btn')?.addEventListener('click', async () => {
    showAuthError('');
    try {
      await loginWithGoogle();
    } catch (err) {
      if (err && err.code === 'auth/popup-closed-by-user') return;
      showAuthError('Não foi possível autenticar com Google. Verifique se pop-ups estão liberados.');
    }
  });

  document.getElementById('auth-passcode-view')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    showAuthError('');
    const entered = document.getElementById('unlock-passcode-input').value || '';
    const candidateHash = await sha256Salted(entered, securitySettings.passcodeSalt);
    if (candidateHash === securitySettings.passcodeHash) {
      sessionStorage.setItem(PASSCODE_SESSION_KEY, currentUser.uid);
      document.getElementById('unlock-passcode-input').value = '';
      enterDashboard(currentUser);
    } else {
      showAuthError('Senha administrativa incorreta.');
    }
  });

  const handleLogout = async () => {
    detachAdminListeners();
    sessionStorage.removeItem(PASSCODE_SESSION_KEY);
    await logoutAccount();
  };

  document.getElementById('admin-logout-btn')?.addEventListener('click', handleLogout);
  document.getElementById('passcode-logout-btn')?.addEventListener('click', handleLogout);
  document.getElementById('denied-switch-btn')?.addEventListener('click', async () => {
    await handleLogout();
    await loginWithGoogle().catch(() => {});
  });

  testConnection();

  subscribeAuth((user) => {
    currentUser = user;
    if (!user) {
      detachAdminListeners();
      authGate.classList.remove('hidden');
      adminApp.classList.add('hidden');
      showAuthView('login');
      return;
    }
    verifyAdminAndUnlock(user);
  });
}

initAdminPanel();
