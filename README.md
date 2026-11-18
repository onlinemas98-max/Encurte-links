# LinkPulse — Encurtador de Links Profissional com Rastreamento e Analytics

Aplicação completa em **HTML5, CSS3 e JavaScript puro** (sem frameworks), conectada ao **Firebase Firestore** e **Firebase Authentication** para persistência real na nuvem, redirecionamento com rastreamento individual de acessos e painel administrativo protegido.

## Arquivos do Projeto
- `index.html` — Página principal do encurtador e camada de redirecionamento instantâneo.
- `admin.html` — Painel administrativo completo (Visão geral, Meus links, Analytics, Histórico e Configurações).
- `style.css` — Estilização responsiva completa (tema branco/cinza-claro com azul principal).
- `script.js` — Lógica da página inicial, validações, geração de códigos, ações rápidas e empacotador ZIP.
- `redirect.js` — Sistema de redirecionamento e coleta ética de cliques (sem PII).
- `analytics.js` — Motor estatístico, gráficos SVG/Canvas responsivos, CRUD, CSV e Backup/Restore.
- `firebase-config.js` — Configuração modular do Firebase (Firestore + Google Auth).
- `firestore.rules` — Regras de segurança validadas para o Firestore.

## Como Hospedar em Produção (Gratuito)
1. **Suba os arquivos** (`index.html`, `admin.html`, `style.css`, `script.js`, `redirect.js`, `analytics.js`, `firebase-config.js`) para qualquer hospedagem estática (Firebase Hosting, Netlify, Vercel ou GitHub Pages).
2. **Domínio autorizado no Firebase Auth**:
   - No Console do Firebase > **Authentication** > **Settings** > **Authorized domains**, adicione o domínio onde você hospedou o projeto.
3. **Administrador Principal**:
   - Edite a função `isAdmin()` em `firestore.rules` caso deseje alterar o e-mail do administrador principal e publique as regras com `firebase deploy --only firestore:rules`.
4. **Links Curtos**:
   - O formato padrão `https://seu-dominio.com/?c=CODIGO` funciona em qualquer servidor estático sem necessidade de configuração extra de rewrite.
