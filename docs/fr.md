# MyNeomitis (Axenco) pour Gladys Assistant

**Version 1.1 — Gladys ≥ 5.2 :** lire le [guide de migration](upgrade.fr.md)
pour les nouvelles commandes, le thermostat natif, le widget et les scènes.
Les sections ci-dessous décrivent aussi les fonctionnalités historiques.

Cette intégration pilote depuis Gladys les radiateurs, thermostats et modules
**Neomitis / Axenco** gérés par l'application mobile **MyNeomitis**. Elle est le
portage en JavaScript de l'intégration Home Assistant `myneomitis` et de la
librairie `pyaxencoapi` : mêmes appels REST, même canal temps réel, mêmes
modèles pris en charge.

Elle passe par le **cloud Axenco** (il n'existe pas d'API locale) : vos
appareils doivent déjà être appairés dans l'application MyNeomitis, et une
connexion Internet est nécessaire.

## Installation

1. Installez l'intégration depuis le magasin de Gladys.
2. Ouvrez l'onglet **Configuration** et saisissez l'**adresse e-mail** et le
   **mot de passe** de votre compte MyNeomitis — les mêmes que dans
   l'application mobile. Il n'y a pas d'OAuth2 chez Axenco.
3. Laissez l'**intervalle de rafraîchissement** sur 300 s sauf besoin
   particulier : les changements arrivent normalement en temps réel par
   WebSocket, cet intervalle n'est qu'un filet de sécurité si un message est
   perdu.
4. Allez dans **Découverte** : tous les appareils reconnus de votre compte
   apparaissent. Créez ceux que vous voulez utiliser.

L'indicateur de connexion de l'écran Configuration passe au vert une fois la
session Axenco établie. S'il reste rouge, le message affiché distingue un
identifiant refusé d'un cloud injoignable.

## Appareils pris en charge

| Modèle      | Type                                      | Ce que Gladys expose                                     |
| ----------- | ----------------------------------------- | -------------------------------------------------------- |
| `EV30`      | Thermostat / radiateur                    | Températures + 7 modes                                   |
| `ECTRL`     | Thermostat / radiateur                    | Températures + 8 modes                                   |
| `ESTAT`     | Thermostat / radiateur                    | Températures + 8 modes                                   |
| `RSS-ECTRL` | Thermostat / radiateur                    | Températures + 8 modes                                   |
| `NTD`       | Sous-thermostat (derrière une passerelle) | Températures + 6 modes + état chauffage/rafraîchissement |
| `ETRV`      | Tête thermostatique (sous-appareil)       | Températures + 5 modes                                   |
| `EWS`       | Module sans fil, contact sec              | 3 modes : Marche / Arrêt / Auto                          |
| `EWS`       | Module sans fil, fil pilote               | 7 modes (`deviceType: 1`), sinon 10                      |
| `UFH`       | Plancher chauffant/rafraîchissant         | Bascule Chauffage / Rafraîchissement                     |

Le mode d'un `EWS` dépend de son câblage : Axenco le signale par
`state.deviceType` (`0` = contact sec, autre = fil pilote), et l'intégration
choisit la bonne liste de modes toute seule.

Les sous-appareils (`NTD`, `ETRV`, `UFH`) sont pilotés à travers leur
passerelle : l'intégration retrouve celle-ci dans le champ `parents` de
l'appareil et l'adresse par son `rfid`.

## Features créées dans Gladys

Un appareil Axenco devient **un appareil Gladys portant plusieurs fonctionnalités**.
Il fonctionne de manière autonome : créer un thermostat Gladys est facultatif.

- **Température actuelle** — capteur, en °C, historisée (graphiques).
- **Température de consigne** — consigne réglable. Ses bornes viennent de l'appareil
  lui-même (`comfLimitMin` / `comfLimitMax`), pas d'un 7–30 °C figé : un
  radiateur limité à 16–21 °C affichera bien 16–21 °C. Sur EV30, elle suit la
  consigne effective du mode en cours. En veille, elle mémorise la valeur sans
  réveiller le radiateur : reprendre par le mode ou une dérogation explicite.
