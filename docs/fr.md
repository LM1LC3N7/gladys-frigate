# Frigate

> **Statut : en développement.** La connexion, les caméras (image, capteurs,
> interrupteurs), le flux temps réel et les scènes fonctionnent ; à éprouver
> sur davantage d'installations avant la première version stable.

Intégrez les caméras de votre [Frigate NVR](https://frigate.video) dans Gladys
Assistant : images, mouvement, objets détectés, alertes de revue,
interrupteurs des caméras, et déclencheurs de scènes pour réagir quand une
personne, une voiture ou un animal apparaît.

## Prérequis

- **Gladys Assistant 5.1 ou plus.**
- **Frigate 0.16, 0.17 ou 0.18.** L'intégration lit la version et la
  configuration de Frigate, et n'expose que ce que votre Frigate active
  réellement.
- Recommandé : le broker MQTT sur lequel Frigate publie. Sans broker,
  l'intégration se rabat sur le WebSocket de Frigate.

## Connexion à Frigate

| Champ                      | Valeur                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| URL de Frigate             | `https://<ip-frigate>:8971` (port authentifié, recommandé). Le port `5000` fonctionne mais n'a **aucune authentification** : un avertissement s'affiche dans le statut.  |
| Utilisateur / mot de passe | Un **compte Frigate dédié**. Le rôle `viewer` (ou un rôle personnalisé limité à vos caméras) suffit : les commandes des caméras passent par MQTT, pas par l'API Frigate. |

### Certificat : approuvé à la première connexion

Le port 8971 de Frigate utilise par défaut un certificat auto-signé. Vous
n'avez rien à faire :

- un certificat **signé par une autorité** (Let's Encrypt, l'autorité de votre
  entreprise installée sur le système…) est vérifié normalement, et ses
  renouvellements continuent de fonctionner, à condition que l'URL de Frigate
  utilise un nom couvert par le certificat (joint par son adresse IP, il est
  traité comme un certificat auto-signé, et chaque renouvellement vous
  demande de l'approuver à nouveau) ;
- un certificat **auto-signé** est **approuvé à la première connexion**, puis
  **épinglé** : s'il change ensuite (Frigate réinstallé, certificat régénéré…
  ou quelqu'un qui se fait passer pour Frigate), la connexion est refusée et
  le statut explique pourquoi.

Si vous savez que le certificat a changé pour une raison légitime, cliquez sur
**Faire confiance au nouveau certificat** dans l'onglet Configuration : la
connexion suivante approuve et épingle le nouveau certificat. Il en va de même
pour le broker MQTT quand TLS est activé.

La première connexion est le seul moment où le certificat n'est pas vérifié :
faites-la sur votre réseau local, pas à travers un réseau non maîtrisé.

### Réglages experts (facultatif)

En bas de l'onglet Configuration, renseignez **un** de ces champs pour
remplacer l'approbation à la première connexion :

- **Empreinte SHA-256 du certificat épinglé** : seul ce certificat exact est
  accepté. Pour la lire, depuis la machine de Frigate ou une machine de
  confiance :

  ```bash
  openssl s_client -connect <ip-frigate>:8971 </dev/null 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256
  ```

- **Autorité de certification (PEM)** : votre propre autorité ; le certificat
  doit être signé par elle et correspondre au nom d'hôte.

## Flux temps réel (MQTT)

Renseignez l'hôte, le port, les identifiants du broker et le préfixe des
topics Frigate (`frigate` par défaut). Donnez à l'intégration son propre
compte sur le broker, avec cette ACL (syntaxe Mosquitto) :

```
user gladys-frigate
topic read frigate/#
topic write frigate/+/+/set
```

Laissez l'hôte du broker vide pour utiliser le WebSocket de Frigate à la place.
Les commandes des caméras (les interrupteurs) demandent alors un compte
Frigate **admin** : depuis Frigate 0.17, le WebSocket les refuse aux autres
rôles.

Le statut de connexion indique l'état du flux (« Flux temps réel : broker
MQTT connecté », ou pourquoi pas). Une panne réseau est réessayée toute
seule ; un certificat ou un compte refusé arrête le flux jusqu'à ce que vous
corrigiez le problème et cliquiez sur **Tester la connexion** (ou
enregistriez la configuration). Quand Frigate s'annonce hors ligne
(redémarrage), le statut le signale, et sa configuration est relue à son
retour.

Chaque incident est aussi écrit dans les logs de l'intégration (**Voir les
logs**) : `front: person detected, 87 %`, `front: person entered porch,
87 %`, `front: review alert, person, car in porch`.

## Scènes

Trois déclencheurs, **une fois par incident** (jamais une fois par image),
au-dessus de la confiance minimale et hors cooldown (voir Options). Les faux
positifs et les objets immobiles ne déclenchent jamais.

| Déclencheur                         | Se déclenche quand                                                                                      | Filtres                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Frigate : nouvelle revue            | Frigate ouvre une revue (alerte ou détection) ; une fois de plus quand une détection devient une alerte | caméra, sévérité, objet, zone |
| Frigate : objet détecté             | Frigate commence à suivre un objet (personne, voiture…)                                                 | caméra, objet, zone           |
| Frigate : objet entre dans une zone | Un objet suivi entre dans une zone définie dans Frigate                                                 | caméra, zone, objet           |

