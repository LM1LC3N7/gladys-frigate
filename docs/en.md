# Frigate

> **Status: in development.** This page describes the configuration of the
> upcoming first release. The Frigate connection is not available yet.

Bring the cameras of your [Frigate NVR](https://frigate.video) into Gladys
Assistant: snapshots, motion, detected objects, review alerts, camera
switches, and scene triggers to react when a person, a car or an animal shows
up.

## Requirements

- **Gladys Assistant 5.1 or later.**
- **Frigate 0.16, 0.17 or 0.18.** The integration reads the Frigate version
  and configuration and only exposes what your Frigate actually enables.
- Recommended: the MQTT broker Frigate publishes to. Without a broker, the
  integration falls back to the Frigate WebSocket.

## Frigate connection

| Field                 | What to enter                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frigate URL           | `https://<frigate-ip>:8971` (authenticated port, recommended). Port `5000` works but has **no authentication at all**: a warning is shown in the connection status.                        |
| Username / password   | A **dedicated Frigate account**. The `viewer` role (or a custom role limited to your cameras) is enough: camera commands go through MQTT, not through the Frigate API.                     |
| TLS certificate check | _Trusted certificate_ for a certificate signed by a public authority; _My own certificate authority_ to paste your CA; _Pinned fingerprint_ for Frigate's default self-signed certificate. |

To read the fingerprint of the Frigate certificate from any machine of your
network:

```bash
openssl s_client -connect <frigate-ip>:8971 </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256
```

Check that the value matches the certificate Frigate really serves (for
instance from the Frigate host itself) before pasting it.

## Real-time feed (MQTT)

Enter the broker host, port, credentials and the Frigate topic prefix
(`frigate` by default). Give the integration its own broker account with this
ACL (Mosquitto syntax):

```
user gladys-frigate
topic read frigate/#
topic write frigate/+/+/set
```

Leave the broker host empty to use the Frigate WebSocket instead.

## Options

- **Minimum confidence** (default 70 %): scene triggers only fire above it.
- **Trigger cooldown** (default 30 s): at most one trigger per camera and
  period, so an incident never floods your scenes.
- **Zone occupancy sensors** (off by default): one presence sensor per zone
  and tracked object.

## Live video

Live video is not carried by this integration. Use the built-in **RTSP
camera** service of Gladys pointed at the Frigate go2rtc restream:
`rtsp://<frigate-ip>:8554/<camera_name>`.

## Troubleshooting

The connection status at the top of the Configuration tab explains what is
wrong (invalid URL, certificate, credentials). The integration logs are
available from the supervision controls (**View logs**); they never contain
passwords or tokens.
