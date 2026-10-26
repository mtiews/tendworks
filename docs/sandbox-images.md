# Sandbox images with your own tooling

Agents run in sandboxes created from a sandbox image. The image `tendworks/sandbox-claude-code` carries the harness and the basics (git, the GitHub CLI), but no toolchain for your projects. This guide shows how to build an image with additional development tooling on top of it, and how to hand it to an agent. The worked example is mobile app development with Flutter and Dart.

Read the [operator guide](operator-guide.md) first; this guide assumes a running installation and your own configuration repository.

## Contents

- [How the pieces fit](#how-the-pieces-fit)
- [What a derived image must keep](#what-a-derived-image-must-keep)
- [Where the image lives](#where-the-image-lives)
- [Example: Flutter and Dart](#example-flutter-and-dart)
- [Android builds](#android-builds)
- [Updates](#updates)
- [Troubleshooting](#troubleshooting)

## How the pieces fit

```text
image (your Dockerfile, FROM tendworks/sandbox-claude-code)
  └─ SandboxTemplate  sandboxes/<name>.yaml   names the image, isolation class, resources
       └─ AgentProfile  agents/<name>.md      harness claude-code, sandbox <name>
```

- **Build on top of `tendworks/sandbox-claude-code`, don't start from scratch.** The harness `claude-code` expects what that image provides (see [below](#what-a-derived-image-must-keep)); a derived image inherits it and only adds tooling.
- **No platform change is needed.** A new toolchain is configuration: one image, one sandbox template, one or more agent profiles.
- **One image per toolchain**, not one image with everything. Smaller images build faster, and each agent gets only what its work needs.

## What a derived image must keep

| What | Why |
| --- | --- |
| The ACP adapter `claude-agent-acp` on `PATH` (`/opt/harness/node_modules/.bin`) | the harness starts it in the sandbox. Don't reset `PATH`; extend it |
| User `1000:1000` as the last `USER`, and every directory your tooling writes to owned by it | every process runs as the template's user (default `1000:1000`, root is refused) |
| `/workspace` and `/session` owned by `1000:1000` | both are mounted as volumes per agent session; an empty volume takes over the ownership of the directory in the image |
| `sleep` | the sandbox's main process is `sleep infinity`; `ENTRYPOINT` and `CMD` of the image are ignored |

Keep in mind:

- **`HOME` is `/session/home`, a fresh volume per session.** Anything a tool writes to `HOME` during the image build (caches, settings, logins) is hidden in the sandbox. Put caches and settings in directories of their own and point the tool there with `ENV` (as `PUB_CACHE` below).
- **The platform never pulls images.** Build the image on the sandbox host; the base image must be there too.
- **No secrets in the image.** Anyone who can read the image can read them. Agents get repository credentials from their workspace and other secrets from the agent profile (`spec.env` with secret references, [operator guide](operator-guide.md#secrets)).
- **Pin everything:** the base image by its exact tag, each tool by its exact version, downloads by their checksum.

## Where the image lives

**Not in the Tendworks repository.** The platform stays generic; application tooling belongs to your installation.

- **Recommended:** a repository of its own (e.g. `tendworks-images`), one directory per image.
- **Not inside the configuration directory** (`TEND_CONFIG_PATH`) without care: the loader reads every YAML file below it, so a `compose.yaml` or other YAML next to the Dockerfile stops the server (`neither a workflow nor a document with a kind`). A Dockerfile alone is ignored.
- **Name the image outside `tendworks/`**, e.g. `local/sandbox-flutter`. The `tendworks/` images are the deployment's own, whose pins the worker fills in.

## Example: Flutter and Dart

Goal: an agent that works on Flutter apps (`flutter analyze`, `flutter test`, `dart format`, web builds), without Android or iOS builds.

### 1. Dockerfile

`tendworks-images/sandbox-flutter/Dockerfile`:

```dockerfile
# Sandbox image for Flutter and Dart work, on top of the Tendworks Claude Code image.
# Build it on the sandbox host after the base image (--profile sandbox-images build):
#   docker build --build-arg BASE=tendworks/sandbox-claude-code:0.85.1-2 \
#     -t local/sandbox-flutter:3.47.8-0.85.1-2 .
ARG BASE=tendworks/sandbox-claude-code:0.85.1-2
FROM ${BASE}

# Flutter SDK, pinned; version and checksum from
# https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json
# The archive is built for x86-64 hosts.
ARG FLUTTER_VERSION=3.47.8
ARG FLUTTER_SHA256=baf7dcc5a3dbba60fe863bf493a6cf203195621f7786eaa5a1bba02cd0d87dd2

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip xz-utils zip libglu1-mesa \
 && curl -fsSL -o /tmp/flutter.tar.xz \
      "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz" \
 && echo "$FLUTTER_SHA256  /tmp/flutter.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/flutter.tar.xz -C /opt \
 && rm /tmp/flutter.tar.xz \
 && mkdir -p /opt/pub-cache \
 && chown -R 1000:1000 /opt/flutter /opt/pub-cache \
 && rm -rf /var/lib/apt/lists/*

# The pub cache lives in the image, not in HOME (a fresh volume per session), so
# packages fetched during the build stay available.
ENV PATH=/opt/flutter/bin:$PATH \
    PUB_CACHE=/opt/pub-cache

# Flutter writes its tool cache into the SDK directory, so it runs as the sandbox user.
USER 1000:1000
RUN flutter --version && flutter precache
WORKDIR /workspace
```

- The base image keeps `curl` out of the final layer; Flutter needs it at runtime too, hence the reinstall.
- Flutter and Dart keep their own settings (such as the analytics opt-out) under `HOME`, which is fresh in every session. Check in a session with `flutter config --list` what applies, and set it there or through the agent profile's instructions if it matters to you.

### 2. Build and check

On the sandbox host:

```sh
cd tendworks-images/sandbox-flutter
docker build --build-arg BASE=tendworks/sandbox-claude-code:0.85.1-2 \
  -t local/sandbox-flutter:3.47.8-0.85.1-2 .

# smoke test as the sandbox user, in a throw-away container
docker run --rm --user 1000:1000 -e HOME=/tmp local/sandbox-flutter:3.47.8-0.85.1-2 \
  sh -c 'cd /tmp && flutter create --platforms web demo && cd demo && flutter test'
```

The tag carries both versions (`<flutter>-<base tag>`), so you see at a glance which base an image was built on. Take the base tag from `x-sandbox-images` in `deploy/compose.yaml` of your installed release.

### 3. Sandbox template

`sandboxes/flutter.yaml` in your configuration:

```yaml
# Sandbox for Flutter and Dart work. Image built from tendworks-images/sandbox-flutter;
# its own image, so the tag is exact and updated by hand.
apiVersion: tendworks.dev/v1
kind: SandboxTemplate
metadata:
  name: flutter
spec:
  image: local/sandbox-flutter:3.47.8-0.85.1-2
  isolationClass: container
  resources:
    cpus: 4
    memoryMb: 8192
```

Flutter builds and the analyzer need more memory than the 4096 MiB of the starter template; size it to your projects.

### 4. Agent profile

`agents/flutter-developer.md` in your configuration, modelled on `developer`:

```markdown
---
apiVersion: tendworks.dev/v1
kind: AgentProfile
metadata:
  name: flutter-developer
spec:
  harness: claude-code
  sandbox: flutter
  model: claude-opus-5-5
  skills: [tdd]
  attribution: false
  chat: {}
---
You are a Flutter developer. You implement one issue per task in the repository checked
out in your working directory ...

- Before you answer, run `dart format --set-exit-if-changed .`, `flutter analyze` and
  `flutter test`, all in the foreground, and fix what they report.
```

The profile carries no repository credential: the repository and its token belong to the workspace the agent works on ([operator guide](operator-guide.md#workspaces)). `chat: {}` lets it also serve as a workspace assistant.

### 5. Workspace

`workspaces/my-app.yaml` in your configuration, with the Flutter profile as its assistant:

```yaml
apiVersion: tendworks.dev/v1
kind: Workspace
metadata:
  name: my-app
spec:
  git:
    url: https://github.com/<owner>/<flutter-repo>.git
    defaultBranch: main
  credentials:
    secretRef: { name: TENDWORKS_AGENT_MY_APP_TOKEN }
    env: GH_TOKEN
  assistant:
    enabled: true
    profile: flutter-developer
```

Then:

1. Add `TENDWORKS_AGENT_MY_APP_TOKEN` to `deploy/.env` and run `docker compose -f deploy/compose.yaml up -d`; restart server and worker so they read the new configuration: `docker compose -f deploy/compose.yaml restart server worker`.
2. Try it in a chat about the repository: `tend chat --workspace my-app` (read-only unless the workspace sets `assistant.write: true`, [operator guide](operator-guide.md#chats-and-assistants)).
3. Use it in workflows with `agent://flutter-developer` on the workspace, e.g. in a trigger binding with `workspaces: [my-app]`.

### Network

The sandbox needs the internet for `flutter pub get` (`pub.dev`, `storage.googleapis.com`) and for GitHub. Tendworks has no egress allowlist yet ([known gaps](operator-guide.md#known-gaps)); when it arrives, these hosts go into the template.

## Android builds

Android builds (`flutter build apk`, `appbundle`) need a JDK, the Android SDK and accepted SDK licenses. That makes the image several gigabytes larger, so build it as a second image on top of the Flutter one (`FROM local/sandbox-flutter:...`) with a template of its own (e.g. `flutter-android`), and give only the agents that build releases that template.

- Install the JDK from Debian (the base is Debian trixie) and the Android command-line tools from developer.android.com, pinned with their checksum; install the SDK packages (platform, build tools) with `sdkmanager` at fixed versions.
- Accepting the SDK licenses in the Dockerfile (`sdkmanager --licenses`) is your acceptance as operator; read them.
- Put `ANDROID_HOME` and the Gradle cache (`GRADLE_USER_HOME`) outside `HOME`, owned by `1000:1000`, for the same reason as `PUB_CACHE`.
- Give it at least 8 GiB of memory; Gradle is hungry.

Not possible in a sandbox:

- **iOS builds**: they need macOS and Xcode.
- **Emulators**: they need KVM inside the container, which breaks the isolation of an untrusted agent. Run device tests in CI or on real hardware.

## Updates

| Event | What you do |
| --- | --- |
| A Tendworks release changes the pin of `tendworks/sandbox-claude-code` (release notes, `x-sandbox-images`) | build the base image (operator guide, [Update](operator-guide.md#update)), rebuild your image with the new `BASE`, new tag, update `spec.image` in the template, restart server and worker |
| A new Flutter version | new `FLUTTER_VERSION` and `FLUTTER_SHA256`, rebuild, new tag, update the template |
| Old images | `docker image rm local/sandbox-flutter:<old tag>` once no sandbox uses it |

A derived image does not follow the base's pin by itself: it is built from one exact base tag. Until you rebuild, its agents keep the old harness.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `cannot create a sandbox from template flutter: image ... is not on the sandbox host` | the image was not built on this host, or the tag in the template differs from the built one (`docker image ls local/sandbox-flutter`) |
| `docker build` fails at `FROM`: image not found | build the base image first (`docker compose -f deploy/compose.yaml --profile sandbox-images build`) with the tag you pass as `BASE` |
| `Permission denied` under `/opt/flutter` or the pub cache | a directory is not owned by `1000:1000`; `chown` it in the Dockerfile |
| packages are downloaded again in every session | the cache sits under `HOME`; move it out with `ENV` (`PUB_CACHE`, `GRADLE_USER_HOME`) |
| the agent cannot start (`claude-agent-acp` not found) | `PATH` was overwritten instead of extended |
| the server stops with `neither a workflow nor a document with a kind` after adding the image | YAML from the image directory inside the configuration directory; move the image out ([Where the image lives](#where-the-image-lives)) |
