/**
 * script.js
 * Lógica principal da página inicial, validações, CRUD rápido e empacotamento ZIP puro em JS.
 */
import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  getDocs,
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

const CODE_REGEX = /^[a-zA-Z0-9_-]{3,40}$/;
const RESERVED_CODES = new Set(['admin', 'index', 'style', 'script', 'redirect', 'analytics', 'api', 'r']);

// ==========================================================================
// Utilitários Compartilhados
// ==========================================================================

export function validateHttpUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    return { valid: false, error: 'Informe uma URL para encurtar.' };
  }
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (normalized.length > 2048) {
    return { valid: false, error: 'A URL excede o limite máximo de 2048 caracteres.' };
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: 'Apenas links http:// ou https:// são permitidos.' };
    }
    if (!parsed.hostname || !parsed.hostname.includes('.')) {
      return { valid: false, error: 'Informe um domínio válido (ex: https://seusite.com).' };
    }
    // Previne loop infinito apontando para um link curto da própria plataforma
    if (
      parsed.hostname === window.location.hostname &&
      (parsed.searchParams.has('c') || /^\/r\/[a-zA-Z0-9_-]+/.test(parsed.pathname))
    ) {
      return { valid: false, error: 'Não é permitido encurtar um link que já pertence a este encurtador.' };
    }
    return { valid: true, url: parsed.toString() };
  } catch {
    return { valid: false, error: 'URL inválida. Verifique o endereço digitado.' };
  }
}

export function generateShortCode(length = 6) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

export function buildShortUrl(code) {
  return `${window.location.origin}/?c=${encodeURIComponent(code)}`;
}

export async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);
  return ok;
}

export function formatDateBR(ts) {
  if (!ts) return 'Agora';
  const date = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function showToast(message, type = 'default') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3400);
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ==========================================================================
// Empacotador ZIP Puro em JavaScript (CRC-32 + PKZIP Store sem dependências)
// ==========================================================================

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipFromEntries(entries) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  const now = new Date();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((now.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((Math.max(now.getFullYear(), 1980) - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const dataBytes = entry.content instanceof Uint8Array ? entry.content : encoder.encode(entry.content);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const localHeader = new ArrayBuffer(30 + nameBytes.length);
    const lv = new DataView(localHeader);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8
    lv.setUint16(8, 0, true); // Store (sem compressão)
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    new Uint8Array(localHeader, 30).set(nameBytes);

    localParts.push(new Uint8Array(localHeader), dataBytes);

    const centralHeader = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(centralHeader);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    new Uint8Array(centralHeader, 46).set(nameBytes);

    centralParts.push(new Uint8Array(centralHeader));
    offset += 30 + nameBytes.length + size;
  }

  let centralSize = 0;
  for (const part of centralParts) centralSize += part.length;

  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, new Uint8Array(eocd)], {
    type: 'application/zip',
  });
}

export async function downloadProjectZip(triggerBtn = null) {
  const files = [
    'index.html',
    'admin.html',
    'style.css',
    'script.js',
    'redirect.js',
    'analytics.js',
    'firebase-config.js',
    'firestore.rules',
    'firebase-blueprint.json',
    'README.md',
  ];

  const prevText = triggerBtn ? triggerBtn.textContent : '';
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = 'Gerando ZIP...';
  }

  try {
    const entries = [];
    for (const file of files) {
      let res = await fetch(`/source-files/${file}`);
      if (!res.ok) {
        res = await fetch(`/${file}`);
      }
      if (!res.ok) {
        throw new Error(`Não foi possível obter ${file}`);
      }
      const content = await res.text();
      entries.push({ name: `encurtador-links-pro/${file}`, content });
    }

    const zipBlob = buildZipFromEntries(entries);
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'encurtador-links-pro.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Arquivo encurtador-links-pro.zip baixado!', 'success');
  } catch (err) {
    console.error(err);
    showToast('Erro ao gerar o arquivo ZIP.', 'error');
  } finally {
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = prevText;
    }
  }
}

// ==========================================================================
// Criação e Gerenciamento de Links (Firestore)
// ==========================================================================

