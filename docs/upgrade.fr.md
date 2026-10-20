# Version 1.1 : migration vers Gladys 5.2

Cette version nécessite **Gladys 5.2 ou plus récent** et utilise le SDK 0.15.
Le thermostat natif et les interfaces déclaratives de Gladys fournissent le
planning, les préréglages, les scènes et les widgets. L'intégration conserve
la communication avec le cloud Axenco : une coupure Internet empêche les
nouvelles commandes, même si le planning Gladys continue à tourner localement.

## Mettre à jour les appareils existants

1. Mettre Gladys à jour, puis installer la nouvelle image de l'intégration.
2. Ouvrir **Découverte** et utiliser **Mettre à jour** sur chaque appareil.
   Ne pas supprimer puis recréer les appareils : leurs identifiants et ceux
   des fonctionnalités historiques sont conservés pour les scènes existantes.
3. Les nouvelles fonctionnalités ne reçoivent des états qu'une fois créées.
4. Choisir un seul responsable du planning d'une zone : Gladys ou MyNeomitis.

## Pilotage direct, sans thermostat Gladys

Le thermostat Gladys est optionnel, appareil par appareil. **Mode Axenco**
permet de sélectionner directement les modes du radiateur. **Température de
consigne** est la consigne commune aux commandes directes, aux scènes et au
thermostat Gladys. Son identifiant historique `target-temperature` est conservé.
Les programmes fabricant, consignes par mode, capteurs, widget Neomitis et
scènes restent utilisables sans créer de thermostat Gladys.

Sur EV30, modifier la consigne pendant la veille mémorise la valeur sans
rallumer le radiateur. Pour reprendre, sélectionner **Chauffage** dans **Mode
du radiateur**, un mode actif dans **Mode Axenco**, ou utiliser l'action
**Appliquer une dérogation** du widget ou des scènes. Cette dernière applique
explicitement la température et démarre la dérogation en une seule commande.
Les autres modèles conservent leur commande de température historique.

Après un scan, utiliser **Mettre à jour** dans Découverte. Les anciens
interrupteurs de modes déjà créés conservent leurs identifiants pour les
scènes existantes. Les nouveaux appareils utilisent uniquement le sélecteur.
**Dérogation (consigne actuelle)** applique la dernière consigne Axenco
observée ; sur EV30, il s'agit de la consigne effective du mode en cours.
Les codes Auto `0`, `60` et `61` sont regroupés en une option Auto ; le texte
**Mode actuel** garde la distinction Confort/Éco et signale les codes inconnus.

## EV30 : thermostat réel dans Gladys

Créer un **thermostat réel** dans **Intégrations → Thermostat** et sélectionner :

| Réglage                | Fonctionnalité de l'EV30                                 |
| ---------------------- | -------------------------------------------------------- |
| Consigne               | **Température de consigne**                              |
| Mode de fonctionnement | **Mode du radiateur**                                    |
| Température mesurée    | **Température actuelle**                                 |
| État de chauffe        | Laisser vide : aucune mesure de chauffe n'a été vérifiée |
| Fenêtre                | Voir la section dédiée ci-dessous                        |

**Mode du radiateur** est l'ancien **Mode thermostat Gladys**, renommé sans
changer son identifiant. C'est le mode physique Arrêt/Chauffage du radiateur.
Il faut le sélectionner pour permettre au thermostat Gladys de mettre le
radiateur en veille et de le reprendre ensuite. Aucun calcul d'hystérésis ou
de TPI n'est ajouté à l'EV30 : il régule lui-même.

Le planning et les préréglages Confort/Éco/Nuit/Absence sont ceux de Gladys.
Désactiver le programme fabricant avant de confier le planning à Gladys.
**Planning Gladys** et **Auto MyNeomitis** sont deux mécanismes distincts.
Pour arrêter durablement une zone gérée par Gladys, arrêter le thermostat de
planning : un programme encore actif peut reprendre la main sur le radiateur.

### Appareils ayant déjà l'ancienne consigne supplémentaire

