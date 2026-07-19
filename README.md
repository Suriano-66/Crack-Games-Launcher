# Crack Games Launcher

Launcher Minecraft privé avec authentification Microsoft (comptes premium uniquement).

## Fonctionnalités

- Connexion Microsoft (premium / Game Pass), session mémorisée, **multi-comptes**
- Serveurs configurables à distance (IP, version, visible/caché, **maintenance**)
- **Statut en direct** : en ligne/hors ligne + nombre de joueurs (actualisé toutes les 30 s)
- **Fil d'actualités** modifiable à distance
- **Java installé automatiquement** (bonne version selon le serveur)
- **Mods + Forge automatiques** par serveur
- **Mise à jour automatique** du launcher via GitHub Releases
- **Paramètres** : RAM allouée, accès au dossier du jeu
- **Discord Rich Presence** (optionnel)
- Connexion automatique au serveur choisi, chaque serveur a sa propre instance isolée

## Installation

```bash
npm install
npm start
```

## Créer l'installateur Windows (.exe)

```bash
npm run build
```

Le fichier est dans `dist/`. Distribue-le à tes joueurs.

## Mise à jour automatique du launcher

1. Dans `package.json` → `build.publish` : mets ton compte et ton repo GitHub.
2. Pour publier une nouvelle version : augmente `version` dans `package.json`, lance `npm run build`, puis crée une **Release GitHub** avec les fichiers `dist/*.exe` et `dist/latest.yml`.
3. Les joueurs sont mis à jour automatiquement (bannière + redémarrage). Fonctionne uniquement sur la version installée, pas en `npm start`.

## Configurer les serveurs (`servers.json`)

```json
{
  "servers": [
    {
      "id": "survie",
      "name": "Crack Games Survie",
      "description": "Serveur survie principal",
      "ip": "play.crackgames.fr",
      "port": 25565,
      "version": "1.21.1",
      "visible": true,
      "maintenance": false
    }
  ]
}
```

- **id** : identifiant unique sans espaces ni accents (sert de nom de dossier).
- **ip / port** : le joueur est connecté automatiquement au serveur.
- **version** : version Minecraft, chaque serveur peut avoir la sienne.
- **visible** : `false` = caché du launcher.
- **maintenance** : `true` = affiché mais bouton JOUER désactivé avec badge MAINTENANCE.

### Serveur moddé (Forge + mods)

```json
{
  "id": "modde",
  "version": "1.20.1",
  "loader": {
    "type": "forge",
    "installerUrl": "https://maven.minecraftforge.net/.../forge-1.20.1-47.3.0-installer.jar"
  },
  "mods": [
    { "name": "mon-mod", "url": "https://tonsite.fr/mods/mon-mod.jar" }
  ]
}
```

Le launcher télécharge Forge et les mods automatiquement dans l'instance du serveur.

### Config distante (recommandé)

1. Héberge `servers.json` et `news.json` en ligne (GitHub, ton site...).
2. Mets leurs URLs dans `config.json` (`serversUrl`, `newsUrl`).
3. Tu modifies serveurs et actus **sans redistribuer le launcher**. En cas d'URL inaccessible, les fichiers locaux servent de secours.

## Actualités (`news.json`)

```json
{
  "news": [
    { "title": "Titre", "date": "19/07/2026", "content": "Texte de l'annonce." }
  ]
}
```

## Discord Rich Presence (optionnel)

1. Crée une application sur https://discord.com/developers/applications
2. Copie son **Application ID** dans `config.json` → `discordAppId`.
3. Ajoute une image nommée `logo` dans Rich Presence → Art Assets.

Les joueurs afficheront « Joue sur [serveur] » sur leur profil Discord.

## Autres réglages (`config.json`)

- `links` : URLs des boutons Site Web / Discord / Boutique (vide = bouton masqué).
- `memory.max` : RAM par défaut (modifiable par le joueur dans ⚙ Paramètres).

## Notes

- Fichiers du jeu : `%appdata%/.crackgames` (une instance par serveur dans `instances/`).
- Java est téléchargé dans `%appdata%/.crackgames/runtime` (Java 8 / 17 / 21 selon la version MC).
- Logo personnalisé : place `logo.png` dans `assets/` (sinon logo texte). Icône de l'installateur : `assets/icon.ico`.
