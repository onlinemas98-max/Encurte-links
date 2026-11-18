/**
 * firebase-config.js
 * Inicialização do Firebase (Firestore + Authentication) em JavaScript puro (ES Modules)
 * com validação de conexão e tratamento estruturado de erros.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDocFromServer,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

export const firebaseConfig = {
  projectId: 'ai-studio-applet-webapp-bd0eb',
  appId: '1:25952772702:web:7cf34a698ddd7a990b8acf',
  apiKey: 'AIzaSyCa0-P6TmspOMt08QytGzipZ4d7yrB3WVo',
  authDomain: 'ai-studio-applet-webapp-bd0eb.firebaseapp.com',
  firestoreDatabaseId: 'ai-studio-577a4e7f-cddd-4471-a669-2118c08eb160',
  storageBucket: 'ai-studio-applet-webapp-bd0eb.firebasestorage.app',
  messagingSenderId: '25952772702',
  measurementId: '',
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export const OperationType = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
});

/**
 * Testa a conectividade inicial com o servidor do Firestore.
 */
export async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Erro de conexão com o Firestore. Verifique a configuração do Firebase.');
      return { ok: false, offline: true, message: error.message };
    }
    return { ok: true };
  }
}

/**
 * Lança erro estruturado em JSON com contexto de operação e autenticação
 * para diagnóstico preciso de permissões e regras do Firestore.
 */
export function handleFirestoreError(error, operationType, path) {
  const user = auth.currentUser;
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path: path || null,
    authInfo: {
      userId: user ? user.uid : null,
      email: user ? user.email : null,
      emailVerified: user ? user.emailVerified : null,
      isAnonymous: user ? user.isAnonymous : null,
      tenantId: user ? user.tenantId : null,
      providerInfo: user && Array.isArray(user.providerData)
        ? user.providerData.map((p) => ({
            providerId: p.providerId || null,
            email: p.email || null,
          }))
        : [],
    },
  };

  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function loginWithGoogle() {
  return signInWithPopup(auth, googleProvider);
}

export async function logoutAccount() {
  return signOut(auth);
}

export function subscribeAuth(callback) {
  return onAuthStateChanged(auth, callback);
}