Les nouveaux appareils ne créent plus **Consigne thermostat Gladys**. Si cette
fonctionnalité existe déjà, elle est conservée sous le nom **Consigne
(compatibilité)**, avec le même identifiant `thermostat-temperature`, le même
historique et exactement le même comportement que la consigne commune. Une
commande ou une observation synchronise les deux : elles n'ont plus de logique
indépendante.

Cette conservation est nécessaire : Gladys supprime une fonctionnalité omise
lors de la mise à jour d'un appareil, sans que l'intégration puisse migrer les
références des thermostats ou des scènes. Pour utiliser uniquement la consigne
commune, sélectionner **Température de consigne** dans le thermostat existant
et remplacer les références à l'ancienne consigne dans les scènes et widgets
avant de retirer cette ancienne fonctionnalité. Ne pas supprimer l'appareil.
Une ancienne consigne retirée n'est pas recréée lors des scans suivants.

### Arrêt, reprise et consignes

- **Arrêt** envoie l'ordre Veille Axenco déjà mesuré sur EV30.
- La consigne de repli écrite ensuite par Gladys est mémorisée sans envoyer
  `targetMode: 8`, ce qui préserve la veille physique.
- L'intention d'arrêt et la consigne en attente sont enregistrées dans `/data`
  et survivent au redémarrage du conteneur. Une indisponibilité Axenco ou une
  commande ignorée reste signalée comme un échec.
- Une reprise suivie d'une consigne est regroupée en une seule commande de
  température. Sans nouvelle consigne, la valeur mémorisée est utilisée.
  Une nouvelle demande d'arrêt ou de mode Axenco annule la reprise en attente.
- Pendant l'arrêt, la consigne représente la valeur mémorisée, pas une
  température actuellement appliquée au radiateur.
- En fonctionnement, la consigne suit les observations du matériel, y compris
  les températures Confort/Éco en Auto. La réponse HTTP 200 ne vaut pas
  confirmation ; une ancienne valeur `overrideTemp` ne remplace pas la
  consigne effective du mode en cours.
- Un changement de mode Axenco explicite synchronise l'intention d'arrêt.
  Les changements physiques observés la synchronisent également lorsqu'aucun
  ordre de mode n'est encore en attente de confirmation.

**Bornes :** la plage annoncée par l'appareil est conservée, avec un pas de
0,5 °C pour EV30. Si elle commence à 16 °C, un préréglage Hors gel de 7 °C sera
limité par Gladys à 16 °C. Le mode Arrêt reste protégé par Veille ; aucun
élargissement des bornes ou nouveau payload Axenco n'est introduit.

En cas de commande ignorée, la dernière consigne confirmée est conservée pour
ne pas transformer une correction en dérogation manuelle Gladys. L'événement
de commande non confirmée et les logs signalent l'écart. Le planning peut
réessayer au passage suivant. Tant qu'une consigne reste en attente, les
valeurs divergentes ne sont pas présentées comme des changements manuels.

Les modèles `ECTRL`, `ESTAT`, `RSS-ECTRL`, `NTD` et `ETRV` conservent leurs
commandes historiques. La protection d'arrêt et le mode standard restent
réservés à **EV30**, dont le protocole a été mesuré. Le portage aux autres
modèles demande une validation matérielle et des routes de passerelle.

## Relais et fil pilote EWS

- **Contact sec** : la nouvelle fonctionnalité **Marche / Arrêt** transmet
  réellement les deux ordres. Elle peut servir d'actionneur à un thermostat
  virtuel avec une sonde indépendante. Le protocole de ce modèle reste hérité
  et demande une vérification sur votre installation.
- **Fil pilote** : **Ordre fil pilote** expose les six ordres standard supportés
  par le profil, avec conversion des valeurs Gladys vers les codes Axenco.
  Auto et Boost restent accessibles avec les commandes historiques.
- Le thermostat virtuel de Gladys 5.2 ne sait pas piloter directement un ordre
  fil pilote. Les interrupteurs historiques de modes ne sont pas de véritables
  Marche/Arrêt et ne doivent pas être choisis comme actionneurs binaires.

