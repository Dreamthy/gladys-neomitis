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

## EV30 : thermostat réel dans Gladys

Créer un **thermostat réel** dans **Intégrations → Thermostat** et sélectionner :

| Réglage                | Fonctionnalité de l'EV30                                 |
| ---------------------- | -------------------------------------------------------- |
| Consigne               | **Consigne thermostat Gladys**                           |
| Mode de fonctionnement | **Mode thermostat Gladys**                               |
| Température mesurée    | **Température actuelle**                                 |
| État de chauffe        | Laisser vide : aucune mesure de chauffe n'a été vérifiée |
| Fenêtre                | Voir la section dédiée ci-dessous                        |

Les deux fonctionnalités « thermostat Gladys » forment un couple. Sélectionner
seulement la consigne, ou utiliser l'ancienne **Température cible**, ne donne
pas la protection d'arrêt décrite ci-dessous. Aucun calcul d'hystérésis ou de
TPI n'est ajouté à l'EV30 : il régule lui-même.

Le planning et les préréglages Confort/Éco/Nuit/Absence sont ceux de Gladys.
Désactiver le programme fabricant avant de confier le planning à Gladys.
**Planning Gladys** et **Auto MyNeomitis** sont deux mécanismes distincts.
Pour les scènes d'une zone gérée par Gladys, contrôler les fonctionnalités du
thermostat créé par Gladys (préréglage, mode, consigne), plutôt que les
commandes directes Axenco qui seraient un second responsable de la zone.

### Arrêt, reprise et consignes

- **Arrêt** envoie l'ordre Veille Axenco déjà mesuré sur EV30.
- La consigne de repli que Gladys écrit ensuite est mise en attente ; elle
  n'envoie pas `targetMode: 8` et ne rallume donc pas le radiateur.
- L'intention d'arrêt et la consigne en attente sont enregistrées dans `/data`.
  Elles survivent au redémarrage du conteneur. Elles ne garantissent pas une
  mise en veille physique si Axenco est injoignable ou ignore la commande.
- Une reprise suivie d'une consigne est regroupée pour envoyer une seule
  commande de température. Sans nouvelle consigne, la valeur mémorisée est
  utilisée. Une nouvelle demande d'arrêt annule une reprise encore en attente.
- Pendant l'arrêt, la **Consigne thermostat Gladys** représente la valeur
  mémorisée pour une reprise, pas une température actuellement appliquée au
  radiateur. L'ancienne **Température cible** conserve sa représentation Axenco.
- En fonctionnement, la nouvelle consigne n'est publiée qu'à partir des
  observations du matériel. La réponse HTTP 200 ne vaut pas confirmation.

**Bornes :** la plage annoncée par l'appareil est conservée, avec un pas de
0,5 °C pour le contrôle EV30. Si elle commence à 16 °C, un préréglage Hors gel
de 7 °C sera limité par Gladys à 16 °C. Le mode Arrêt reste protégé par Veille,
mais on ne prétend pas fournir un Hors gel numérique à 7 °C dans cette plage.
Il faut mesurer les limites de dérogation avant de les élargir ; aucun nouveau
payload Axenco n'est inventé pour contourner cette limite.

En cas de commande ignorée, la dernière consigne confirmée est conservée sur
le contrôle natif, pour ne pas transformer une correction en dérogation
manuelle Gladys. L'événement de commande non confirmée et les logs signalent
l'écart. Le planning peut réessayer au passage suivant. Tant qu'une consigne
reste en attente, les valeurs divergentes ne sont pas présentées comme des
changements manuels sur ce contrôle ; les fonctionnalités historiques restent
disponibles pour le diagnostic.

Les modèles `ECTRL`, `ESTAT`, `RSS-ECTRL`, `NTD` et `ETRV` conservent leurs
commandes historiques. Le couple de commandes natif est réservé à **EV30**,
dont le protocole a été mesuré. Le portage aux autres modèles demande une
validation matérielle, notamment des sous-appareils et de leur passerelle.

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

Le capteur historique **Fenêtre ouverte** garde son identifiant et ses valeurs.
Pour le thermostat, vérifier d'abord le champ brut `windowStatus` pendant une
ouverture et une fermeture, puis régler **Correspondance du contact fenêtre
Axenco** dans la configuration : `1 / vrai signifie ouvert` ou l'inverse.
Le défaut reste **Non vérifié (désactivé)**.

Après un scan et la mise à jour de l'appareil, sélectionner le nouveau
**Contact fenêtre pour thermostat** : il traduit l'ouverture en `0` et la
fermeture en `1`, comme attendu par Gladys. Ne pas utiliser le capteur
historique pour cette protection sans vérifier ses valeurs.

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
