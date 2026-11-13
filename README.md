# OtakuList

Application statique pour organiser une collection d'animes. La recherche de titres utilise l'API Kitsu.

## Synchronisation entre appareils

Par défaut, la liste reste enregistrée dans le navigateur. Pour activer une liste partagée sans compte utilisateur :

1. Créez un projet Supabase et ouvrez son SQL Editor.
2. Exécutez le contenu de [`supabase-setup.sql`](./supabase-setup.sql). Cela crée une liste unique dont la lecture et la modification sont publiques.
3. Dans les paramètres API du projet, copiez l'URL du projet et la clé `anon`/`publishable`.
4. Collez ces deux valeurs dans `config.js` (`supabaseUrl` et `supabaseAnonKey`).
5. Publiez `config.js` avec les autres fichiers du site.

Les paramètres `anon`/`publishable` sont destinés à être utilisés dans le navigateur ; ils ne protègent pas les données. N'y stockez aucune information privée. Toute personne ayant le site (ou l'URL du projet) peut lire, modifier ou supprimer la liste. Une seule liste est partagée par tous les visiteurs. Les changements effectués sur un autre appareil ouvert apparaissent au plus tard après quelques secondes. Des modifications simultanées peuvent se remplacer.

Si une liste locale existe déjà et que la liste partagée est vide, le site propose de l'importer.