export async function createShortLinkInFirestore({ originalUrl, customCode, title, description, ownerId }) {
  const urlCheck = validateHttpUrl(originalUrl);
  if (!urlCheck.valid) {
    throw new Error(urlCheck.error);
  }

  let code = String(customCode || '').trim();
  if (code) {
    if (!CODE_REGEX.test(code)) {
      throw new Error('O código personalizado deve ter 3 a 40 caracteres (letras, números, "-" ou "_").');
    }
    if (RESERVED_CODES.has(code.toLowerCase())) {
      throw new Error('Este código é reservado pelo sistema. Escolha outro.');
    }
    const existing = await getDoc(doc(db, 'links', code));
    if (existing.exists()) {
      throw new Error('Este código personalizado já está em uso. Escolha outro.');
    }
  } else {
    // Gera código exclusivo verificando colisão
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = generateShortCode(6);
      const snap = await getDoc(doc(db, 'links', candidate));
      if (!snap.exists()) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      throw new Error('Não foi possível gerar um código exclusivo. Tente novamente.');
    }
  }

  const cleanTitle = String(title || '').trim().slice(0, 120) || new URL(urlCheck.url).hostname;
  const cleanDesc = String(description || '').trim().slice(0, 400);

  const path = `links/${code}`;
  try {
    await setDoc(doc(db, 'links', code), {
      code,
      originalUrl: urlCheck.url,
      title: cleanTitle,
      description: cleanDesc,
      active: true,
      clickCount: 0,
      ownerId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastClickedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }

  return {
    code,
    originalUrl: urlCheck.url,
    title: cleanTitle,
    description: cleanDesc,
    shortUrl: buildShortUrl(code),
  };
}

export async function deleteLinkAndClicks(code) {
  try {
    const clicksQuery = query(collection(db, 'clicks'), where('linkCode', '==', code));
    const clicksSnap = await getDocs(clicksQuery);
    const docsToDelete = clicksSnap.docs;

    // Exclui em lotes de até 400 operações
    for (let i = 0; i < docsToDelete.length; i += 400) {
      const batch = writeBatch(db);
      docsToDelete.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    await deleteDoc(doc(db, 'links', code));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `links/${code}`);
  }
}

// ==========================================================================
// Inicialização da Página Inicial (index.html)
// ==========================================================================

function initHomePage() {
  if (window.__IS_REDIRECTING__) return;
  const form = document.getElementById('shorten-form');
  if (!form) return;

  const urlInput = document.getElementById('url-input');
  const customCodeInput = document.getElementById('custom-code-input');
  const titleInput = document.getElementById('link-title-input');
  const descInput = document.getElementById('link-desc-input');
  const shortenBtn = document.getElementById('shorten-btn');
  const feedbackEl = document.getElementById('home-feedback');

  const resultPanel = document.getElementById('result-panel');
  const resultShortUrl = document.getElementById('result-short-url');
  const resultOriginalUrl = document.getElementById('result-original-url');
  const copyResultBtn = document.getElementById('copy-result-btn');
  const testResultLink = document.getElementById('test-result-link');

  const authStatusEl = document.getElementById('home-auth-status');
  const loginBtn = document.getElementById('home-login-btn');
  const logoutBtn = document.getElementById('home-logout-btn');
  const searchInput = document.getElementById('home-search-input');
  const linksContainer = document.getElementById('home-links-container');
  const zipBtn = document.getElementById('download-zip-btn');

  // Modal de edição rápida
  const editModal = document.getElementById('home-edit-modal');
  const editForm = document.getElementById('home-edit-form');
  const editCodeInput = document.getElementById('home-edit-code');
  const editUrlInput = document.getElementById('home-edit-url');
  const editNameInput = document.getElementById('home-edit-name');
  const editDescInput = document.getElementById('home-edit-desc');
  const editActiveInput = document.getElementById('home-edit-active');

  let currentUser = null;
  let allUserLinks = [];
  let unsubscribeLinks = null;

  function setFeedback(message, type = 'error') {
    if (!message) {
      feedbackEl.classList.add('hidden');
      feedbackEl.textContent = '';
      return;
    }
    feedbackEl.className = `alert-box ${type === 'success' ? 'alert-success' : type === 'info' ? 'alert-info' : 'alert-error'}`;
    feedbackEl.textContent = message;
    feedbackEl.classList.remove('hidden');
  }

  function loadAppBranding() {
    getDoc(doc(db, 'settings', 'public'))
      .then((snap) => {
        if (snap.exists() && snap.data().appName) {
          const name = snap.data().appName;
          document.querySelectorAll('.app-brand-name').forEach((el) => {
            el.textContent = name;
          });
          document.title = `${name} — Encurtador de Links & Analytics`;
        }
      })
      .catch(() => {});
  }

  function renderHomeLinks() {
    if (!currentUser) {
      linksContainer.innerHTML = `
        <div class="empty-state">
          <h4>Conecte sua conta para visualizar seus links</h4>
          <p>Seus links encurtados ficam salvos permanentemente no banco online para acesso em qualquer dispositivo.</p>
          <button id="empty-login-btn" type="button" class="btn btn-primary btn-sm">Entrar com Google</button>
        </div>
      `;
      const btn = document.getElementById('empty-login-btn');
      if (btn) btn.addEventListener('click', handleLogin);
      return;
    }

    const term = (searchInput.value || '').trim().toLowerCase();
    const filtered = allUserLinks.filter((item) => {
      if (!term) return true;
      return (
        item.code.toLowerCase().includes(term) ||
        item.title.toLowerCase().includes(term) ||
        item.originalUrl.toLowerCase().includes(term) ||
        (item.description || '').toLowerCase().includes(term)
      );
    });

    if (filtered.length === 0) {
      linksContainer.innerHTML = `
        <div class="empty-state">
          <h4>${term ? 'Nenhum link corresponde à pesquisa' : 'Você ainda não criou nenhum link'}</h4>
          <p>${term ? 'Tente buscar por outro termo ou código.' : 'Cole uma URL no campo acima e clique em ENCURTAR LINK.'}</p>
        </div>
      `;
      return;
    }

    linksContainer.innerHTML = filtered
      .slice(0, 12)
      .map((item) => {
        const shortUrl = buildShortUrl(item.code);
        const statusLabel = item.active ? 'Ativo' : 'Desativado';
        const statusClass = item.active ? 'status-active' : 'status-inactive';
        return `
          <div class="recent-link-row" data-code="${escapeHtml(item.code)}">
            <div class="link-row-info">
              <div class="link-row-title">${escapeHtml(item.title || item.code)}</div>
              <a href="${escapeHtml(shortUrl)}" target="_blank" rel="noopener noreferrer" class="link-row-short">${escapeHtml(shortUrl)}</a>
              <div class="link-row-meta">
                <span class="link-row-url" title="${escapeHtml(item.originalUrl)}">${escapeHtml(item.originalUrl)}</span>
                <span aria-hidden="true">·</span>
                <span class="tabular-nums"><strong>${Number(item.clickCount || 0).toLocaleString('pt-BR')}</strong> cliques</span>
                <span aria-hidden="true">·</span>
                <span class="status-text ${statusClass}">${statusLabel}</span>
                <span aria-hidden="true">·</span>
                <span>Criado em ${escapeHtml(formatDateBR(item.createdAt))}</span>
              </div>
            </div>
            <div class="link-row-actions">
              <button type="button" class="btn btn-soft btn-sm" data-action="copy" data-url="${escapeHtml(shortUrl)}">Copiar</button>
              <a href="${escapeHtml(shortUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">Testar</a>
              <button type="button" class="btn btn-secondary btn-sm" data-action="toggle" data-code="${escapeHtml(item.code)}">${item.active ? 'Desativar' : 'Ativar'}</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="edit" data-code="${escapeHtml(item.code)}">Editar</button>
              <button type="button" class="btn btn-danger btn-sm" data-action="delete" data-code="${escapeHtml(item.code)}">Excluir</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function attachLinksListener(uid) {
    if (unsubscribeLinks) {
      unsubscribeLinks();
      unsubscribeLinks = null;
    }
    const q = query(
      collection(db, 'links'),
      where('ownerId', '==', uid),
      orderBy('createdAt', 'desc')
    );
    unsubscribeLinks = onSnapshot(
      q,
      (snap) => {
        allUserLinks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderHomeLinks();
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, 'links');
      }
    );
  }

  async function handleLogin() {
    setFeedback('');
    try {
      await loginWithGoogle();
      showToast('Conta conectada com sucesso!', 'success');
    } catch (err) {
      if (err && err.code === 'auth/popup-closed-by-user') return;
      setFeedback('Não foi possível concluir o login com Google. Verifique se pop-ups estão permitidos.');
    }
  }

  if (loginBtn) loginBtn.addEventListener('click', handleLogin);
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await logoutAccount();
      showToast('Sessão encerrada.');
    });
  }

  if (zipBtn) {
    zipBtn.addEventListener('click', () => downloadProjectZip(zipBtn));
  }

  if (searchInput) {
    searchInput.addEventListener('input', renderHomeLinks);
  }

  // Envio do formulário de encurtamento
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFeedback('');

    const urlCheck = validateHttpUrl(urlInput.value);
    if (!urlCheck.valid) {
      setFeedback(urlCheck.error, 'error');
      urlInput.focus();
      return;
    }

    if (!currentUser) {
      try {
        const cred = await loginWithGoogle();
        currentUser = cred.user;
      } catch {
        setFeedback('Conecte sua conta Google para salvar e rastrear seus links no banco online.', 'info');
        return;
      }
    }

    shortenBtn.disabled = true;
    shortenBtn.textContent = 'ENCURTANDO...';

    try {
      const created = await createShortLinkInFirestore({
        originalUrl: urlCheck.url,
        customCode: customCodeInput.value,
        title: titleInput.value,
        description: descInput.value,
        ownerId: currentUser.uid,
      });

      resultShortUrl.href = created.shortUrl;
      resultShortUrl.textContent = created.shortUrl;
      resultOriginalUrl.textContent = `Destino: ${created.originalUrl}`;
      testResultLink.href = created.shortUrl;
      resultPanel.classList.remove('hidden');

      customCodeInput.value = '';
      titleInput.value = '';
      descInput.value = '';
      urlInput.value = '';
      showToast('Link encurtado e salvo na nuvem!', 'success');
    } catch (err) {
      setFeedback(err.message || 'Erro ao encurtar o link.', 'error');
    } finally {
      shortenBtn.disabled = false;
      shortenBtn.textContent = 'ENCURTAR LINK';
    }
  });

  if (copyResultBtn) {
    copyResultBtn.addEventListener('click', async () => {
      const text = resultShortUrl.textContent;
      if (!text) return;
      await copyToClipboard(text);
      const original = copyResultBtn.textContent;
      copyResultBtn.textContent = 'COPIADO!';
      showToast('Link curto copiado para a área de transferência!', 'success');
      setTimeout(() => {
        copyResultBtn.textContent = original;
      }, 1800);
    });
  }

  // Ações delegadas nos links recentes
  linksContainer.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const code = btn.dataset.code;

    if (action === 'copy') {
      await copyToClipboard(btn.dataset.url);
      showToast('Link copiado!', 'success');
      return;
    }

    const targetLink = allUserLinks.find((l) => l.code === code);
    if (!targetLink) return;

    if (action === 'toggle') {
      try {
        await updateDoc(doc(db, 'links', code), {
          active: !targetLink.active,
          updatedAt: serverTimestamp(),
        });
        showToast(targetLink.active ? 'Link desativado.' : 'Link ativado!', 'success');
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `links/${code}`);
      }
      return;
    }

    if (action === 'edit') {
      editCodeInput.value = targetLink.code;
      editUrlInput.value = targetLink.originalUrl;
      editNameInput.value = targetLink.title || '';
      editDescInput.value = targetLink.description || '';
      editActiveInput.checked = Boolean(targetLink.active);
      editModal.classList.remove('hidden');
      return;
    }

    if (action === 'delete') {
      if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.textContent = 'Confirmar?';
        setTimeout(() => {
          if (btn.isConnected) {
            btn.dataset.armed = '';
            btn.textContent = 'Excluir';
          }
        }, 3000);
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Excluindo...';
      try {
        await deleteLinkAndClicks(code);
        showToast('Link excluído permanentemente.', 'success');
      } catch {
        showToast('Erro ao excluir o link.', 'error');
      }
    }
  });

  // Modal de edição rápida
  function closeEditModal() {
    editModal.classList.add('hidden');
  }
  document.getElementById('home-edit-close')?.addEventListener('click', closeEditModal);
  document.getElementById('home-edit-cancel')?.addEventListener('click', closeEditModal);

  editForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = editCodeInput.value;
    const check = validateHttpUrl(editUrlInput.value);
    if (!check.valid) {
      showToast(check.error, 'error');
      return;
    }
    try {
      await updateDoc(doc(db, 'links', code), {
        originalUrl: check.url,
        title: String(editNameInput.value || '').trim().slice(0, 120) || new URL(check.url).hostname,
        description: String(editDescInput.value || '').trim().slice(0, 400),
        active: editActiveInput.checked,
        updatedAt: serverTimestamp(),
      });
      closeEditModal();
      showToast('Link atualizado!', 'success');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `links/${code}`);
    }
  });

  // Inicializa conexão e observa autenticação
  testConnection().then((res) => {
    if (!res.ok) {
      setFeedback('Sem conexão com o banco online. Verifique sua internet ou configuração do Firebase.', 'error');
    }
  });

  loadAppBranding();

  subscribeAuth((user) => {
    currentUser = user;
    if (user) {
      authStatusEl.textContent = `Conectado como ${user.email || user.displayName || 'Usuário'}`;
      loginBtn.classList.add('hidden');
      logoutBtn.classList.remove('hidden');
      attachLinksListener(user.uid);
    } else {
      authStatusEl.textContent = 'Conecte sua conta Google para criar e gerenciar links permanentes.';
      loginBtn.classList.remove('hidden');
      logoutBtn.classList.add('hidden');
      if (unsubscribeLinks) {
        unsubscribeLinks();
        unsubscribeLinks = null;
      }
      allUserLinks = [];
      renderHomeLinks();
    }
  });
}

initHomePage();
