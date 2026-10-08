# Frigate

> **Statut : en développement.** Cette page décrit la configuration de la
> première version à venir. La connexion à Frigate n'est pas encore disponible.

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

| Champ                          | Valeur                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| URL de Frigate                 | `https://<ip-frigate>:8971` (port authentifié, recommandé). Le port `5000` fonctionne mais n'a **aucune authentification** : un avertissement s'affiche dans le statut.              |
| Utilisateur / mot de passe     | Un **compte Frigate dédié**. Le rôle `viewer` (ou un rôle personnalisé limité à vos caméras) suffit : les commandes des caméras passent par MQTT, pas par l'API Frigate.             |
| Vérification du certificat TLS | _Certificat reconnu_ pour un certificat signé par une autorité publique ; _Ma propre autorité_ pour coller votre CA ; _Empreinte épinglée_ pour le certificat auto-signé de Frigate. |

Pour lire l'empreinte du certificat de Frigate depuis une machine du réseau :

```bash
openssl s_client -connect <ip-frigate>:8971 </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256
```

Vérifiez que la valeur correspond bien au certificat servi par Frigate (par
exemple depuis la machine de Frigate elle-même) avant de la coller.

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

## Options

- **Confiance minimale** (70 % par défaut) : les déclencheurs de scène ne se
  déclenchent qu'au-dessus.
- **Cooldown des déclencheurs** (30 s par défaut) : au plus un déclenchement
  par caméra et par période, pour qu'un incident n'inonde pas vos scènes.
- **Capteurs d'occupation par zone** (désactivés par défaut) : un capteur de
  présence par zone et par objet suivi.

## Vidéo en direct

La vidéo en direct ne passe pas par cette intégration. Utilisez le service
**Caméra RTSP** intégré à Gladys, pointé sur le restream go2rtc de Frigate :
`rtsp://<ip-frigate>:8554/<nom_camera>`.

## Dépannage

Le statut de connexion en haut de l'onglet Configuration explique ce qui ne va
pas (URL, certificat, identifiants invalides). Les logs de l'intégration sont
accessibles depuis les contrôles de supervision (**Voir les logs**) ; ils ne
contiennent jamais de mot de passe ni de jeton.
