function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}body{margin:0;background:#f4f5f7;color:#17191c}main{box-sizing:border-box;max-width:34rem;margin:8vh auto;padding:2rem;border-radius:1rem;background:#fff;box-shadow:0 12px 36px #0002}h1{font-size:1.5rem;margin-top:0}label{display:block;margin:1rem 0 .35rem}input{box-sizing:border-box;width:100%;padding:.7rem;border:1px solid #999;border-radius:.45rem;font:inherit}.actions{display:flex;gap:.75rem;margin-top:1.5rem}button{padding:.7rem 1rem;border:0;border-radius:.45rem;background:#2266d5;color:#fff;font:inherit;font-weight:650;cursor:pointer}button.secondary{background:#666}.error{padding:.7rem;border-radius:.4rem;background:#ffe5e5;color:#8a1010}dl{display:grid;grid-template-columns:max-content 1fr;gap:.4rem .8rem}dt{font-weight:650}dd{margin:0;overflow-wrap:anywhere}.hint{color:#555;font-size:.92rem}@media(prefers-color-scheme:dark){body{background:#15171a;color:#eee}main{background:#22262b}.hint{color:#bbb}}
  </style>
</head>
<body><main>${content}</main></body>
</html>`;
}

export function loginPage(input: {
  interaction: string;
  csrf: string;
  error?: boolean;
}): string {
  const error = input.error
    ? '<p class="error" role="alert">Identifiants invalides. Réessayez.</p>'
    : "";
  return page(
    "Connexion à Fitness",
    `<h1>Connexion administrateur</h1>
<p>Authentifiez-vous avant d’autoriser ce connecteur à accéder à Fitness.</p>
${error}
<form method="post" action="/oauth/login">
  <input type="hidden" name="interaction" value="${escapeHtml(input.interaction)}">
  <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
  <label for="username">Nom d’utilisateur</label>
  <input id="username" name="username" autocomplete="username" required maxlength="128">
  <label for="password">Mot de passe</label>
  <input id="password" type="password" name="password" autocomplete="current-password" required maxlength="1024">
  <div class="actions"><button type="submit">Se connecter</button></div>
</form>`,
  );
}

export function consentPage(input: {
  interaction: string;
  csrf: string;
  clientName: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
}): string {
  const redirectHost = new URL(input.redirectUri).host;
  return page(
    "Autoriser Fitness",
    `<h1>Autoriser le connecteur ?</h1>
<p>Vous êtes connecté. Vérifiez la demande avant de continuer.</p>
<dl>
  <dt>Client</dt><dd>${escapeHtml(input.clientName)}</dd>
  <dt>Retour vers</dt><dd>${escapeHtml(redirectHost)}</dd>
  <dt>Ressource</dt><dd>${escapeHtml(input.resource)}</dd>
  <dt>Accès</dt><dd>${escapeHtml(input.scopes.join(", "))}</dd>
</dl>
<p class="hint">Les identifiants Lyfta et Yazio restent sur le serveur et ne sont jamais transmis au client.</p>
<form method="post" action="/oauth/consent">
  <input type="hidden" name="interaction" value="${escapeHtml(input.interaction)}">
  <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
  <div class="actions">
    <button type="submit" name="decision" value="allow">Autoriser</button>
    <button class="secondary" type="submit" name="decision" value="deny">Refuser</button>
  </div>
</form>`,
  );
}

export function errorPage(message: string): string {
  return page(
    "Erreur OAuth",
    `<h1>Demande impossible</h1><p>${escapeHtml(message)}</p>`,
  );
}
