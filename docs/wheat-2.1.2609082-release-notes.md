# Wheat 2.1.2609082

- Comptabilité : les à-nouveaux respectent désormais le verrouillage des périodes comptables. Une écriture d'ouverture ne peut plus être comptabilisée dans une période déjà figée.
- Fiabilité : correction d'une condition de concurrence pouvant empêcher le rechargement de Wheat juste après une réinitialisation de l'espace de travail.
- États comptables : les balances n'acceptent désormais que les statuts d'écritures comptables autorisés, empêchant notamment l'inclusion accidentelle de brouillons.
- Démarrage : forte amélioration des performances pour les cabinets comportant plusieurs dossiers ; seul le plan comptable du dossier actif est chargé au démarrage et les vérifications PCGE inutiles sont évitées.
- Nouveau dossier soumis à la TVA : Wheat peut proposer une configuration TVA basée sur les taux marocains courants afin de préremplir le formulaire. Elle reste soumise à la vérification de l'utilisateur et n'est jamais activée automatiquement.
- Rapprochement bancaire : les relevés CSV/Excel peuvent désormais recevoir un solde initial et un solde final saisis depuis le relevé bancaire, permettant à Wheat de vérifier la cohérence des mouvements avant import.
- Import bancaire : Wheat vérifie désormais que le compte bancaire sélectionné appartient bien au dossier actuellement ouvert avant d'importer le relevé.
- Rapprochement bancaire : amélioration des performances sur les dossiers avec un historique important ; les mouvements restant à lettrer restent prioritaires et les anciens rapprochements peuvent être limités lorsque le volume devient très important.
- Mise à jour : amélioration des messages d'erreur et de la reprise lorsqu'une installation de mise à jour échoue, sans perdre la mise à jour déjà vérifiée.
- Interface : correction de plusieurs libellés français dans les écrans de verrouillage des périodes.
