# Liste des travaux — migration Gladys 5.2

Références utilisées : [spécifications des intégrations externes](https://gladysassistant.com/fr/docs/dev/external-integrations/)
et [fonctionnement du thermostat](https://gladysassistant.com/fr/docs/integrations/thermostat/).
Les détails d'utilisation sont dans le [guide de migration](upgrade.fr.md).

## Développements réalisés

- [x] Passer au SDK 0.15, aligner le manifeste et annoncer Gladys 5.2 minimum.
- [x] Utiliser la publication ordonnée et dédupliquée du SDK, avec renvoi périodique des valeurs fraîchement relues et remise à zéro du cache lors des événements de création, modification et suppression.
- [x] Distinguer la panne cloud de la perte du temps réel, et rétablir les indicateurs après récupération.
- [x] Utiliser une consigne commune et un mode physique pour EV30, ECTRL, ESTAT, RSS-ECTRL, NTD et ETRV ; conserver les identifiants historiques et l'ancienne consigne EV30 comme alias uniquement si elle existe déjà.
- [x] Empêcher la consigne de repli écrite après Arrêt de rallumer un des six modèles à consigne ; mémoriser l'intention d'arrêt dans le volume persistant.
- [x] Regrouper reprise et nouvelle consigne ; publier les consignes natives confirmées par le matériel.
- [x] Ajouter un véritable interrupteur Marche/Arrêt pour EWS relais ; retirer le doublon fil pilote à six ordres et utiliser le sélecteur complet EWS.
- [x] Faire passer NTD/ETRV par leur passerelle, avec un budget partagé pour mode et consigne ; vérifier leurs retours par une lecture forcée de la liste du compte.
- [x] Faire suivre au mode NTD le changement chauffage/rafraîchissement observé, sans permettre une écriture de cette bascule.
- [x] Ajouter automatiquement le contact fenêtre compatible avec le thermostat aux appareils qui remontent windowStatus (false = fermé, true = ouverture détectée), sans réglage de correspondance ; conserver le capteur historique uniquement s'il existe déjà.
- [x] Valider les fonctionnalités, les modes, les valeurs binaires, les températures et les bornes ; ne publier que les fonctionnalités déclarées et créées.
- [x] Ordonner les commandes par appareil, limiter leur attente, borner le temps des requêtes d'écriture et annuler les actions différées lors de la suppression ou de l'arrêt.
- [x] Contrôler les commandes après leur envoi, reconnaître les codes Auto équivalents et éviter les faux échecs lorsqu'une nouvelle commande remplace la précédente.
- [x] Ajouter un widget récapitulatif avec formulaires de mode et de température, quatre actions de scène et un déclencheur de commande non confirmée.
- [x] Renforcer Docker et la publication : installation reproductible, dossier persistant accessible, contrôles officiels du store en CI et vérification de l'image avant publication du manifeste dans la branche.
- [x] Actualiser les documentations française et anglaise et fournir les instructions de migration sans recréation des appareils.
- [x] Vérifier les tests automatisés, ESLint, Prettier et le manifeste avec le validateur officiel.

- [x] Ajouter un sélecteur Mode Axenco sur les appareils à plusieurs modes, sans imposer un thermostat Gladys ; conserver les anciens interrupteurs déjà créés et utiliser le sélecteur pour les nouveaux appareils.
- [x] Ne plus créer de texte de mode sur les appareils à sélecteur ni de capteur fenêtre historique ; préserver les fonctionnalités existantes et afficher les détails du mode dans le widget.

- [x] Simplifier le widget : températures en direct, fenêtre, uniquement Mode et Consigne selon le modèle, formulaires préremplis et détails de connexion facultatifs.

- [x] Conserver la vérification en attente lors des ordres identiques répétés et décrire les écarts à 30 secondes comme non confirmés, sans en déduire la cause.

## Vérifications matérielles et publication restantes

Ces points ne peuvent pas être validés par les tests logiciels seuls :

- [ ] Tester sur un EV30 réel la séquence Arrêt → consigne de repli → reprise et les retours de consigne dans une zone gérée par Gladys.
- [ ] Mesurer les limites de dérogation avant d'autoriser des températures inférieures au minimum annoncé par l'appareil. Si ce minimum vaut 16 °C, le développement ne prétend pas fournir une consigne Hors gel numérique à 7 °C.
- [ ] Vérifier la suspension et la reprise du thermostat Gladys lors d'une détection d'ouverture.
- [ ] Vérifier les commandes du relais EWS sur le matériel, puis valider le couple natif et les séquences arrêt/reprise sur ECTRL, ESTAT, RSS-ECTRL, NTD et ETRV. La prise en charge logicielle ne remplace pas ces essais.
- [x] Construire les images de test pour amd64 et arm64 et valider leurs manifestes avec le validateur officiel.
- [ ] Tester le déploiement de la version officielle avec le thermostat Gladys sur l'installation de l'utilisateur.

Aucune nouvelle commande Axenco n'est inventée pour les matériels non vérifiés.
Le thermostat virtuel Gladys ne pilote pas directement les ordres fil pilote.
Les tests automatisés utilisent des doubles : ils ne commandent pas le chauffage.
Les premiers essais de l'utilisateur semblent concluants sur son installation ;
le test avec le thermostat Gladys reste à réaliser. La publication ne signifie
pas que ces vérifications matérielles sont terminées. Les résultats et les
conditions de migration sont consignés dans les [notes de version](../CHANGELOG.md).
