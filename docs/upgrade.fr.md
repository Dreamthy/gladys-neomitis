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
   des fonctionnalités historiques sont conservés pour les scènes existantes,
   sauf le doublon EWS `pilot-wire-mode`, retiré comme expliqué ci-dessous.
3. Les nouvelles fonctionnalités ne reçoivent des états qu'une fois créées.
4. Choisir un seul responsable du planning d'une zone : Gladys ou MyNeomitis.

## Pilotage direct, sans thermostat Gladys

Le thermostat Gladys est optionnel, appareil par appareil. **Mode Axenco**
permet de sélectionner directement les modes du radiateur. **Température de
consigne** est la consigne commune aux commandes directes, aux scènes et au
thermostat Gladys. Son identifiant historique `target-temperature` est conservé.
Les programmes fabricant, consignes par mode, capteurs, widget Neomitis et
scènes restent utilisables sans créer de thermostat Gladys.

Sur EV30, ECTRL, ESTAT, RSS-ECTRL, NTD et ETRV, modifier la consigne pendant la veille mémorise la valeur sans
rallumer le radiateur. Pour reprendre, sélectionner **Chauffage** dans **Mode
du radiateur**, un mode actif dans **Mode Axenco**, ou utiliser l'action
**Appliquer une dérogation** du widget ou des scènes. Cette dernière applique
explicitement la température et démarre la dérogation. Les appareils principaux
utilisent leur commande de température existante ; NTD et ETRV passent par
leur passerelle avec deux appels successifs : mode Dérogation, puis consigne.

Après un scan, utiliser **Mettre à jour** dans Découverte. Les anciens
interrupteurs de modes déjà créés conservent leurs identifiants pour les
scènes existantes. Les nouveaux appareils utilisent uniquement le sélecteur.
**Dérogation (consigne actuelle)** applique la dernière consigne Axenco
observée ; sur EV30, il s'agit de la consigne effective du mode en cours.
Les codes Auto `0`, `60` et `61` sont regroupés en une option Auto. Le widget
affiche **Auto (Confort)** ou **Auto (Éco)** et les codes inconnus directement
depuis le dernier état matériel observé. Les nouveaux appareils à sélecteur ne
créent plus de champ texte supplémentaire. Un **Mode actuel** déjà créé reste
présent comme **Mode actuel (compatibilité)** pour préserver ses références.
Les appareils sans sélecteur, comme UFH, gardent leur indication en lecture seule.

## Appareils à consigne : thermostat réel dans Gladys

Le mode physique et la protection arrêt/reprise sont disponibles sur **EV30,
ECTRL, ESTAT, RSS-ECTRL, NTD et ETRV**. Cette prise en charge logicielle ne
constitue pas une validation matérielle des cinq derniers modèles.

Créer un **thermostat réel** dans **Intégrations → Thermostat** et sélectionner :

| Réglage                | Fonctionnalité de l'appareil                             |
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
de TPI n'est ajouté : ces appareils régulent eux-mêmes.

Sur **NTD**, le mode indique Chauffage ou Rafraîchissement selon
`changeOverUser`. Il permet l'arrêt et la reprise dans ce même fonctionnement,
mais refuse une demande qui changerait la bascule de l'installation : cette
dernière reste en lecture seule. Le mode décrit une autorisation de
fonctionnement, pas une mesure de la résistance ou de la vanne.

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

- **Arrêt** envoie l'ordre Veille Axenco par la route de l'appareil ou de sa
  passerelle. Cet ordre a été mesuré sur EV30 ; les autres modèles restent à
  confirmer sur matériel.
- La consigne de repli écrite ensuite par Gladys est mémorisée sans envoyer
  `targetMode: 8`, ce qui préserve la veille physique.
- L'intention d'arrêt et la consigne en attente sont enregistrées dans `/data`
  et survivent au redémarrage du conteneur. Une indisponibilité Axenco ou une
  commande ignorée reste signalée comme un échec.
