# Frigate

> **Statut : en développement.** La connexion à Frigate, les trois boutons
> de l'onglet Configuration et les caméras (avec leur image) fonctionnent ;
> les capteurs, les interrupteurs et les déclencheurs de scène arrivent dans
> les prochaines versions.

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

## Options

- **Confiance minimale** (70 % par défaut) : les déclencheurs de scène ne se
  déclenchent qu'au-dessus.
- **Cooldown des déclencheurs** (30 s par défaut) : au plus un déclenchement
  par caméra et par période, pour qu'un incident n'inonde pas vos scènes.
- **Capteurs d'occupation par zone** (désactivés par défaut) : un capteur de
  présence par zone et par objet suivi.

## Les caméras dans Gladys

Ouvrez l'onglet **Découverte** de l'intégration : chaque caméra de Frigate y
est listée (cliquez sur **Scanner** pour relire Frigate). Cliquez sur
**Ajouter à Gladys** pour celles que vous voulez : chacune devient un appareil caméra pour le widget caméra du
tableau de bord, le chat (« montre-moi le garage ») et l'action de scène
« envoyer l'image de la caméra ».

- L'image est rafraîchie **chaque minute**, et prise à l'instant quand
  Gladys la demande (chat, scènes). Frigate la redimensionne pour tenir dans
  les 150 Ko qu'accepte Gladys.
- À venir : le mouvement, les objets détectés et les interrupteurs de la
  caméra. Gladys affichera alors **Mettre à jour** à côté des caméras déjà
  créées, dans l'onglet Découverte : cliquez dessus pour leur ajouter les
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
