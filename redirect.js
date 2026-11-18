/**
 * redirect.js
 * Sistema de redirecionamento e rastreamento individual de cliques.
 * Coleta apenas métricas técnicas e geográficas aproximadas, sem PII.
 */
import {
  doc,
  getDoc,
  collection,
  writeBatch,
  increment,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';
import { db } from './firebase-config.js';

const CODE_REGEX = /^[a-zA-Z0-9_-]{3,40}$/;
const DEDUP_WINDOW_MS = 10000;

/**
 * Extrai o código curto a partir da query (?c=), rota (/r/codigo) ou hash (#c=).
 */
export function extractShortCode() {
  const params = new URLSearchParams(window.location.search);
  const queryCode = params.get('c');
  if (queryCode) return queryCode.trim();

  const pathMatch = window.location.pathname.match(/^\/r\/([a-zA-Z0-9_-]{3,40})\/?$/);
  if (pathMatch) return pathMatch[1];

  const hashMatch = window.location.hash.match(/^#c=([a-zA-Z0-9_-]{3,40})$/);
  if (hashMatch) return hashMatch[1];

  return null;
}

function detectDevice(ua) {
  const lower = ua.toLowerCase();
  if (/ipad|tablet|playbook|silk|(android(?!.*mobi))/i.test(lower)) {
    return 'tablet';
  }
  if (/mobile|iphone|ipod|android|blackberry|iemobile|opera mini/i.test(lower)) {
    return 'mobile';
  }
  return 'desktop';
}

function detectBrowser(ua) {
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'Safari';
  return 'Outro';
}

function detectOS(ua) {
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Outro';
}

function classifySource(refererRaw) {
  const params = new URLSearchParams(window.location.search);
  const utm = (params.get('utm_source') || '').trim();
  if (utm) {
    return utm.slice(0, 60);
  }

  if (!refererRaw) {
    return { source: 'Direto', referer: 'Acesso direto' };
  }

  try {
    const refUrl = new URL(refererRaw);
    const host = refUrl.hostname.replace(/^www\./, '').toLowerCase();
    if (!host || host === window.location.hostname.toLowerCase()) {
      return { source: 'Direto', referer: 'Acesso direto' };
    }
    if (host.includes('whatsapp') || host.includes('wa.me')) return { source: 'WhatsApp', referer: host };
    if (host.includes('instagram')) return { source: 'Instagram', referer: host };
    if (host.includes('facebook') || host.includes('fb.')) return { source: 'Facebook', referer: host };
    if (host.includes('twitter') || host === 't.co' || host.includes('x.com')) return { source: 'X / Twitter', referer: host };
    if (host.includes('linkedin')) return { source: 'LinkedIn', referer: host };
    if (host.includes('youtube') || host === 'youtu.be') return { source: 'YouTube', referer: host };
    if (host.includes('google')) return { source: 'Google', referer: host };
    if (host.includes('bing')) return { source: 'Bing', referer: host };
    return { source: 'Referência', referer: host.slice(0, 200) };
  } catch {
    return { source: 'Direto', referer: 'Acesso direto' };
  }
}

function formatLocalDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function fetchApproximateGeo() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 900);
  try {
    const res = await fetch('https://ipwho.is/?fields=success,country,city', {
      signal: controller.signal,
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) throw new Error('Geo unavailable');
    const json = await res.json();
    if (json && json.success) {
      return {
        country: String(json.country || 'Não identificado').slice(0, 80),
        city: String(json.city || 'Não identificada').slice(0, 80),
      };
    }
  } catch {
    // Fallback por fuso horário local sem expor dados pessoais
  } finally {
    clearTimeout(timer);
  }

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (tz.includes('Sao_Paulo') || tz.includes('Fortaleza') || tz.includes('Recife') || tz.includes('Bahia') || tz.includes('Belem') || tz.includes('Manaus')) {
      return { country: 'Brasil', city: tz.split('/')[1]?.replace(/_/g, ' ') || 'Não identificada' };
    }
    if (tz.includes('Lisbon')) {
      return { country: 'Portugal', city: 'Lisboa' };
    }
  } catch {
    // Ignora
  }

  return { country: 'Não identificado', city: 'Não identificada' };
}

