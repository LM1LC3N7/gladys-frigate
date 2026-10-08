# Frigate

Intégrez les caméras de votre [Frigate NVR](https://frigate.video) dans Gladys
Assistant : images en direct, mouvement, objets détectés par Frigate,
interrupteurs pour activer ou couper la détection, les enregistrements et les
snapshots, et déclencheurs de scènes pour réagir quand une personne, une
voiture ou un animal apparaît.

## Prérequis

- **Gladys Assistant 5.1 ou plus.**
- **Frigate 0.18 ou plus.** Les versions plus anciennes sont refusées avec un
  message explicite : mettez d'abord Frigate à jour.
- Gladys doit pouvoir joindre Frigate sur le réseau.

Aucun broker MQTT n'est nécessaire : l'intégration utilise le WebSocket de
Frigate.

## Configuration

Ouvrez l'onglet **Configuration** de l'intégration et renseignez :

| Champ                             | Valeur                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL de Frigate                    | `http://<ip-frigate>:5000` (port interne, sans identifiant) **ou** `https://<ip-frigate>:8971` (port authentifié).                                                                    |
| Utilisateur / mot de passe        | Uniquement pour le port 8971. Utilisez un utilisateur Frigate **admin** : Frigate n'accepte les commandes détection / enregistrements / snapshots que des admins.                     |
| Accepter un certificat auto-signé | Le port 8971 utilise par défaut un certificat auto-signé. N'activez cette option que si Frigate est sur votre réseau local.                                                           |
| Intervalle des images             | Fréquence de rafraîchissement des images dans Gladys (secondes, `0` pour ne récupérer les images qu'à la demande). Gladys accepte au plus une image toutes les 5 secondes par caméra. |
| Hauteur des images                | Hauteur des images. Elles sont réduites automatiquement pour rester sous la limite de 150 Ko de Gladys.                                                                               |

Enregistrez, puis cliquez sur **Tester la connexion** : la version de Frigate
et le nombre de caméras s'affichent sous le bouton.

> Le port 5000 n'a aucune authentification : ne l'exposez qu'à un réseau de
> confiance (ou au réseau Docker partagé avec Gladys).

## Appareils

Ouvrez l'onglet **Découverte** : toutes les caméras Frigate y sont listées.
Cliquez sur **Créer** pour celles que vous voulez. Chaque caméra comporte :

- **Image** : la dernière image, affichée dans le widget caméra du tableau de
  bord ;
- **Mouvement** : la détection de mouvement de Frigate (oui / non) ;
- **un compteur par objet suivi** (`person`, `car`…) : combien sont visibles ;
- **Détection d'objets**, **Enregistrements** et **Snapshots** : des
  interrupteurs qui reflètent les réglages Frigate de la caméra.

Les caméras ajoutées plus tard dans Frigate apparaissent après un nouveau scan
depuis l'onglet **Découverte**.

## Scènes

Trois déclencheurs sont disponibles dans l'éditeur de scènes, dans la
catégorie **Intégrations** :

- **Frigate : objet détecté** — un nouvel objet est suivi. Filtrez par caméra
  et par type d'objet (ex. `person`).
- **Frigate : objet entre dans une zone** — un objet entre dans une zone
  définie dans Frigate. Filtrez par caméra, zone et type d'objet.
- **Frigate : nouvelle alerte ou détection** — Frigate ouvre un élément de
  revue. Filtrez par caméra et par sévérité (alerte ou détection). Sur une
  alerte, l'image de la caméra est aussitôt rafraîchie dans Gladys.

Les détails de l'événement (type d'objet, sous-label comme un visage ou une
plaque reconnus, confiance, zones, identifiants Frigate) sont disponibles
comme variables dans les étapes suivantes de la scène. Combinez-les avec les
actions caméra de Gladys pour vous envoyer l'image.

## Dépannage

- **« Frigate X n'est pas supporté »** : mettez Frigate à jour en 0.18 ou plus.
- **« Frigate a refusé la connexion »** : vérifiez l'utilisateur et le mot de
  passe, et que l'URL utilise le port 8971.
- **« Le certificat TLS de Frigate n'est pas reconnu »** : activez _Accepter un
  certificat auto-signé_, ou installez un certificat valide sur Frigate.
- **Les interrupteurs ne changent pas** : l'utilisateur Frigate doit avoir le
  rôle `admin`.
- **« Impossible de joindre Frigate »** : testez l'URL depuis la machine de
  Gladys (`curl http://<ip-frigate>:5000/api/version`). L'intégration
  réessaie seule toutes les 30 secondes.

Les logs de l'intégration sont consultables depuis l'onglet **Configuration**
(contrôles de supervision, **Voir les logs**).
