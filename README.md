# OrsyFoot

Tableau de bord responsive en HTML/CSS/JavaScript natifs, avec un serveur Node.js sans dépendances.

## Installation des fournisseurs

Les services ESPN fournissent le calendrier et les scores. Pour activer les analyses réelles :

1. Demandez une clé The Odds API : <https://the-odds-api.com/>.
2. Créez un compte API-Football : <https://www.api-football.com/>.
3. Exécutez `Copy-Item .env.example .env`, puis éditez `.env` et renseignez localement `THE_ODDS_API_KEY` et `API_FOOTBALL_KEY`.
4. Lancez `node server.js` depuis le dossier du projet et ouvrez <http://localhost:8000>.

Le backend garde les clés côté serveur et ne les expose jamais au navigateur. Le fichier `.env` est ignoré par Git. Ne collez pas de clé dans les fichiers front-end, un dépôt public ou une conversation.

Si les clés ne sont pas configurées, les scores ESPN restent disponibles ; les sections de cotes, probabilités, xG et value bets restent explicitement vides. Aucun chiffre n'est simulé.

## Déploiement personnel sur Render

Supabase n'est pas nécessaire pour ouvrir l'application depuis ton téléphone : crée un service Web Render depuis le dépôt, avec `node server.js` comme commande de démarrage. Render fournit le port via `PORT` et définit `RENDER` ; le serveur écoute alors sur `0.0.0.0`. En local, il reste limité à `127.0.0.1`.

Dans les variables d'environnement du service Render, ajoute `THE_ODDS_API_KEY`, `API_FOOTBALL_KEY` et, si besoin, `ODDS_REGIONS` (`eu` par défaut). N'ajoute pas le fichier `.env` au dépôt. Les variables d'environnement Render prennent priorité sur `.env`.

Sans authentification, toute personne qui possède l'URL publique du service peut ouvrir l'application et provoquer des appels aux fournisseurs avec tes clés et leurs quotas. Ne diffuse pas l'URL ; si tu veux protéger l'accès par mot de passe, ajoute une authentification avant de partager le lien. Le cache des fournisseurs est en mémoire sur le serveur, tandis que le cache de matchs est propre à chaque navigateur : il n'y a pas d'historique durable ni de synchronisation entre appareils sans stockage persistant. La disponibilité permanente dépend aussi de l'offre Render choisie.

## Données calculées et limites

- **Calendrier et score :** flux de matchs ESPN pour Premier League, La Liga, Ligue 1, Serie A, Ligue des champions et Ligue Europa ; scores actualisés chaque minute et calendrier des 7 jours rechargé toutes les 30 minutes.
- **Cotes :** marché 1N2 The Odds API, meilleures cotes décimales sélectionnées par résultat parmi les bookmakers renvoyés dans la région configurée. Une région par défaut (`eu`) est interrogée. Le cache serveur conserve les réponses 15 minutes ; chaque actualisation peut consommer le quota du fournisseur.
- **Probabilités et buts prévus :** endpoint de prédictions API-Football pour les trois matchs à venir les plus proches par compétition, mis en cache 6 heures. La disponibilité dépend de la couverture du match et du forfait.
- **Pronostic indépendant des cotes :** si les bilans saison ESPN (V-N-D) des deux équipes sont disponibles avec au moins deux matchs terminés chacune, une estimation simplifiée calcule les probabilités 1-N-2 à partir des points par match, avec un avantage domicile modéré et une estimation régularisée du nul. Elle indique les matchs utilisés et la faiblesse de l'échantillon ; ce n'est pas un modèle calibré et elle ignore notamment blessures, compositions et force des adversaires. À défaut, l'interface utilise la prédiction API-Football ou la tendance moyenne sans marge des cotes. Ce repère n'est jamais garanti.
- **Tirs, centres et corners :** statistiques observées en direct (ou au coup de sifflet final) via le résumé ESPN du match. Les sources actuelles ne fournissent pas de projection avant la rencontre ; aucun total futur n'est inventé.
- **xG mesurés :** statistiques réelles API-Football pour certains matchs en cours ou terminés récemment, uniquement quand le fournisseur renvoie un indicateur `expected_goals`. Les xG ne sont généralement pas connus avant le match ; les valeurs manquantes restent masquées.
- **Value bet indicatif :** `probabilité API-Football × cote décimale − 1`, seulement lorsque les deux sources sont disponibles. Ce calcul n'enlève pas la marge et ne garantit pas de valeur réelle, de disponibilité de la cote ou de bénéfice.
- **Limitation d'appels :** les clés gratuites ont des quotas réduits. The Odds API interroge six compétitions, une région, un marché, et met les résultats en cache 15 minutes (jusqu'à 576 requêtes par jour si tous les caches expirent). API-Football met en cache les calendriers 6 heures, les prédictions 6 heures, les xG des matchs terminés 24 heures et les xG du direct 10 minutes. Surveillez les crédits de vos comptes et réduisez les appels/le nombre de compétitions si nécessaire.

The Odds API et API-Football sont des fournisseurs distincts : leur couverture, leurs régions, leurs noms d'équipes et leurs heures de mise à jour ne sont pas toujours identiques. Si l'association d'un match aux fournisseurs est incertaine, l'application laisse les données vides plutôt que de les associer au mauvais match. Vérifiez les licences, conditions d'utilisation et règles de jeu applicables avant une mise en production.

Si API-Football refuse l'accès à la saison demandée, vérifiez dans votre compte que le forfait autorise cette saison. Les clés peuvent être correctement configurées alors que les prédictions et xG restent indisponibles selon les droits du forfait ; le tableau de bord affiche alors l'avertissement reçu.

Les probabilités sont des estimations, pas des certitudes : même 70 % ne garantit ni un résultat ni une performance future. Ne poursuivez pas vos pertes en rejouant ; faites une pause et contactez un service d'aide aux joueurs de votre pays si le jeu devient difficile à contrôler.

## Utilisation hors ligne

Le cache PWA permet de relire l'interface. Les scores ESPN et les réponses fournisseur restent issus de leur dernière récupération en ligne et sont montrés avec leur horodatage. Un backend Node doit rester démarré pour le proxy sécurisé des fournisseurs.