- **Mode Axenco** — sélecteur unique des modes propres au modèle : Confort,
  Éco, Auto, Boost, Veille, etc. Il fonctionne sans thermostat Gladys.
  L'option **Dérogation (consigne actuelle)**, sur les appareils régulant une
  température, réutilise la dernière consigne Axenco observée. Pour choisir une
  autre température, régler **Température de consigne** ou utiliser le widget.
- **Détail du mode** — le widget affiche « Auto (Confort) », « Auto (Éco) » et
  les codes inconnus depuis les états matériels observés. Le sélecteur reste
  sur « Auto ». Le champ texte **Mode actuel (compatibilité)** est conservé
  uniquement lorsqu'il existe déjà ; les appareils sans sélecteur gardent
  leur indication en lecture seule.
- **Fenêtre ouverte** — contact standard Gladys : `0` ouvert, `1` fermé.
  L'ancien capteur aux valeurs inversées subsiste uniquement s'il existe déjà,
  sous **Fenêtre ouverte (compatibilité)**, pour préserver les scènes.
- **Anciens interrupteurs de modes** — « Auto », « Confort », « Éco »,
  « Hors gel », « Boost », « Veille »… Ils sont conservés uniquement lorsqu'ils
  existent déjà dans Gladys, pour préserver vos scènes. Les nouveaux appareils
  utilisent le sélecteur à leur place. Auto est un mode comme les autres
  (`targetMode: 0`) : le sélectionner sort des modes manuels, et inversement.
- **Consigne Confort / Consigne Éco / Consigne Hors gel** — les températures
  que les modes utilisent, réglables. Elles restent distinctes de la consigne
  commune ; modifier cette dernière en fonctionnement lance une dérogation. Ni `pyaxencoapi` ni
  l'intégration Home Assistant ne les exposent.
  Réservées aux appareils qui **régulent** une température. Un `EWS` rapporte
  bien ces trois champs, mais les refuse en écriture : il pilote un fil pilote
  et n'a pas de sonde, donc rien à réguler. Un `UFH` est exclu pour la même
  raison, les sous-appareils parce que la charge indexée par `rfid` n'a jamais
  été observée.
- **Rafraîchissement** — interrupteur chauffage/rafraîchissement, réglable sur
  `UFH`, en lecture seule sur `NTD`.
