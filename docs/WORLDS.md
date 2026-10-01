# Ships and starting worlds

A scenario needs a pilot somewhere, in something. Two tools set that up. A loadout gives the
logged-in character a ship by item name. A world recipe builds a starting world from nothing and
saves it, so a scenario can name the recipe and the tool builds the world for it.

## Loadouts

```
node tools/evejs-e2e/bin/e2e.js loadout Tristan \
  --modules "Light Neutron Blaster II x2, 1MN Afterburner II" \
  --drones "Hobgoblin II x5" --cargo "Antimatter Charge S x400" --charges "Antimatter Charge S"
node tools/evejs-e2e/bin/e2e.js loadout --file my-ship.json     # the JSON below
```

As a scenario step, and as the MCP tool `e2e_loadout`, it's the same object:

```json
{ "loadout": {
  "ship": "Tristan",
  "modules": ["Light Neutron Blaster II x2", "1MN Afterburner II"],
  "drones": ["Hobgoblin II x5"],
  "cargo": ["Antimatter Charge S x400"],
  "charges": ["Antimatter Charge S"]
} }
```

- Names are exact item names, and `Name xN` is N of one item. A near miss is refused with the item
  the name would have matched, because a fit that silently picks the wrong item is hard to spot.
- `charges` puts a full clip in every fitted module that takes that charge. It takes no count; put
  spares in `cargo`.
- Before anything is made, the bridge resolves every name and checks every skill the hull, modules,
  drones and charges need. It also plans the fit on the hull: a slot for each module, the fit
  rules, and CPU, power and calibration after each one. If any check fails, the bridge refuses,
  lists the unknown names, the missing skills (each with the level needed and the level the pilot
  has) or the module that doesn't fit, and changes nothing. `/allskills` grants every skill.
- Docked, the ship is made in that station's hangar and boarded there. In space, it's made in the
  pilot's home station and swapped in beside the old ship. Stock removes the old ship and leaves
  its wreck; the reply names it.
- The reply lists each module by slot with the charge it holds, the drones, the cargo, and the
  CPU, power and calibration used.

The bridge builds the ship with stock's own helpers, the ones the `/ship`-style dev commands use
(`services/ship/devCommandShipRuntime.js` and the modules it reads). `e2e doctor` says whether a
tree has them. The bridge loads its own charges, because stock's preload fills only the first
module of a type.

## World recipes

A recipe is a file in `worlds/`, `<name>.recipe.json`. It holds the steps that build a world from
a fresh game store, in the same syntax as a scenario's setup:

```json
{
  "description": "...",
  "steps": ["fresh", "login", { "slash": "/allskills" }, { "loadout": { "ship": "Tristan" } },
            { "slash": "/tr me 60004603" }]
}
```

`fresh` comes first. After it a recipe takes `login`, `undock`, `dock`, `slash`, `teleport`,
`loadout` and `wait`: steps that put a character somewhere, but nothing that watches.

```
node tools/evejs-e2e/bin/e2e.js world recipes          # each recipe, and whether its world is built and current
node tools/evejs-e2e/bin/e2e.js world build starter    # boot fresh, run the steps, stop, save
```

`world build` needs managed mode. It saves the world under the recipe's name, and its `world.json`
keeps a fingerprint of what built it: the recipe's SHA-256, the tree's git commit, the state of
each patch, and the vendored tool's commit. The patches stand in for a commit where the tree has
none, such as an unpacked zip. A step that fails stops the build and leaves the saved world as it
was. A world of the same name saved by hand isn't replaced without `--force`.

A scenario names a recipe instead of a world:

```json
{ "recipe": "starter", "setup": ["undock"], "until": { "timeout": 60 }, "expect": ["GRID"] }
```

In managed mode, `e2e run` builds the world first when it isn't built or the fingerprint changed,
so a new tree goes from nothing to a fitted ship in one command. `--world` still overrides it. In
attach mode the recipe isn't applied, as a saved world isn't.

### starter

A fresh character with every skill, in a Tristan with two Light Neutron Blaster IIs loaded with
Antimatter Charge S, a 1MN Afterburner II, a Warp Scrambler II, a Stasis Webifier II, a Magnetic
Field Stabilizer II, a Small Armor Repairer II, five Hobgoblin IIs and 400 spare rounds. It's
docked at Amamake II - Brutor Tribe Bureau, in low sec. It uses CPU 144 of 162.5 and power 36.2
of 43.8. It builds in about 20 s.

It docks with `/tr me <stationID>`, because stock `/dock` takes the pilot back to its home station
wherever it is.

## The core scenarios

They run on stock EveJS and on forks, and use only stock commands.

| Scenario | Starts from | What it checks |
| --- | --- | --- |
| `smoke-undock` | `fresh` | undock and read the grid; undock protection; the client view agrees |
| `selftest-unmet` | `fresh` | the runner itself: one expectation can't be met, so the run fails with exactly that one MISSING |
| `gate-rats` | `starter` | stock `/gaterats on` at a Siseide gate: rats arrive, lock and shoot |
| `concord-highsec` | `starter` | stock `/naughty` in Rens: CONCORD arrives, locks and kills |
| `loadout-npc-fight` | `starter` | two Blood Raider frigates from `/npc`; drones and blasters fire at the locked one, it dies, the Tristan survives |

`loadout-npc-fight` names a profile, `/npc 2 parity_blood_raider_pulse_frigate`, because the
default `/npc` pool can roll elite cruisers that kill a Tristan before it does any damage.
