# Roadmap

- [ ] Repenser l’accueil autour des Steam Clouds détectés dynamiquement : ajouter les filtres `Tous`, `Favoris`, `Installés`, `Non installés`, la recherche `Search cloud...`, ainsi qu’un bouton favori sur chaque carte Cloud, tout en gardant le design minimal actuel.

- [ ] Remplacer l’ajout manuel des jeux par une détection générique : VaporStow devra analyser automatiquement les AppID et la configuration Steam Cloud disponible pour récupérer le quota, le nombre maximal de fichiers, le dossier local, le pattern accepté (`*.sav`, `*.map`, `*`, etc.), le mode récursif ou non, et déterminer quels Clouds sont réellement exploitables sans devoir ajouter chaque jeu à la main.

- [ ] Ajouter un second mode d’import `Reed–Solomon` en plus du mode `Normal` : l’utilisateur choisit minimum 3 Clouds déjà installés et initialisés, VaporStow découpe le fichier en shards, ajoute de la parité et les répartit entre les Clouds. Exemple : `2+1` sur 3 Clouds permet d’en perdre 1, `3+2` sur 5 permet d’en perdre 2. Chaque fichier protégé possède un Pool ID, la liste de ses Clouds et son état. Lors de la synchro, VaporStow prépare les shards, ouvre chaque jeu nécessaire, attend la synchro Steam initiale, place les fichiers dans le dossier Cloud local, ferme le jeu, attend la fin de l’upload Steam puis passe au suivant en gardant une progression globale jusqu’à la fin. Si un Cloud disparaît, le fichier peut être reconstruit depuis les autres puis réparé vers un nouveau Cloud.

- [ ] Ajouter le drag & drop : déposer un ou plusieurs fichiers/dossiers dans VaporStow ouvre directement le modal d’import avec les éléments préremplis, puis laisse choisir entre `Normal` et `Reed–Solomon` avant de lancer l’import.