L'objet et la zone sont les noms utilisés dans Frigate (`person`, `car`,
`porch`…). Une revue est filtrée sur son objet **principal** (le premier des
objets suivis par la caméra, dans l'ordre de la configuration Frigate) et sa
première zone ; tous sont dans les variables `objects` et `zones`. Variables
disponibles dans les actions suivantes : `camera`, `camera_name`, `label`,
`sub_label` (visage ou plaque reconnus par Frigate), `zone`, `zones`, `score`
(%), `severity`, `objects`, `event_id`, `review_id`.

Sur une alerte, l'intégration publie une image fraîche de la caméra **avant**
de déclencher : l'action « Envoyer une image de caméra » placée juste après
envoie bien l'alerte.

**Action « Frigate : joindre l'image de l'événement »** : publie l'instantané
que Frigate a gardé pour un événement (avec ou sans son cadre de détection)
comme image de la caméra (celle de l'événement par défaut). Utilisez
`{{triggerEvent.data.event_id}}` comme identifiant, puis « Envoyer une image de caméra ». Quand Frigate ne garde pas d'instantané pour la caméra, sa
miniature est utilisée.

Exemple — une photo sur votre téléphone quand quelqu'un vient à la porte :

1. Déclencheur **Frigate : nouvelle revue**, caméra _Porte d'entrée_,
   sévérité _Alerte_, objet `person`.
2. Action **Frigate : joindre l'image de l'événement**, identifiant
   `{{triggerEvent.data.event_id}}`.
3. Action **Envoyer une image de caméra** _Porte d'entrée_ à vous-même.

## Options

- **Confiance minimale** (70 % par défaut) : les déclencheurs d'objets ne se
  déclenchent qu'au-dessus (les revues n'ont pas de score : les seuils de
  Frigate s'appliquent).
- **Cooldown des déclencheurs** (30 s par défaut) : au plus un déclenchement
  par caméra et type d'objet (et par zone pour les déclencheurs de zone ; par
  caméra et sévérité pour les revues) et par période, pour qu'un incident
  n'inonde pas vos scènes. Les faux positifs et les objets immobiles (une
  voiture garée) ne déclenchent jamais.
- **Capteurs d'occupation par zone** (désactivés par défaut) : un capteur de
  présence par zone et par objet suivi.

## Les caméras dans Gladys

Ouvrez l'onglet **Découverte** de l'intégration : chaque caméra de Frigate y
est listée (cliquez sur **Scanner** pour relire Frigate). Cliquez sur
**Ajouter à Gladys** pour celles que vous voulez. Chaque appareil caméra
porte ce que sa configuration Frigate active :

| Fonctionnalité                       | Rôle                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Image                                | Rafraîchie chaque minute, prise à l'instant quand Gladys la demande (chat, scènes). Frigate la réduit sous les 150 Ko acceptés par Gladys.   |
| Caméra activée (Camera enabled)      | Allume ou éteint la caméra **dans Frigate** (ni détection ni enregistrement quand elle est éteinte) ; Gladys n'en montre alors plus l'image. |
| Détection d'objets, instantanés      | Les interrupteurs de Frigate.                                                                                                                |
| Enregistrements, détection audio     | Seulement s'ils sont activés dans le fichier de configuration de Frigate : sinon Frigate refuse de les allumer.                              |
| Mouvement                            | Le mouvement vu par Frigate.                                                                                                                 |
| Un capteur par objet suivi (Person…) | Présent / absent, et son nombre. Plus le total des objets.                                                                                   |
| Statut de revue                      | none (aucune), detection ou alert.                                                                                                           |
| Capteurs de zone                     | Avec l'option « Capteurs d'occupation par zone » : un capteur de présence par zone et par objet.                                             |

Un interrupteur n'est affiché comme changé qu'une fois confirmé par Frigate.
Sans broker MQTT, le WebSocket de Frigate n'accepte les commandes que d'un
compte **admin** (Frigate 0.17 et plus) : avec un autre rôle, la commande
échoue avec cette explication.

Le badge de chaque caméra signale quand elle n'est pas nominale : injoignable
quand Frigate ne répond pas, s'annonce hors ligne, ou que le flux de la
caméra est perdu depuis 30 secondes ; dégradée quand son flux
d'enregistrement est interrompu ou que le flux temps réel est coupé (les
états peuvent alors être périmés).

Une caméra ajoutée avec une version précédente de l'intégration affiche
**Mettre à jour** dans l'onglet Découverte : cliquez dessus pour ajouter les
nouvelles fonctionnalités.

## Vidéo en direct

La vidéo en direct ne passe pas par cette intégration. Utilisez le service
**Caméra RTSP** intégré à Gladys, pointé sur le restream go2rtc de Frigate :
`rtsp://<ip-frigate>:8554/<nom_camera>`.

## Boutons de la configuration

- **Tester la connexion** : la version et les caméras de Frigate, la façon
  dont son certificat est approuvé, le compte utilisé, et une connexion au
  broker MQTT (ou le rappel que le WebSocket de Frigate est utilisé sans
  broker).
- **Rafraîchir les caméras** : relit la configuration de Frigate (après
  l'ajout d'une caméra, par exemple) et met à jour la liste de l'onglet
  Découverte.
- **Faire confiance au nouveau certificat** : oublie les certificats épinglés
  de Frigate et du broker, se reconnecte et affiche l'empreinte désormais
  épinglée. En cas de doute, comparez-la à celle de votre Frigate (commande
  ci-dessus).

Quand Frigate est injoignable, l'intégration réessaie chaque minute. Un
certificat ou des identifiants refusés attendent en revanche votre action :
réessayer ne ferait que bloquer le compte (Frigate limite les connexions
échouées).

## Dépannage

Le statut de connexion en haut de l'onglet Configuration explique ce qui ne va
pas (URL, certificat, identifiants invalides). Les logs de l'intégration sont
accessibles depuis les contrôles de supervision (**Voir les logs**) ; ils ne
contiennent jamais de mot de passe ni de jeton.
