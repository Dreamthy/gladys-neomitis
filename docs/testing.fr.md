# Essayer la migration Gladys 5.2

La branche `test/gladys-5.2-thermostat` produit cette image de test :

```text
ghcr.io/dreamthy/gladys-neomitis:test-gladys-5.2-thermostat
```

Chaque construction publie aussi une référence suffixée par l'identifiant du
commit. Utiliser cette référence fournie dans le résumé du workflow pour
charger une correction sans réutiliser une ancienne image en cache.

Le workflow **Build and publish image** la construit pour `linux/amd64` et
`linux/arm64`. Attendre la réussite de ce workflow et de **CI** avant de
l'installer. Aucun tag de version officielle ni `latest` n'est mis à jour.

## Préparer l'essai

1. Utiliser Gladys **5.2 ou plus récent**. Privilégier une instance de test.
2. Sauvegarder Gladys. Conserver le manifeste et la référence exacte de l'image
   actuellement utilisée pour pouvoir revenir à cette version.
3. Ouvrir le résumé du workflow de construction : il fournit un manifeste dont
   `docker_image` pointe déjà vers l'image de test ci-dessus.
4. Utiliser ce manifeste dans le mode développeur des intégrations Gladys.
   Sur une instance où MyNeomitis est déjà installé, l'installation peut
   remplacer son conteneur : ne pas lancer simultanément deux intégrations
   qui commandent les mêmes appareils.
5. Suivre le [guide de migration](upgrade.fr.md) pour mettre à jour les
   fonctionnalités depuis Découverte, sans supprimer les appareils existants.

## Vérifier le fonctionnement

- Vérifier les températures, les modes et les anciennes scènes avant de créer
  une zone de thermostat Gladys.
- Sur un seul EV30, sélectionner **Mode du radiateur** et
  **Température de consigne**, puis tester une consigne dans ses bornes.
- Si l'ancienne **Consigne thermostat Gladys** existe, vérifier sa compatibilité
  puis sélectionner la consigne commune dans le thermostat existant.
- Passer en Arrêt, vérifier physiquement la veille, puis vérifier que la
  consigne de repli et une écriture de la consigne commune ne le rallument pas.
  Tester ensuite la reprise, les modes Axenco et la dérogation explicite.
- Redémarrer le conteneur pendant l'arrêt et vérifier que l'intention d'arrêt
  est conservée. Une consigne en attente n'est pas une mesure physique.
- Tester les changements du planning Gladys, en ayant désactivé le programme
  fabricant sur la zone utilisée pour cet essai.
- Vérifier le widget, les quatre actions de scène et l'événement de commande
  non confirmée. Un accusé de réception ne prouve pas l'exécution matérielle.
- Vérifier le relais EWS si vous en possédez un. Le fil pilote ne peut pas
  servir directement d'actionneur au thermostat virtuel Gladys.
- Sélectionner **Contact fenêtre pour thermostat** si cette
  fonctionnalité est proposée, puis vérifier la suspension et la reprise du
  chauffage lors d'une détection d'ouverture. La correspondance est automatique.

Ne pas élargir les bornes annoncées par l'appareil pour cet essai. Si la borne
minimale est 16 °C, une consigne numérique Hors gel à 7 °C reste hors plage.

## Revenir à la version précédente

Remettre le manifeste et l'image conservés avant l'essai, puis vérifier le
fonctionnement de l'intégration. Désactiver auparavant le thermostat de test
et les nouvelles scènes qui utiliseraient les fonctionnalités ajoutées.
Une restauration de la sauvegarde Gladys reste disponible si nécessaire.

La publication officielle intervient après validation de ces essais réels.
