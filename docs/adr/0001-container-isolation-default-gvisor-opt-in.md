# Container isolation is the default, gVisor is an operator opt-in

Sandboxes run with isolation class `container` (Docker with runc, non-root, no privileges, seccomp) by default; `gvisor` is an equally supported option the operator selects per `SandboxTemplate`. The choice lies with the operator because the right trade-off depends on the deployment: on a dedicated VM that only hosts sandboxes, the VM is already the outer isolation boundary, while hosts that also run the control plane or process untrusted content (public issues, web pages) should use `gvisor`. The documentation states the consequences and recommendations clearly instead of the platform enforcing one model.

## Considered Options

- **gVisor as mandatory default** (previous plan): strongest isolation, but `runsc` only runs on Linux. It is unsupported on Docker Desktop for Windows and macOS (see google/gvisor#11370, #11238), which would make the laptop profile depend on fragile workarounds.
- **Container by default, gVisor opt-in** (chosen): runs everywhere Docker runs, including plain Docker Compose; stronger isolation stays one template field away.

## Consequences

- `container` shares the host kernel; a kernel exploit from inside a sandbox reaches the host. Operators choosing it accept this and should add an outer boundary (dedicated VM, separate worker host).
- The sandbox adapter needs Docker API access to create sandboxes at runtime. It must not get the raw Docker socket; access goes through a restricted socket proxy.
- The walking skeleton proves the sandbox path with `container`; `gvisor` is verified once on a Linux host during hardening.
