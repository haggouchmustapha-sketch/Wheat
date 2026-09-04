# Wheat 2.1

Correction de bugs bloquants, améliorations Wheat AI et OCR.

- La configuration TVA s'enregistre à nouveau : le sens « Déductible » envoyait un libellé traduit au lieu de la valeur attendue.
- Les taux de TVA déductibles réapparaissent dans la saisie des achats, pour la même raison.
- Les grands écrans, dialogues et menus ne sortent plus de la fenêtre : le haut d'un formulaire trop grand reste atteignable.
- La fenêtre s'ouvre une fois le contenu prêt et reçoit le clavier : les champs de saisie acceptent la frappe dès le premier lancement.
- Wheat AI détecte Ollama même s'il démarre après Wheat, distingue « non installé » de « service arrêté » et propose de le démarrer.
- Wheat AI garde la conversation en cours pendant toute la session, y compris en changeant d'écran.
- Wheat AI propose une pièce jointe image uniquement pour les modèles qui déclarent la vision.
- L'écran Wheat AI ne montre plus le bloc gris avant la première question, et range les détails techniques.
- OCR : orientation de page et de ligne activées, documents multi-pages assemblés en un seul document, contrôles comptables HT + TVA = TTC et taux marocains, taux de TVA reconstitué quand la facture ne l'imprime pas.
- OCR : relecture IA optionnelle, désactivée par défaut, qui ne peut que compléter ou contester un champ lu.
