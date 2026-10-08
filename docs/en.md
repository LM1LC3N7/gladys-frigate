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

| Field               | What to enter                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frigate URL         | `https://<frigate-ip>:8971` (authenticated port, recommended). Port `5000` works but has **no authentication at all**: a warning is shown in the connection status.    |
| Username / password | A **dedicated Frigate account**. The `viewer` role (or a custom role limited to your cameras) is enough: camera commands go through MQTT, not through the Frigate API. |

### Certificate: trusted on first connection

Frigate's port 8971 serves a self-signed certificate by default. You do not
have to do anything:

- a certificate **signed by an authority** (Let's Encrypt, your company CA
  installed in the system…) is verified normally, and renewals keep working,
  as long as the Frigate URL uses a name the certificate covers (reached by
  its IP address instead, it is handled like a self-signed one, and each
  renewal asks you to trust it again);
- a **self-signed** certificate is **trusted on the first connection**, then
  **pinned**: if it changes later (Frigate reinstalled, certificate
  regenerated… or someone impersonating Frigate), the connection is refused
  and the status explains why.

When you know the certificate changed for a legitimate reason, press
**Trust the new certificate** in the Configuration tab: the next connection
trusts and pins the new certificate. The same applies to the MQTT broker when
TLS is enabled.

The first connection is the only moment the certificate is not checked: run
it on your local network, not through an untrusted network.

### Expert settings (optional)

At the bottom of the Configuration tab, fill in **one** of these fields to
replace the trust on first use:

- **Pinned certificate SHA-256 fingerprint**: only this exact certificate is
  accepted. To read it, from the Frigate host itself or a trusted machine:

  ```bash
  openssl s_client -connect <frigate-ip>:8971 </dev/null 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256
  ```

- **Certificate authority (PEM)**: your own authority; the certificate must be
  signed by it and match the host name.

## Real-time feed (MQTT)

Enter the broker host, port, credentials and the Frigate topic prefix
(`frigate` by default). Give the integration its own broker account with this
ACL (Mosquitto syntax):

```
user gladys-frigate
topic read frigate/#
topic write frigate/+/+/set
```

Leave the broker host empty to use the Frigate WebSocket instead. Camera
commands (the switches) then need an **admin** Frigate account: since Frigate
0.17, the WebSocket refuses them from other roles.

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
