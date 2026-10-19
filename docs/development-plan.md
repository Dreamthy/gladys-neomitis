# Liste des travaux — migration Gladys 5.2

Références utilisées : [spécifications des intégrations externes](https://gladysassistant.com/fr/docs/dev/external-integrations/)
et [fonctionnement du thermostat](https://gladysassistant.com/fr/docs/integrations/thermostat/).
Les détails d'utilisation sont dans le [guide de migration](upgrade.fr.md).

## Développements réalisés

- [x] Passer au SDK 0.15, aligner le manifeste et annoncer Gladys 5.2 minimum.
- [x] Utiliser la publication ordonnée et dédupliquée du SDK, avec renvoi périodique des valeurs fraîchement relues et remise à zéro du cache lors des événements de création, modification et suppression.
- [x] Distinguer la panne cloud de la perte du temps réel, et rétablir les indicateurs après récupération.
- [x] Ajouter le couple mode/consigne du thermostat réel pour EV30, en conservant les identifiants et commandes historiques.
- [x] Empêcher la consigne de repli écrite après Arrêt de rallumer l'EV30 ; mémoriser l'intention d'arrêt dans le volume persistant.
- [x] Regrouper reprise et nouvelle consigne ; publier les consignes natives confirmées par le matériel.
- [x] Ajouter un véritable interrupteur Marche/Arrêt pour EWS relais et traduire les six ordres standard du fil pilote EWS.
- [x] Ajouter un contact fenêtre compatible avec le thermostat, activable après vérification explicite de sa polarité ; conserver le capteur historique.
- [x] Valider les fonctionnalités, les modes, les valeurs binaires, les températures et les bornes ; ne publier que les fonctionnalités déclarées et créées.
- [x] Ordonner les commandes par appareil, limiter leur attente, borner le temps des requêtes d'écriture et annuler les actions différées lors de la suppression ou de l'arrêt.
- [x] Contrôler les commandes après leur envoi, reconnaître les codes Auto équivalents et éviter les faux échecs lorsqu'une nouvelle commande remplace la précédente.
- [x] Ajouter un widget récapitulatif avec formulaires de mode et de température, quatre actions de scène et un déclencheur de commande non confirmée.
- [x] Renforcer Docker et la publication : installation reproductible, dossier persistant accessible, contrôles officiels du store en CI et vérification de l'image avant publication du manifeste dans la branche.
- [x] Actualiser les documentations française et anglaise et fournir les instructions de migration sans recréation des appareils.
- [x] Vérifier les tests automatisés, ESLint, Prettier et le manifeste avec le validateur officiel.

## Vérifications matérielles et publication restantes

Ces points ne peuvent pas être validés par les tests logiciels seuls :

- [ ] Tester sur un EV30 réel la séquence Arrêt → consigne de repli → reprise et les retours de consigne dans une zone gérée par Gladys.
- [ ] Mesurer les limites de dérogation avant d'autoriser des températures inférieures au minimum annoncé par l'appareil. Si ce minimum vaut 16 °C, le développement ne prétend pas fournir une consigne Hors gel numérique à 7 °C.
- [ ] Vérifier `windowStatus` pendant une ouverture et une fermeture avant d'activer le nouveau contact fenêtre.
- [ ] Vérifier les commandes du relais EWS sur le matériel, puis valider les autres modèles et passerelles avant d'y étendre le couple natif EV30.
- [ ] Construire et tester l'image Docker, puis publier et déployer la version suivant le circuit de release.

Aucune nouvelle commande Axenco n'est inventée pour les matériels non vérifiés.
Le thermostat virtuel Gladys ne pilote pas directement les ordres fil pilote.
Les tests automatisés utilisent des doubles : ils ne commandent pas le chauffage.
La publication et le déploiement n'ont pas été exécutés pendant ce développement local.