- Une reprise suivie d'une consigne utilise une seule séquence de température
  (un appel pour les appareils principaux, deux pour NTD/ETRV). Sans nouvelle
  consigne, la valeur mémorisée est utilisée.
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

Les identifiants des consignes existantes restent inchangés. Sur NTD et ETRV,
le retour de consigne utilise `targetTemp`, sans être remplacé par une ancienne
valeur `overrideTemp`. Les températures hors des bornes annoncées restent
refusées. Les commandes directes, le widget et les scènes utilisent le même
contrôleur que le thermostat Gladys.

## Relais et fil pilote EWS

- **Contact sec** : la nouvelle fonctionnalité **Marche / Arrêt** transmet
  réellement les deux ordres. Elle peut servir d'actionneur à un thermostat
  virtuel avec une sonde indépendante. Le protocole de ce modèle reste hérité
  et demande une vérification sur votre installation.
- **Fil pilote** : le champ standard **Mode** / **Commande fil pilote (6 ordres)**
  (`pilot-wire-mode`) est supprimé pour éviter deux sélecteurs de portée
  différente sur le même module. **Mettre à jour** depuis Découverte applique
  ce retrait aux appareils existants. Remplacer auparavant toute référence à
  ce champ dans les scènes ou widgets par le sélecteur complet.
- **Mode du module** est le sélecteur complet EWS, auparavant **Mode Axenco**.
  Il propose notamment Auto et Boost sur le fil pilote. Les libellés
  **Confort −1 °C**, **Confort −2 °C** et **Arrêt** remplacent Éco 1K, Éco 2K
  et Veille sur EWS, sans changer les codes, les valeurs de scènes ni les
  identifiants du sélecteur et des anciens interrupteurs. Les autres modèles
  gardent leurs libellés. Le widget utilise ce menu complet et le mode observé.
- Le thermostat virtuel de Gladys 5.2 ne sait pas piloter directement un ordre
  fil pilote. Les interrupteurs historiques de modes ne sont pas de véritables
  Marche/Arrêt et ne doivent pas être choisis comme actionneurs binaires.

## Fenêtre ouverte

Un nouvel appareil expose un seul contact **Fenêtre ouverte**, compatible avec
Gladys, lorsqu'il remonte un `windowStatus` booléen ou numérique `0` / `1` :
`false` signifie fermé (`1` dans Gladys), `true` signifie ouverture détectée
(`0` dans Gladys). Il n'y a pas de réglage de correspondance.

Ce contact conserve l'identifiant `window-contact` : l'ancien **Contact fenêtre
pour thermostat** est simplement renommé, sans changer ses références ou ses
valeurs. Après un scan et la mise à jour de l'appareil, sélectionner **Fenêtre
ouverte** dans le thermostat pour suspendre le chauffage lors d'une ouverture.

L'ancien capteur `open-window`, qui utilise les valeurs opposées (`1` ouvert,
`0` fermé), est conservé uniquement s'il existe déjà, sous le nom **Fenêtre
ouverte (compatibilité)**. Ses valeurs ne sont pas inversées pour ne pas casser
les scènes existantes. Utiliser le contact standard, sans la mention
« compatibilité », dans les nouveaux thermostats et scènes.

Aucun contact n'est créé sur un appareil qui ne remonte pas de valeur valide.
Une lecture temporairement absente ou invalide ne supprime toutefois pas un
contact déjà créé. Cette traduction est indépendante de la prise en charge des
commandes du thermostat natif, qui reste propre au modèle.

Pour retirer d'anciennes fonctionnalités de compatibilité, remplacer d'abord
leurs références dans les scènes, widgets ou thermostats. Elles ne sont pas
recréées après leur retrait. Ne pas supprimer l'appareil pour cela.

## Widget, scènes et diagnostics

