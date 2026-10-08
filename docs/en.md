# Frigate

Bring the cameras of your [Frigate NVR](https://frigate.video) into Gladys
Assistant: live snapshots, motion, the objects Frigate detects, switches to
turn detection, recordings and snapshots on and off, and scene triggers to
react when a person, a car or an animal shows up.

## Requirements

- **Gladys Assistant 5.1 or later.**
- **Frigate 0.18 or later.** Older versions are refused with an explicit
  message: update Frigate first.
- Gladys must be able to reach Frigate over the network.

No MQTT broker is needed: the integration uses Frigate's own WebSocket.

## Configuration

Open the **Configuration** tab of the integration and fill in:

| Field                            | What to enter                                                                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frigate URL                      | `http://<frigate-ip>:5000` (internal port, no login) **or** `https://<frigate-ip>:8971` (authenticated port).                                               |
| Username / password              | Only for port 8971. Use an **admin** Frigate user: Frigate only accepts the detection / recordings / snapshots commands from admins.                        |
| Accept a self-signed certificate | Port 8971 serves a self-signed certificate by default. Enable this option only if Frigate is on your local network.                                         |
| Snapshot interval                | How often camera images are refreshed in Gladys (seconds, `0` to only fetch images on demand). Gladys accepts at most one image every 5 seconds per camera. |
| Snapshot height                  | Height of the images. They are reduced automatically to stay under the 150 KB limit of Gladys.                                                              |

Save, then click **Test the connection**: the Frigate version and the number
of cameras are shown under the button.

> Port 5000 has no authentication at all: only expose it to a trusted network
> (or to the Docker network shared with Gladys).

## Devices

Open the **Discovery** tab: every Frigate camera is listed. Click **Create**
on the ones you want. Each camera device carries:

- **Image**: the latest frame, shown on the dashboard camera widget;
- **Motion**: Frigate's motion detection (on / off);
- **one counter per tracked object** (`person`, `car`…): how many are in view;
- **Object detection**, **Recordings** and **Snapshots**: switches mirroring
  the Frigate toggles of the camera.

New cameras added to Frigate later show up after a new scan from the
**Discovery** tab.

## Scenes

Three triggers are available in the scene editor, under **Integrations**:

- **Frigate: object detected** — a new object is tracked. Filter by camera
  and object label (e.g. `person`).
- **Frigate: object enters a zone** — an object enters a zone defined in
  Frigate. Filter by camera, zone and label.
- **Frigate: new alert or detection** — Frigate opens a review item. Filter by
  camera and severity (alert or detection). On an alert, the camera image is
  refreshed in Gladys right away.

The details of the event (label, sub label such as a recognized face or
plate, confidence, zones, Frigate ids) are available to the following steps of
the scene as variables. Combine them with the camera actions of Gladys to
send yourself the snapshot.

## Troubleshooting

- **"Frigate X is not supported"**: update Frigate to 0.18 or later.
- **"Frigate refused the connection"**: check the username and password, and
  that the URL uses port 8971.
- **"The Frigate TLS certificate is not trusted"**: enable _Accept a
  self-signed certificate_, or install a valid certificate on Frigate.
- **Switches do not change**: the Frigate user must have the `admin` role.
- **"Cannot reach Frigate"**: check the URL from the Gladys host
  (`curl http://<frigate-ip>:5000/api/version`). The integration retries on
  its own every 30 seconds.

The integration logs are available from the **Configuration** tab
(supervision controls, **View logs**).