function showRedirectState({ title, message, targetUrl = '', isError = false }) {
  const spinner = document.getElementById('redirect-spinner');
  const titleEl = document.getElementById('redirect-title');
  const msgEl = document.getElementById('redirect-message');
  const boxEl = document.getElementById('redirect-target-box');
  const actionsEl = document.getElementById('redirect-actions');
  const manualLink = document.getElementById('redirect-manual-link');

  if (spinner && isError) spinner.classList.add('hidden');
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;

  if (boxEl && targetUrl) {
    boxEl.textContent = targetUrl;
    boxEl.classList.remove('hidden');
  }

  if (actionsEl) {
    actionsEl.classList.remove('hidden');
    if (manualLink) {
      if (targetUrl) {
        manualLink.href = targetUrl;
        manualLink.classList.remove('hidden');
      } else {
        manualLink.classList.add('hidden');
      }
    }
  }
}

async function processRedirect() {
  const code = extractShortCode();
  if (!code) return;

  document.documentElement.classList.add('is-redirecting');
  window.__IS_REDIRECTING__ = true;

  if (!CODE_REGEX.test(code)) {
    showRedirectState({
      title: 'Código de link inválido',
      message: 'O endereço solicitado não corresponde a um link curto válido.',
      isError: true,
    });
    return;
  }

  try {
    // Atualiza nome da marca se configurado
    getDoc(doc(db, 'settings', 'public'))
      .then((s) => {
        if (s.exists() && s.data().appName) {
          document.querySelectorAll('.app-brand-name').forEach((el) => {
            el.textContent = s.data().appName;
          });
        }
      })
      .catch(() => {});

    const linkRef = doc(db, 'links', code);
    const snap = await getDoc(linkRef);

    if (!snap.exists()) {
      showRedirectState({
        title: 'Link não encontrado',
        message: 'Este link curto não existe ou foi removido pelo administrador.',
        isError: true,
      });
      return;
    }

    const linkData = snap.data();
    if (!linkData.active) {
      showRedirectState({
        title: 'Link temporariamente desativado',
        message: 'O proprietário pausou este link no painel administrativo.',
        isError: true,
      });
      return;
    }

    let safeUrl = '';
    try {
      const parsed = new URL(linkData.originalUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Protocolo inseguro');
      }
      safeUrl = parsed.toString();
    } catch {
      showRedirectState({
        title: 'Destino inválido',
        message: 'A URL de destino cadastrada é inválida e foi bloqueada por segurança.',
        isError: true,
      });
      return;
    }

    // Evita contagem duplicada acidental por F5 / recarregamento rápido na mesma aba
    const dedupKey = `lp_visited_${code}`;
    const lastVisit = Number(sessionStorage.getItem(dedupKey) || '0');
    const nowMs = Date.now();
    const shouldCount = !lastVisit || nowMs - lastVisit > DEDUP_WINDOW_MS;

    if (shouldCount) {
      sessionStorage.setItem(dedupKey, String(nowMs));

      const ua = navigator.userAgent || '';
      const now = new Date();
      const sourceInfo = classifySource(document.referrer);
      const sourceText = typeof sourceInfo === 'string' ? sourceInfo : sourceInfo.source;
      const refererText = typeof sourceInfo === 'string' ? 'UTM' : sourceInfo.referer;
      const geo = await fetchApproximateGeo();

      const batch = writeBatch(db);
      batch.update(linkRef, {
        clickCount: increment(1),
        lastClickedAt: serverTimestamp(),
      });

      const clickRef = doc(collection(db, 'clicks'));
      batch.set(clickRef, {
        linkCode: code,
        linkOwnerId: linkData.ownerId,
        clickedAt: serverTimestamp(),
        dateKey: formatLocalDateKey(now),
        hour: now.getHours(),
        device: detectDevice(ua),
        browser: detectBrowser(ua),
        os: detectOS(ua),
        country: geo.country,
        city: geo.city,
        source: String(sourceText).slice(0, 60),
        referer: String(refererText).slice(0, 200),
      });

      try {
        await batch.commit();
      } catch (err) {
        console.warn('Não foi possível registrar a métrica de clique:', err);
      }
    }

    showRedirectState({
      title: 'Encaminhando para o destino...',
      message: 'Redirecionamento concluído. Caso não abra automaticamente, clique no botão abaixo.',
      targetUrl: safeUrl,
      isError: false,
    });

    window.location.replace(safeUrl);
  } catch (err) {
    console.error('Erro ao redirecionar:', err);
    showRedirectState({
      title: 'Erro de conexão',
      message: 'Não foi possível consultar o banco de dados no momento. Tente novamente em instantes.',
      isError: true,
    });
  }
}

processRedirect();
