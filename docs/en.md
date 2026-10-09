# Frigate

> **Status: in development.** The connection, the cameras (image, sensors,
> switches), the real-time feed and the scenes work; to be tested on more
> installations before the first stable release.

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

The connection status shows the state of the feed ("Real-time feed: MQTT
broker connected", or why not). A network failure is retried on its own; a
refused certificate or account stops the feed until you fix it and press
**Test the connection** (or save the configuration). When Frigate announces
it is offline (restart), the status says so, and its configuration is read
again when it comes back.

Each incident is also written to the integration logs (**View logs**):
`front: person detected, 87 %`, `front: person entered porch, 87 %`,
`front: review alert, person, car in porch`.

## Scenes

Three triggers, fired **once per incident** (never once per frame), above
the minimum confidence and outside the cooldown (see Options). False
positives and objects standing still never fire.

| Trigger                       | Fires when                                                                                    | Filters                        |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ |
| Frigate: new review           | Frigate opens a review item (alert or detection); once more when a detection becomes an alert | camera, severity, object, zone |
| Frigate: object detected      | Frigate starts tracking an object (person, car…)                                              | camera, object, zone           |
| Frigate: object enters a zone | A tracked object enters a zone defined in Frigate                                             | camera, zone, object           |

Object and zone are the names used in Frigate (`person`, `car`, `porch`…).
A review is filtered on its **main** object (the first of the camera's
tracked objects, in the order of the Frigate configuration) and its first
zone; all of them are in the `objects` and `zones` variables. Variables
available in the following actions: `camera`, `camera_name`, `label`,
`sub_label` (face or plate recognized by Frigate), `zone`, `zones`, `score`
(%), `severity`, `objects`, `event_id`, `review_id`.

On an alert, the integration pushes a fresh image of the camera **before**
firing the trigger: the core action "Send a camera image" placed right
after it sends the alert.

**Action "Frigate: attach the event snapshot"**: publishes the snapshot
Frigate kept for an event (with or without its bounding box) as the image of
the camera (the event's camera by default). Use `{{triggerEvent.data.event_id}}`
as the event id, then "Send a camera image". When Frigate keeps no snapshot
for the camera, its thumbnail is used.

Example — a photo on your phone when someone comes to the door:

1. Trigger **Frigate: new review**, camera _Front door_, severity _Alert_,
   object `person`.
2. Action **Frigate: attach the event snapshot**, event id
   `{{triggerEvent.data.event_id}}`.
3. Action **Send a camera image** of _Front door_ to yourself.

## Options

- **Minimum confidence** (default 70 %): object triggers only fire above it
  (reviews carry no score: Frigate's own thresholds apply).
- **Trigger cooldown** (default 30 s): at most one trigger per camera and
  object type (and zone, for zone triggers; per camera and severity for
  reviews)
  and period, so an incident never floods your scenes. False positives and
  objects that stay still (a parked car) never trigger.
- **Zone occupancy sensors** (off by default): one presence sensor per zone
  and tracked object.

## Cameras in Gladys

Open the **Discover** tab of the integration: every Frigate camera is
listed (press **Scan** to read Frigate again). Press **Add to Gladys** on the
ones you want. Each camera device carries what its Frigate configuration
enables:

| Feature                                 | What it does                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Image                                   | Refreshed every minute, taken fresh when Gladys asks (chat, scenes). Frigate resizes it to fit the 150 KB Gladys accepts.  |
| Camera enabled                          | Turns the camera on or off **in Frigate** (no detection, no recording while off); Gladys then shows no image of it either. |
| Object detection, Snapshots             | Frigate's switches.                                                                                                        |
| Recordings, Audio detection             | Only when enabled in the Frigate configuration file: Frigate refuses to turn them on otherwise.                            |
| Motion                                  | Motion seen by Frigate.                                                                                                    |
| One sensor per tracked object (Person…) | Present / absent, and its count. Plus the total of objects.                                                                |
| Review status                           | none, detection or alert.                                                                                                  |
| Zone sensors                            | With the "Zone occupancy sensors" option: one presence sensor per zone and object.                                         |

A switch is only shown as changed once Frigate confirms it. Without an MQTT
broker, the Frigate WebSocket only accepts commands from an **admin** account
(Frigate 0.17 and later): with another role, the command fails with that
explanation.

The badge of each camera says when it is not nominal: unreachable when
Frigate does not answer, announces it is offline, or the camera stream has
been lost for 30 seconds; degraded when its recording stream is interrupted
or the real-time feed is down (the states may then be outdated).

A camera added with an older version of the integration shows **Update** in
the Discover tab: press it to add the new features.

## Live video

Live video is not carried by this integration. Use the built-in **RTSP
camera** service of Gladys pointed at the Frigate go2rtc restream:
`rtsp://<frigate-ip>:8554/<camera_name>`.

## Configuration buttons

- **Test the connection**: Frigate's version and cameras, how its
  certificate is trusted, the account used, and a connection to the MQTT
  broker (or a reminder that the Frigate WebSocket is used without one).
- **Refresh the cameras**: reads the Frigate configuration again (for
  instance after adding a camera) and updates the list of the Discover
  tab.
- **Trust the new certificate**: forgets the pinned certificates of Frigate
  and of the broker, reconnects, and shows the fingerprint now pinned.
  Compare it with the one of your Frigate (command above) when in doubt.

When Frigate cannot be reached, the integration tries again every minute. A
refused certificate or refused credentials wait for you instead: retrying
would only lock the account out (Frigate limits failed logins).

## Troubleshooting

The connection status at the top of the Configuration tab explains what is
wrong (invalid URL, certificate, credentials). The integration logs are
available from the supervision controls (**View logs**); they never contain
passwords or tokens.