Le widget **Radiateur Neomitis** utilise deux tuiles liées aux fonctionnalités
réelles : température de la pièce et consigne. Elles suivent les états publiés
en direct, avec les unités de l'utilisateur. Le mode affiche notamment Auto
Confort/Éco ; le contact fenêtre indique fermé, ouverture détectée ou état
inconnu lorsqu'une lecture n'est plus valide. Le widget n'estime pas l'activité
de la résistance à partir de la différence entre température et consigne.

Deux commandes sont proposées selon les capacités réellement créées :

- **Mode** : ouvre les modes disponibles, avec le mode observé présélectionné
  lorsqu'il est sélectionnable. Choisir **Auto** pour suivre le programme
  MyNeomitis, **Veille** pour arrêter le radiateur, ou un mode actif pour
  reprendre. Un relais EWS propose Marche/Arrêt ; UFH Chauffage/Rafraîchissement.
- **Consigne** : applique une dérogation en **°C**, avec les bornes matérielles
  et la valeur actuelle préremplie si elle est valide. Elle peut réveiller un
  radiateur en veille ; un planning Gladys actif peut ensuite reprendre la main.

Les raccourcis Auto MyNeomitis et Arrêter/Reprendre ont été retirés du widget.
Les actions de scène restent disponibles ; le doublon fil pilote EWS est retiré.

Par défaut, les détails cloud sont masqués lorsque tout fonctionne. Les pertes
cloud, temps réel ou de connexion du radiateur restent visibles. Activer
**Afficher les détails de connexion** dans les réglages du widget pour voir
aussi les connexions saines et l'âge de la dernière lecture cloud. Les
instances déjà ajoutées gardent leur appareil sélectionné ; ce réglage est
facultatif et désactivé par défaut.

Utiliser le widget thermostat natif pour gérer le planning d'une zone. Les
boutons Neomitis pilotent directement le matériel, sans arrêter ce planning.
Un accusé de réception n'est pas une confirmation physique.

Actions de scène : **Choisir le mode Axenco**, **Appliquer une dérogation**,
**Reprendre le programme MyNeomitis**, **Mettre en marche / arrêter l’appareil**.
Les modes sont vérifiés contre le profil de l'appareil. La dernière action
agit sur le contrôle de l'appareil (les six modèles à consigne ou le relais EWS), pas sur le thermostat
de planning créé par Gladys. Un planning encore actif peut donc reprendre la
main ; pour l'arrêter durablement, utiliser son action générique de mode.
Le résultat `accepted` signifie que la demande a été acceptée ; la confirmation
physique se fait ensuite.

Le déclencheur **Commande non confirmée** fournit l'appareil, la fonctionnalité
et le motif d'échec. Il peut lancer une notification. Le contrôle après
commande intervient à 30 secondes. Les appareils principaux utilisent leur
route de lecture individuelle ; les sous-appareils sont recherchés par leur
identifiant dans une nouvelle lecture de la liste du compte. « Non confirmé »
signifie que l'état attendu n'est pas retrouvé à ce moment-là ; cela ne prouve
pas que l'ordre a été définitivement ignoré. Une répétition du même ordre
conserve les valeurs à vérifier. Le contrôle compare
les codes Auto `0`, `60` et `61` selon leur sens. Une absence dans la liste
signale une confirmation indisponible, sans utiliser l'état d'un autre appareil.

Une perte du temps réel affiche un état cloud dégradé ; les relectures REST
continuent. Une panne REST affiche une déconnexion et un appareil injoignable,
puis les indicateurs reviennent à la normale à la reprise. Une absence de
changement n'est pas assimilée à une panne. Les états fraîchement relus et
inchangés sont renvoyés au plus toutes les 30 minutes.

Les commandes sont ordonnées par appareil. Une demande restée plus d'une
seconde en attente n'est pas envoyée tardivement ; un événement d'échec est
publié. Les écritures HTTP Axenco ont un budget de 3,5 secondes, renouvellement
de token inclus, pour laisser du temps à l'accusé de réception Gladys. Un
couple mode/consigne NTD ou ETRV partage ce même budget entre les deux appels. Un
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
