# MyNeomitis (Axenco) — intégration externe pour Gladys Assistant

🇬🇧 [English](README.md) · 🇫🇷 **Français**

Pilotez depuis [Gladys Assistant](https://gladysassistant.com) les radiateurs,
thermostats et modules **Neomitis / Axenco** gérés par l'application mobile
**MyNeomitis**.

Construite sur le SDK officiel
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
Elle est partie d'un portage de l'intégration Home Assistant `myneomitis` et de
la librairie `pyaxencoapi` sur laquelle celle-ci repose, et elle ne leur
correspond plus partout : plusieurs comportements ont été mesurés sur du
matériel réel et capturés dans le trafic de l'application officielle, et ils
contredisent la référence. Voir
[Divergences avec la référence](#divergences-avec-la-référence).

📘 **Documentation utilisateur : [`docs/fr.md`](docs/fr.md) · [`docs/en.md`](docs/en.md)**

## Modèles pris en charge

`EV30` · `ECTRL` · `ESTAT` · `RSS-ECTRL` (thermostats) · `NTD` · `ETRV`
(sous-appareils derrière une passerelle) · `EWS` (contact sec **et** fil
pilote) · `UFH` (plancher chauffant/rafraîchissant).

Deux d'entre eux seulement ont été vérifiés sur du matériel réel. Les autres
conservent le comportement de la librairie de référence, qui est une hypothèse
et non une garantie — le tableau ci-dessous dit précisément lequel est lequel.

| Modèle                               | Liste des modes           | Consignes par mode        | Routage des commandes            |
| ------------------------------------ | ------------------------- | ------------------------- | -------------------------------- |
| `EV30`                               | mesuré + capture de l'app | **oui**, capture de l'app | mesuré                           |
| `EWS` fil pilote (`deviceType: 1`)   | mesuré + capture + notice | non (pas de sonde)        | mesuré                           |
| `EWS` relais (`deviceType: 0`)       | hérité                    | non                       | hérité                           |
| `EWS` fil pilote, autre `deviceType` | hérité                    | non                       | hérité                           |
| `ECTRL`, `ESTAT`, `RSS-ECTRL`        | hérité                    | **oui — NON VÉRIFIÉ**     | hérité                           |
| `NTD`, `ETRV`                        | hérité                    | non                       | hérité, passerelle jamais testée |
| `UFH`                                | hérité                    | non                       | hérité, passerelle jamais testée |

> **Non vérifié :** `ECTRL`, `ESTAT` et `RSS-ECTRL` reçoivent les trois
> consignes par mode (Consigne Confort / Éco / Hors gel) uniquement parce que ce
> sont des thermostats de la même famille que l'`EV30`, avec les mêmes champs
> `overrideTemp` et `comfLimitMin`/`comfLimitMax`. Personne n'a confirmé que ces
> modèles acceptent l'écriture. Si vous en possédez un, voir
> [Signaler votre modèle](#signaler-votre-modèle).

## Divergences avec la référence

Chacune repose sur une mesure ou sur une capture du trafic réseau de
l'application officielle, et chacune contredit `pyaxencoapi` et l'intégration
Home Assistant.

| Sujet                        | Référence                                                   | Réalité                                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Auto**                     | `targetMode: 60`                                            | `targetMode: 0`. 60 et 61 répondent `200` et ne changent rien — Auto ne fonctionne donc pas non plus sous Home Assistant. Un appareil en Auto _renvoie_ 60 (Auto Confort) ou 61 (Auto Éco), ce qui faisait paraître 60 correct |
| **Dérogation**               | écrire `targetMode: 8`, puis la température                 | le mode 8 seul est ignoré ; l'app envoie `targetTemp` + `overrideTemp` + `targetMode: 8` en un seul appel                                                                                                                      |
| **Consignes par mode**       | pas exposées du tout                                        | `comfTemp` / `ecoTemp` / `antifTemp` sont réglables, les trois ensemble                                                                                                                                                        |
| **Capteurs gratuits**        | pas exposés du tout                                         | signal, présence, fenêtre ouverte, verrouillage clavier et défaut système voyagent déjà dans l'état récupéré                                                                                                                   |
| **`UFH`**                    | `select.py` écrit le mode sur le `_id` de l'appareil        | un UFH est un sous-appareil dont le mode vit sur `changeOverUser` ; la route dédiée que `pyaxencoapi` fournit est utilisée à la place                                                                                          |
| **`EWS` fil pilote**         | 10 presets pour tout module                                 | 8 sur celui qui a été mesuré, et `comfort_plus` est refusé. Le menu de l'app MyNeomitis masque deux ordres que le matériel émet réellement (Éco 1K / Éco 2K)                                                                   |
| **`parents`**                | une chaîne dans `api.py`, un dictionnaire dans `climate.py` | les deux formes sont gérées ; chaque source plante sur la forme de l'autre                                                                                                                                                     |
| **Événements link / unlink** | fournis mais jamais utilisés                                | câblés : appairer un appareil dans l'app déclenche un re-scan                                                                                                                                                                  |
| **Token WebSocket**          | passé une fois à la connexion                               | renouvelé avant chaque reconnexion : `socket.io-client` traite un refus de poignée de main comme définitif, ce qui dégradait silencieusement tout vers le sondage périodique                                                   |

## Fonctionnement

```
                       REST (login, appareils, commandes)
  Gladys  ◀── SDK ──▶  index.js  ◀────────────────────▶  cloud Axenco
                          │        Socket.IO (push)
                          ├── src/devices/   à quoi ressemble un appareil dans Gladys
                          └── src/gladys/    comment l'état parvient à Gladys
```

| Chemin                              | Rôle                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `index.js`                          | Câblage SDK et cycle de vie : connexion, découverte, routage des commandes, reprise                  |
| `src/axenco/client.js`              | Portage de `pyaxencoapi` : authentification et renouvellement de token, REST, Socket.IO, reconnexion |
| `src/axenco/const.js`               | Presets, listes de modes par modèle, constantes du protocole                                         |
| `src/axenco/utils.js`               | Aides passerelle / `rfid` / `parents`                                                                |
| `src/devices/profiles.js`           | Ce que chaque modèle expose, sous forme de capacités                                                 |
| `src/devices/features.js`           | La composition des features Gladys, et pourquoi le mode est un jeu d'interrupteurs                   |
| `src/devices/index.js`              | État Axenco ⇄ états Gladys, et routage des commandes                                                 |
| `src/gladys/publisher.js`           | Déduplication, découpage en lots, badge de transport                                                 |
| `src/gladys/reconciler.js`          | Relecture après commande : Axenco répond `200` même quand l'appareil ignore l'ordre                  |
| `src/config.js` · `src/selector.js` | Valeurs de configuration par défaut, sélecteurs sans collision                                       |

Deux choix de conception à connaître avant de lire le code.

**Le mode est un jeu d'interrupteurs binaires exclusifs**, pas une liste
déroulante. Gladys choisit son widget dans une table de types figée, et tous les
widgets de liste ont leurs options codées en dur dans le front : l'interrupteur
binaire est le seul contrôle modifiable dont les libellés et les valeurs nous
appartiennent. Le raisonnement complet, y compris le bug `preact-i18n` amont qui
disqualifie `supported_options`, est dans [`docs/fr.md`](docs/fr.md).

**Les états publiés juste après une commande sont optimistes et peuvent être
faux.** Axenco répond `200` à des valeurs que l'appareil ignore ensuite, et ces
radiateurs perdent des commandes rapprochées. `src/gladys/reconciler.js` relit
l'appareil 30 s plus tard et publie ce qu'il rapporte vraiment, en journalisant
tout écart.

## Développement

```bash
npm install
npm test            # node --test, sans framework
npm run lint
npm run format:check
```

Exécution contre un Gladys local :

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="myneomitis-axenco" \
LOG_LEVEL=debug \
npm start
```

Validation identique à celle du store, avant publication :

```bash
npx github:GladysAssistant/integration-store .
```

### Scripts de diagnostic

Ils interrogent l'API Axenco avec votre propre compte, demandent les
identifiants en interactif pour que rien n'atterrisse dans l'historique du
shell, et n'affichent jamais de token.

```bash
node scripts/dump-devices.mjs                     # état brut de chaque appareil
node scripts/sweep-modes.mjs                      # liste les appareils
node scripts/sweep-modes.mjs <deviceId>           # rapport en lecture seule
node scripts/sweep-modes.mjs <deviceId> --apply   # ce que l'appareil accepte vraiment
```

`sweep-modes.mjs --apply` change réellement le mode d'un radiateur plusieurs
fois sur deux minutes, puis restaure tous les champs touchés. Choisissez un
appareil dont vous ne dépendez pas sur le moment. Il observe par WebSocket et
confirme une base avant chaque test, en rendant _non concluant_ plutôt qu'un
verdict quand il ne peut pas — pas de donnée vaut mieux qu'une fausse donnée.

### Signaler votre modèle

Si votre appareil affiche des modes qu'il n'a pas, en manque un qu'il possède,
ou refuse une consigne, deux commandes tranchent :

```bash
node scripts/dump-devices.mjs
node scripts/sweep-modes.mjs <deviceId> --apply
```

Ouvrez une [issue](https://github.com/Dreamthy/gladys-neomitis/issues) avec les deux sorties et la liste des modes que montre
l'application MyNeomitis pour cet appareil. Les sous-appareils (`NTD`, `ETRV`,
`UFH`) passent par leur passerelle, dont la forme des réponses n'a jamais été
observée : le balayage les refuse, mais le dump seul est déjà utile.

## Tester un build dans Gladys

1. **Actions → Build and publish image → Run workflow** sur n'importe quelle
   branche.
2. Ouvrez le **Job Summary** de l'exécution : il contient le manifeste avec
   `docker_image` déjà pointé sur l'image qui vient d'être publiée.
3. Dans Gladys : **Intégrations → Installer une intégration → Mode développeur**,
   collez ce manifeste.

Le package GHCR doit être public pour que Gladys puisse le récupérer
anonymement (Package settings → Change visibility → Public), au premier build
seulement.

## Publication

**Actions → Release → Run workflow**, puis `patch` / `minor` / `major`. Le
workflow incrémente `package.json` et le manifeste (`version` **et** le tag de
`docker_image`), pousse le tag `vX.Y.Z` et construit l'image multi-architecture
(`linux/amd64` + `linux/arm64`).

Pour que l'indexeur du store la reprenne, le dépôt doit aussi porter le topic
GitHub `gladys-assistant-integration`.

## Crédits

- Intégration Home Assistant [`myneomitis`](https://www.home-assistant.io/integrations/myneomitis) par @Epyes
- Librairie Python `pyaxencoapi`, dont ce portage reprend le protocole

## Licence

Apache-2.0 — voir [`LICENSE`](LICENSE).