- **Capteurs en lecture seule** — **Signal** (qualité de réception, en barres
  d'antenne), **Présence**, **Fenêtre ouverte**, **Verrouillage clavier** et
  **Défaut système**. Ces valeurs voyagent déjà dans l'état que l'appareil
  envoie : aucun appel supplémentaire, aucun réglage à faire. Chaque appareil
  n'expose que celles qu'il rapporte réellement. Le défaut système est publié
  tel quel — 0 signifie « aucun défaut » sur tous les appareils observés, une
  valeur non nulle est probablement un code. Ni `pyaxencoapi` ni l'intégration
  Home Assistant ne les exposent.

Les anciens interrupteurs de mode sont **exclusifs** : en activer un envoie ce mode à
Axenco et éteint les autres dans la foulée. Les **éteindre** directement ne
fait rien — un appareil Axenco est toujours dans un mode, il n'existe pas de
« aucun mode » à envoyer ; l'interrupteur revient donc à son état réel.

En fonctionnement, régler la **température de consigne** crée une **dérogation** : une consigne
différente de celle paramétrée pour le mode en cours. L'intégration envoie le
même appel que l'application officielle, `targetTemp` + `overrideTemp` +
`targetMode: 8` d'un seul coup. `climate.py` écrit le mode d'abord puis la
température ; ce premier appel est sans effet, mesuré.

## Modes standard et compatibilité historique

Depuis la version 1.1, le relais EWS expose un vrai Marche/Arrêt, le fil pilote
un sélecteur standard, et l'EV30 un **Mode du radiateur** avec une consigne
commune au pilotage direct et au thermostat Gladys.
Les anciens interrupteurs de modes restent disponibles avec les mêmes ids et
le même comportement : leur extinction ne transmet pas un ordre d'arrêt.
Les options par appareil sont déclarées avec `supported_options`. Le widget
Neomitis propose les températures en direct et deux commandes :
Mode et Consigne. Auto et Veille restent accessibles dans le choix du mode. Les détails de connexion
sont facultatifs ; les anomalies et l'état de fenêtre restent visibles.
Voir le [guide de migration et de configuration du thermostat](upgrade.fr.md).

## Utilisation dans les scènes

Chaque interrupteur de mode est une feature comme une autre : une scène peut
« allumer » _Salon – Éco_ le soir et _Salon – Confort_ le matin. Sur les nouveaux
appareils, utiliser le sélecteur **Mode Axenco**. Le texte historique
_Mode actuel (compatibilité)_ reste disponible seulement s'il existe déjà.

## Limites connues

- **Cloud uniquement.** Aucune API locale n'existe. Chaque appareil porte un
  badge indiquant s'il est joignable ; un appareil hors ligne côté Axenco
  apparaît comme injoignable dans Gladys.
- **« Auto » est `targetMode: 0`, pas 60.** `pyaxencoapi` documente 60, et
  l'intégration Home Assistant l'envoie ; mesuré sur du matériel réel, 60 et 61
  répondent 2xx et ne changent rien. La vraie valeur a été capturée dans le
  trafic réseau de l'application officielle : `{"targetMode": 0}`. Un appareil
  en Auto renvoie 60 ou 61, donc les trois codes se décodent en Auto en
  lecture — c'est cette asymétrie lecture/écriture qui faisait paraître la
  librairie de référence correcte.

- **Un code inconnu reste visible.** Un mode qu'Axenco renverrait sans que
  l'intégration le connaisse s'affiche « Inconnu (42) » dans le widget, ainsi que
  dans l'ancien texte s'il existe, plutôt que d'être ignoré silencieusement — c'est ainsi que le cas du 61
  a été repéré.
- **`EWS` fil pilote : la liste de modes dépend du `deviceType`.**
  `pyaxencoapi` et `select.py` annoncent dix presets pour tout EWS fil pilote —
  c'est l'union de ce que sait faire le matériel Axenco, pas ce qu'un module
  donné propose. Un module vérifié reçoit sa vraie liste ; tous les autres
  gardent celle de la source.
  Un seul l'a été à ce jour : **`deviceType: 1`** (EWSFPNEOA), mesuré au
  WebSocket et recoupé avec sa notice. Il émet **sept ordres** — confort, éco,
  éco -1, éco -2, hors gel, veille, boost — plus le mode auto par le drapeau
  `autoProgram`. À noter : le menu de l'application MyNeomitis n'en montre que
  six, il masque éco -1 et éco -2, alors que la notice les nomme
  explicitement (« Mode Éco, Éco-1 ou Éco-2 ») et que le module pilote « un fil
  pilote 4 ou 6 ordres ». `comfort_plus` en revanche est bien absent, ignoré
  deux fois par le matériel. Et d'après la notice, **Boost n'a d'effet que si
  le radiateur raccordé sait interpréter cet ordre** sur le fil pilote.
  Si votre EWS rapporte un autre `deviceType`, envoyez la sortie de
  `node scripts/sweep-modes.mjs <id> --apply` et votre liste sera ajoutée. Le
  défaut reste volontairement la liste large : un mode inutile est visible et
  sans danger, un mode masqué est une perte silencieuse de fonctionnalité.
- **`UFH` : divergence assumée avec la source Home Assistant.** `select.py`
  écrit le mode d'un UFH avec `set_device_mode` sur son `_id`, alors qu'un UFH
  est un sous-appareil et que son mode vit sur `changeOverUser`. Cette
  intégration utilise la route sous-appareil dédiée que `pyaxencoapi` fournit
  précisément pour ce cas (`set_sub_device_mode_ufh`).
- **Le programme hebdomadaire n'est pas exposé.** L'appel existe côté client
  (`setDeviceProgram`), l'édition de ce programme Axenco reste dans MyNeomitis.
  Le planning du thermostat natif Gladys est une alternative distincte. Le mode
  « Auto » suit ce programme.
- **Les commandes historiques publient de manière optimiste.** Leurs valeurs
  demandées sont corrigées par les observations suivantes. La consigne
  commune EV30 utilise les retours confirmés du matériel ; voir le guide de
  migration.

## État de vérification par modèle

Tout ce qui suit concerne le **protocole**, identique pour tous les modèles :
`auto` s'écrit `targetMode: 0`, la dérogation n'est pas un mode sélectionnable,
et une consigne s'envoie `targetTemp` + `overrideTemp` + `targetMode: 8`. Ces
trois points valent donc aussi pour les modèles ci-dessous marqués « hérité ».

Ce qui reste propre à chaque modèle, c'est la **liste des modes**.

| Modèle                               | Liste des modes           | Routage des commandes            |
| ------------------------------------ | ------------------------- | -------------------------------- |
| `EV30`                               | mesuré + capture de l'app | mesuré                           |
| `EWS` fil pilote (`deviceType: 1`)   | mesuré + capture + notice | mesuré                           |
| `EWS` relais (`deviceType: 0`)       | hérité de `select.py`     | hérité                           |
| `EWS` fil pilote, autre `deviceType` | hérité de `pyaxencoapi`   | hérité                           |
| `ECTRL`, `ESTAT`, `RSS-ECTRL`        | hérité de `pyaxencoapi`   | hérité                           |
| `NTD`, `ETRV`                        | hérité de `pyaxencoapi`   | hérité, passerelle jamais testée |
| `UFH`                                | hérité de `pyaxencoapi`   | hérité, passerelle jamais testée |

« Hérité » veut dire : le comportement de la librairie de référence, conservé
tel quel faute de matériel pour le vérifier. Or cette librairie s'est trompée
sur deux points au moins, donc traitez ces lignes comme des hypothèses.

Le cas le plus douteux est `comfort_plus` (code 20), que `pyaxencoapi` attribue
aux `ECTRL` / `ESTAT` / `RSS-ECTRL`. Il est ignoré par un EV30 et par un EWS,
tous deux mesurés. Il est conservé pour ces trois modèles parce que rien ne
prouve qu'il n'y existe pas — un mode inutile est visible et sans danger, un
mode masqué est une perte silencieuse.

**Si vous possédez un de ces modèles**, deux commandes suffisent à faire
corriger la liste :

```bash
node scripts/dump-devices.mjs                      # l'état brut de vos appareils
node scripts/sweep-modes.mjs <deviceId> --apply    # ce que l'appareil accepte vraiment
```

Envoyez les deux sorties, avec la liste des modes que montre l'application
MyNeomitis pour cet appareil. Le balayage ne gère pour l'instant que les
appareils principaux : un `NTD`, un `ETRV` ou un `UFH` passe par sa passerelle,
dont je n'ai jamais observé la forme des réponses.

## Dépannage

- **« MyNeomitis a refusé ces identifiants »** — vérifiez l'e-mail et le mot de
  passe dans l'application mobile. L'intégration ne réessaie pas en boucle
  serrée sur une erreur d'authentification.
- **Aucun appareil dans Découverte** — seuls les modèles du tableau ci-dessus
  sont repris. Les logs du conteneur indiquent combien d'appareils ont été vus
  et combien ont été ignorés.
- **« Pas de valeur récente »** — Axenco n'émet que sur changement. L'état
  connu est publié à la création de l'appareil et à chaque rafraîchissement
  périodique ; attendez un cycle.
- **Plus de mises à jour temps réel** — le canal WebSocket se reconnecte tout
  seul, et le rafraîchissement périodique prend le relais entre-temps. Passez
  `LOG_LEVEL` à `debug` pour voir les événements reçus.

## Suppression

Désinstallez l'intégration depuis Gladys : le conteneur est supprimé et les
appareils créés disparaissent avec lui. Rien n'est modifié côté compte
MyNeomitis — vos appareils restent appairés dans l'application mobile.
