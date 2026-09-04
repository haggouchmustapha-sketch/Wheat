# Wheat 2.1.260905

Cette version corrige le travail bancaire de bout en bout, explique ce que Wheat
refuse, et cesse de perdre ce que vous avez saisi.

**Une correction importante :** relancer la reconnaissance d'une pièce effaçait
silencieusement toutes les corrections que vous y aviez faites. Vos corrections
sont désormais conservées et réappliquées : une nouvelle lecture ne remplace
jamais une décision que vous avez prise.

## Rapprochement bancaire

- Chaque suggestion de rapprochement dit sur quoi elle repose : même montant, même jour, référence trouvée
- Une recherche permet d'atteindre une écriture correcte que le classement automatique aurait enterrée
- Les suggestions que vous écartez ne reviennent plus, y compris après un redémarrage, et restent réaffichables
- Les mouvements apparaissent sous Débit ou sous Crédit, jamais sous un montant signé à interpréter
- Les chèques et virements déjà saisis peuvent être rattachés au mouvement bancaire qui les règle
- Après un import, « Rapprocher maintenant » ouvre directement les mouvements de ce relevé

## Relevés et reconnaissance

- Les relevés MT940 déclarent leurs soldes : Wheat vérifie que les mouvements lus les reconstituent, et refuse un relevé qui ne s'équilibre pas
- Un format qui ne déclare aucun solde l'indique honnêtement plutôt que d'inventer un contrôle
- Un relevé scanné indique la qualité de sa lecture poste par poste : mise en page, reconstruction des lignes, identification des colonnes
- Les lignes complétées par la relecture assistée sont nommées et marquées, pour être vérifiées avant confirmation
- Les contrôles comptables d'une pièce qui ne passent pas sont affichés là où vous corrigez, et non dans un panneau replié

## Ce que Wheat vous dit

- Chaque refus du rapprochement est expliqué en français : la règle, la raison, et ce qu'il faut faire
- Les explications sont accessibles à la souris comme au clavier
- Les messages techniques internes n'apparaissent plus à la place du message utile

## Votre travail est conservé

- La correspondance des colonnes d'un relevé est conservée si vous fermez la fenêtre pour aller vérifier le fichier
- Les notes, montants et règlements en cours de saisie sur un mouvement bancaire survivent à la navigation et au redémarrage
- Rien n'est effacé tant qu'une opération n'a pas réellement abouti

## Attente et lisibilité

- Les opérations longues — sauvegarde, restauration, lecture d'un relevé scanné — indiquent ce que Wheat est en train de faire
- Aucune barre de progression inventée : Wheat n'affiche un pourcentage que lorsqu'il le mesure réellement
- Une opération qui échoue rend la main au lieu de laisser un écran occupé

Comme toujours : traitement entièrement local, aucune donnée envoyée sans votre
accord, et vos dossiers, écritures, factures, documents et sauvegardes ne sont
jamais touchés par une mise à jour.