## Fenêtre ouverte

La correspondance du champ Axenco est commune aux appareils pris en charge :
`windowStatus: false` signifie fermé et `true` signifie ouverture détectée.
Lorsque l'appareil remonte ce champ comme booléen (ou comme `0` / `1`), l'intégration propose automatiquement **Contact fenêtre pour
thermostat**, avec les valeurs attendues par Gladys : `1` fermé et `0` ouvert.
Il n'y a plus de réglage de correspondance dans la configuration.

Après un scan et la mise à jour de l'appareil, sélectionner cette
fonctionnalité dans le thermostat si l'on souhaite suspendre le chauffage
pendant une détection d'ouverture. Le capteur historique **Fenêtre ouverte**
garde son identifiant et ses anciennes valeurs pour les scènes existantes.

Les appareils qui ne remontent pas ce champ n'exposent pas de contact fenêtre.
Cette traduction du capteur est indépendante de la prise en charge des
commandes du thermostat natif, qui reste propre au modèle.

## Widget, scènes et diagnostics

Le widget **Radiateur Neomitis** affiche les dernières températures disponibles,
le mode Axenco, l'accès cloud, le canal temps réel et l'âge de la dernière
lecture REST. Ses formulaires permettent une commande directe de mode ou une
dérogation en **°C**, y compris si les valeurs affichées sont converties en °F.
Ces commandes directes conservent le comportement historique : une dérogation
peut réveiller un appareil en veille. Utiliser le widget thermostat natif pour
les zones dont Gladys gère le planning.

Actions de scène : **Choisir le mode Axenco**, **Appliquer une dérogation**,
**Reprendre le programme MyNeomitis**, **Mettre en marche / arrêter l’appareil**.
Les modes sont vérifiés contre le profil de l'appareil. La dernière action
agit sur le contrôle de l'appareil (EV30 ou relais EWS), pas sur le thermostat
de planning créé par Gladys. Un planning encore actif peut donc reprendre la
main ; pour l'arrêter durablement, utiliser son action générique de mode.
Le résultat `accepted` signifie que la demande a été acceptée ; la confirmation
physique se fait ensuite.

Le déclencheur **Commande non confirmée** fournit l'appareil, la fonctionnalité
et le motif d'échec. Il peut lancer une notification. Le contrôle après
commande intervient à 30 secondes sur les appareils principaux, et compare
les codes Auto `0`, `60` et `61` selon leur sens. Il n'est pas disponible sur
les sous-appareils dont la réponse de passerelle n'a pas été vérifiée.

Une perte du temps réel affiche un état cloud dégradé ; les relectures REST
continuent. Une panne REST affiche une déconnexion et un appareil injoignable,
puis les indicateurs reviennent à la normale à la reprise. Une absence de
changement n'est pas assimilée à une panne. Les états fraîchement relus et
inchangés sont renvoyés au plus toutes les 30 minutes.

Les commandes sont ordonnées par appareil. Une demande restée plus d'une
seconde en attente n'est pas envoyée tardivement ; un événement d'échec est
publié. Les écritures HTTP Axenco ont un budget de 3,5 secondes, renouvellement
de token inclus, pour laisser du temps à l'accusé de réception Gladys. Un
timeout ne prouve pas l'absence d'effet physique : vérifier le retour matériel.

## Développement et publication

`npm test`, `npm run lint` et `npm run format:check` vérifient le projet.
Le validateur officiel du store est exécuté en CI avec `--skip-image-check`,
car l'image de la PR n'existe pas encore. La release valide l'image publiée
avant de pousser le nouveau manifeste sur la branche et de créer la release.

En développement, les intentions du thermostat sont stockées dans `.data/`
(ignoré par Git). `NEOMITIS_DATA_DIR` permet d'utiliser un autre répertoire.
En production, le stockage par défaut est `/data`, le volume autorisé par Gladys.
Les tests utilisent des doubles, dont celui du SDK officiel : ils ne prouvent
pas le fonctionnement physique du chauffage.
