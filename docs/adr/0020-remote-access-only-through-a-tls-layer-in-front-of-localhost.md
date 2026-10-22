# Remote access goes only through a TLS layer in front of the localhost-bound server

The server keeps binding to `127.0.0.1`. The operator reaches the web UI, the API and `tend` from other devices only through a TLS layer that runs in front of that port on the same host, never as plain HTTP on the network. The API token stays the sign-in until OIDC (ADR 0018). The recommended layer is Tailscale on the host (`tailscale serve`): HTTPS with a certificate the operator's devices trust, reachable only from the operator's tailnet, no port opened on the local network and no change to the platform. A reverse proxy with the operator's own domain and certificate is the documented alternative without a third party. Neither is part of the platform code or the compose stack.

This extends ADR 0018, which kept the stack on localhost until TLS and OIDC. The operator wants the UI from a phone on the home network, where an SSH tunnel is impractical.

## Considered Options

- **Publish the server on the LAN over HTTP**: every request carries the API token in clear text over Wi-Fi.
- **TLS inside the server**: certificates, renewal and a public name become platform concerns; a layer in front does this better and stays replaceable.
- **A reverse proxy as a compose profile with an internal CA**: every device has to trust a private root certificate, which is fiddly on phones; the LAN reaches the sign-in page.
- **SSH tunnel only**: safe, but impractical on a phone.

## Consequences

- The token still lives in the browser (ADR 0018). With remote access, a stolen device or a compromised tailnet member reaches the full UI until the token is rotated. The operator guide covers rotation.
- Anyone who can reach the TLS layer reaches the sign-in page. With Tailscale that is only the operator's devices; with a reverse proxy on the LAN, everyone on the network.
- The platform needs no change. It must keep working behind a proxy on another host name: its redirects and links stay relative, and the CSP stays same-origin.
- OIDC replaces the token sign-in later, behind the same TLS layer.
