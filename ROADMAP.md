# Roadmap

- [ ] Rework the home screen around dynamically detected Steam Clouds: add `All`, `Favorites`, `Installed`, and `Not installed` filters, a `Search cloud...` field, and a favorite button on each Cloud card while keeping the current minimal design.

- [ ] Replace manually added games with generic Steam Cloud detection: VaporStow should automatically inspect AppIDs and Steam Cloud configuration to retrieve quota, maximum file count, local Cloud path, accepted pattern (`*.sav`, `*.map`, `*`, etc.), recursive behavior, and determine which Clouds are actually usable without hardcoding each game.

- [ ] Add a second `Reed–Solomon` import mode alongside `Normal`: the user selects at least 3 already installed and initialized Clouds, VaporStow splits the file into shards, generates parity, and distributes them across the selected Clouds. Example: `2+1` across 3 Clouds survives 1 Cloud loss, `3+2` across 5 survives 2. Each protected file gets a Pool ID, its Cloud list, and health state. During sync, VaporStow prepares the shards, opens each required game, waits for the initial Steam sync, places the files in the local Cloud folder, closes the game, waits for Steam upload to finish, then moves to the next one while keeping one global sync progress until everything is complete. If a Cloud disappears, VaporStow can reconstruct the missing data from the remaining Clouds and repair the pool using a new Cloud.

- [ ] Add drag & drop importing: dropping files or folders into VaporStow should open the import modal with them already selected, then let the user choose between `Normal` and `Reed–Solomon` before starting the import.
