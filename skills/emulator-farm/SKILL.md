---
name: emulator-farm
description: Set up and run Android emulators in Docker on a Linux server with KVM, connect them to adb and share them through agentthumbs. Use when the user wants several Android phones on a server, a clean phone per run, or a device farm without physical phones.
---

# Android emulators in Docker

You have a shell on a Linux server. The goal: N Android emulators running in containers, each visible to adb, and `agentthumbs serve` sharing them with a relay. Run every command yourself and check its result before the next step.

## 1. Check the host

Emulators need hardware virtualization. Without KVM they are too slow to use; do not try to work around it.

```bash
ls -l /dev/kvm                                   # must exist
egrep -c '(vmx|svm)' /proc/cpuinfo               # must be more than 0
sudo apt install -y cpu-checker && kvm-ok        # on Debian/Ubuntu: "KVM acceleration can be used"
```

If `/dev/kvm` is missing, stop and tell the user: the server is a VM without nested virtualization, and they need a bare-metal server or a VM type that exposes KVM. Most container platforms (Railway, Fly, Render, Heroku) cannot run emulators.

Also check:

- `docker info` works for the current user (otherwise use `sudo` or add the user to the `docker` group, with the user's consent),
- `adb version` works (`sudo apt install -y adb`),
- `agentthumbs --help` works (`npm install -g @appeeky/agentthumbs`, Node.js 20 or newer),
- free memory: plan 3 GB and 2 CPU cores per emulator. `free -g` and `nproc` tell you how many fit. Tell the user the number before starting more than they asked.

## 2. Start the emulators

The community image `budtmo/docker-android` runs the Android emulator and exposes adb on port 5555. Tags are `emulator_<android version>`, for example `emulator_14.0` (API 34). Give each container its own name and its own host port for adb, bound to localhost:

```bash
for i in 1 2 3; do
  docker run -d --name emu-$i --device /dev/kvm \
    -p 127.0.0.1:$((5554 + i)):5555 \
    -e EMULATOR_DEVICE="Samsung Galaxy S10" \
    -v emu-$i-data:/home/androidusr \
    budtmo/docker-android:emulator_14.0
done
```

- `-v emu-$i-data:/home/androidusr` keeps each phone's apps and accounts across restarts. Leave it out when every run should start from a clean phone.
- The `127.0.0.1:` prefix matters: without it Docker publishes the port on every interface, and anyone who reaches the server gets full control of the phone through adb.
- Add `-e WEB_VNC=true -p 127.0.0.1:$((6079 + i)):6080` only if a person needs to watch a phone in the browser; they reach it through an SSH tunnel.

## 3. Wait until each one has booted

Booting takes one to three minutes. Each container writes its state to `device_status`:

```bash
for i in 1 2 3; do
  until [ "$(docker exec emu-$i cat device_status 2>/dev/null)" = "READY" ]; do sleep 5; done
  echo "emu-$i ready"
done
```

The states are CREATING, STARTING, BOOTING, RECONFIGURING and READY. If one stays before READY for more than five minutes, read `docker logs emu-$i` and report what it says.

## 4. Connect adb

```bash
for i in 1 2 3; do adb connect localhost:$((5554 + i)); done
adb devices
```

Every emulator must show as `device`. `offline` usually means it is still booting; wait and run `adb connect` again.

## 5. Check agentthumbs sees them

```bash
agentthumbs devices
agentthumbs observe --device adb:localhost:5555
```

The first observe should show the Android home screen.

## 6. Share them

When the user has a relay, run the connector as a service; see the systemd unit in the device farm guide (`docs/guides/device-farm.mdx`). The relay token goes in an environment file readable only by the service user, never on the command line in shell history.

## Preparing the phones

Emulators start empty: no Google account, no apps.

- Apps from the Play Store need a Google account signed in on that emulator. The user signs in, or gives you credentials for a test account; never use their personal account without asking. With the volume from step 2, they sign in once per emulator.
- Some apps refuse to run on emulators (many banking apps, some games). If an app closes or shows a "device not supported" screen, report it; do not try to hide that the phone is an emulator.

## Scaling and cleanup

- **More emulators:** repeat steps 2 to 4 with the next numbers.
- **Restart one:** `docker restart emu-2`, wait for READY, `adb connect localhost:5556`.
- **Fresh phone:** `docker rm -f emu-2 && docker volume rm emu-2-data`, then start it again.
- **Remove all:** `docker rm -f $(docker ps -aq --filter name=emu-)`. Ask before deleting volumes; they hold the signed-in accounts.

## Rules

- Never run a container without `--device /dev/kvm` "to make it work"; it will not be usable.
- Do not open adb (5555+) or VNC (6080+) ports to the internet. adb gives full control of the phone with no password.
- Report the final state: how many emulators, their adb ids, and memory left.
