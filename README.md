# OtakuList

Application statique pour organiser et consulter des listes d'animes. Kitsu fournit la recherche et les données anime; TMDB complète les titres et synopsis français lorsqu'ils sont disponibles. MyMemory reste un recours pour traduire les synopsis manquants. Les listes et comptes sont gérés par Supabase.

## Données anime en français

La recherche, les affiches, les épisodes et les métadonnées anime restent fournis par Kitsu. Lorsqu'une fiche française correspondante existe sur TMDB, une fonction Supabase récupère son titre et son synopsis français. Si TMDB ne propose pas de traduction, OtakuList essaie MyMemory; en cas d'échec, le synopsis original est conservé.

Pour activer TMDB en production :

1. Obtenez un **API Read Access Token** dans les paramètres développeur TMDB.
2. Dans Supabase, ajoutez-le comme secret de fonction sous le nom `TMDB_ACCESS_TOKEN` (ne le mettez pas dans `config.js` ni dans GitHub).
3. Déployez la fonction avec la CLI Supabase : `supabase functions deploy tmdb-localize --project-ref xtbxeperselrienqqogh`. Le fichier `supabase/config.toml` désactive la vérification JWT pour cette fonction, nécessaire à la consultation publique; ses origines CORS sont limitées à GitHub Pages et aux serveurs de développement usuels.

La fonction valide les titres, limite les demandes par instance et garde les réponses en cache. Les traductions TMDB restent dépendantes des contributions disponibles dans la base. Le pied de page affiche l'attribution et le logo TMDB requis par ses conditions d'utilisation. L'icône locale provient de [Simple Icons](https://simpleicons.org/) (CC0).

## Comptes et listes

Le site ne propose pas de création de compte. Les visiteurs peuvent consulter les listes publiques ; un compte connecté peut modifier uniquement sa propre liste. Le formulaire de connexion comprend une récupération par e-mail permettant à l'utilisateur de choisir son mot de passe.

Pour mettre en place les comptes manuellement :

1. Dans Supabase, ouvrez **Authentication > Settings** et désactivez **Allow new users to sign up**. L'application n'a pas de formulaire d'inscription ; cette option désactive aussi les inscriptions directes par l'API.
2. Dans **Authentication > URL Configuration**, définissez la **Site URL** sur l'adresse du site publié et autorisez cette adresse dans **Redirect URLs**. Les liens de récupération redirigent vers cette URL.
3. Dans **Authentication > Users**, utilisez **Add user** pour créer chaque compte manuellement et confirmez son adresse e-mail.
4. Récupérez l'UUID de chaque utilisateur dans cette page.
5. Dans le **SQL Editor**, exécutez [`supabase-setup.sql`](./supabase-setup.sql). Ce script crée les listes, configure les permissions et retire les anciens droits publics d'écriture sur la liste partagée.
6. Pour le premier compte, ajoutez sa ligne dans `user_anime_lists` avec l'UUID, un pseudonyme public et le contenu de l'ancienne liste. Le script contient un exemple qui transfère les animes de `otaku_collection`.
7. Pour chaque autre compte, ajoutez une ligne avec son UUID et son pseudonyme ; sa liste démarrera vide. Des exemples sont dans le script SQL.

Seul le pseudonyme est affiché dans OtakuList. Les adresses e-mail ne sont pas publiées. Tout visiteur peut lire les pseudonymes et les listes ; seule la session correspondant au propriétaire peut modifier les animes. Les utilisateurs ne peuvent ni créer ni supprimer les lignes de compte depuis le site.

La clé Supabase `anon`/`publishable` se trouve dans `config.js` et est publique par conception. Ne mettez jamais de clé `secret` ou `service_role` dans ce dépôt.
