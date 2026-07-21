# 🔒 Sécurité — Crack Games Launcher

## Ce qui est protégé (déjà en place)

| Menace | Protection |
|---|---|
| **Exécution de code injecté (XSS)** | Content-Security-Policy stricte dans `index.html` : scripts limités à l'appli, aucun script distant, `object-src 'none'`, `base-uri 'none'`. |
| **Fuite d'accès à Node.js depuis la page** | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Le rendu ne voit jamais les objets internes d'Electron. |
| **`<webview>` malveillant** | `webviewTag: false`. |
| **Redirection / phishing dans la fenêtre** | `will-navigate` bloqué. La page ne peut pas naviguer ailleurs. |
| **Ouverture de fenêtres pirates** | `setWindowOpenHandler` : refuse tout, sauf ouvrir un lien **https** dans le navigateur système. |
| **Abus de permissions** | `setPermissionRequestHandler` refuse tout (caméra, micro, géoloc, notifications…). |
| **Téléchargement depuis un domaine pirate** | Liste blanche `TRUSTED_HOSTS` : seuls GitHub, Mojang, NeoForge/Forge/Fabric et Adoptium sont autorisés. HTTPS obligatoire. Tout le reste est refusé (`assertTrustedUrl`). |
| **Man-in-the-middle / HTTP** | Tout téléchargement non-HTTPS est rejeté. |
| **Zip slip (archive piégée)** | `safeJoin` : impossible d'écrire hors du dossier de l'instance lors de l'extraction du modpack. |
| **Path traversal via noms de fichiers** | `safeName` assainit chaque nom de mod/fichier (retire `..`, `/`, `\`, caractères spéciaux). |
| **Path traversal via identifiant de serveur** | `instanceDir` assainit l'`id` du serveur avant de construire un chemin de dossier. |
| **Librairies NeoForge piégées** | Chemins des librairies validés par `safeJoin` avant écriture. |
| **Triche (X-ray, mods ajoutés)** | Manifeste anti-triche : le dossier `mods` doit correspondre exactement au pack officiel (SHA-256). |

## Comment ça marche (résumé)

Le launcher ne télécharge **que** depuis une liste de domaines de confiance, uniquement en HTTPS. Chaque fichier écrit sur le disque passe par un contrôle qui garantit qu'il reste dans le dossier prévu — un `.zip` ou un `servers.json` modifié ne peut pas déposer un fichier ailleurs sur l'ordinateur du joueur. La page d'interface est isolée : même si un script hostile s'y glissait, il n'aurait aucun accès au système de fichiers ni au réseau hors des domaines autorisés.

## ⚠️ À FAIRE / à savoir de ton côté

### 1. Ajouter un domaine de téléchargement
Si un jour tu héberges le modpack ailleurs que sur GitHub (ex : ton propre serveur), il faut ajouter ce domaine dans `TRUSTED_HOSTS` (fichier `src/main.js`), sinon le launcher refusera le téléchargement. C'est **volontaire** : c'est cette liste qui protège les joueurs.

### 2. `servers.json` et `news.json` sont ta source de confiance
Ces fichiers pilotent ce que le launcher télécharge. Garde le contrôle de ton repo GitHub (2FA sur ton compte GitHub). Quiconque modifie ces fichiers peut changer les URLs de mods — mais la liste blanche empêche quand même de pointer vers un domaine pirate.

### 3. Signature du code (optionnel, recommandé plus tard)
`verifyUpdateCodeSignature` est désactivé (pas de certificat pour l'instant). Windows affichera un avertissement SmartScreen au premier lancement. Pour l'éliminer : un certificat de signature de code (payant, ~200 €/an). Pas indispensable pour un launcher privé.

### 4. Anti-triche côté serveur
Le manifeste SHA-256 empêche les tricheurs occasionnels via **ce** launcher, mais un joueur déterminé peut lancer un autre client. Garde un anti-cheat + anti-xray **côté serveur Minecraft** : c'est la vraie protection.

## Limites honnêtes

Ces mesures bloquent les attaques automatisées, les archives piégées et l'immense majorité des tentatives. Aucun logiciel n'est « impiratable ». Pour aller plus loin un jour : signature de code, et vérification d'un hash publié pour l'installeur.

## Après cette mise à jour de sécurité

Le code de `src/main.js` et `src/renderer/index.html` a changé (sécurité uniquement, aucun changement de comportement pour le joueur). Pense à **rebâtir et republier** le launcher (`npm run build` puis publier la release GitHub) pour que les joueurs en profitent.
