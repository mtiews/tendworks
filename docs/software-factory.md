# Software Factory on Tendworks

Oct 18, 2026 · @Marcel

This document describes what the software factory is meant to do. How the underlying platform is built is covered in "Tendworks – Platform Architecture". The factory is the content; the platform is the tool.

**Name:** Tendworks (short: Tend) is the platform this factory runs on; its command line is `tend`, its domain `tendworks.dev`. The software factory is one application of Tendworks: the first and driving one, but not the only one. Tendworks is use-case neutral, so the factory must not need any factory-specific platform code; everything here is expressed as configuration on generic platform capabilities.

## Definition

For us, a software factory is a repeatable, largely autonomous value stream that turns an idea into working, delivered and operated software. Roles, artifacts and quality gates are explicitly defined, and humans are only involved for real decisions.

**It is:**

- a set of workflows, role profiles, artifact types and policies, i.e. pure configuration on the platform
- reusable across projects and adaptable per project
- measurable: lead time, quality, cost and human interventions are visible

**It is not:**

- a single coding agent working through tickets
- a replacement for product ownership: a human still decides what gets built
- tied to a specific model, harness or vendor

## What defines it: guiding principles

1. **Human attention is the scarcest resource.** It is spent at the start of the chain (requirements, specification), not on reading code.
2. **Validate first, then build.** A requirement is checked for sense, consistency and feasibility before it is implemented.
3. **Evidence over trust.** Every stage delivers its result together with evidence. Only what the evidence supports moves on.
4. **Separate author and reviewer.** Whoever creates something does not review it; ideally with a different model or harness.
5. **Small, reversible steps.** Small changes, feature flags, automatic rollback.
6. **Autonomy is earned.** It grows per workflow based on the measured hit rate, not by flipping a switch.
7. **Everything is traceable.** Every decision, objection and approval is stored with its reasoning and is readable.

## Value stream from idea to operation

The value stream has seven stages. Each stage takes artifacts in, produces new ones and ends at a gate. Going back (e.g. from verification back to specification) is explicitly allowed.

| Stage | Role(s) | Input | Output artifact | Gate |
| --- | --- | --- | --- | --- |
| 1. Capture idea | Product Owner | idea, ticket, feedback | problem statement | — |
| 2. Validate requirement | Analyst, Critic, Architect | problem statement | validated requirement with objections | human, if findings are unclear |
| 3. Specify | Analyst, Test Designer | validated requirement | specification + executable acceptance criteria | human approves specification |
| 4. Design | Architect | specification | design note, ADR if needed | automatic, except for architecture changes |
| 5. Implement | Developer | specification, design | pull request | evidence complete |
| 6. Verify | Reviewer, QA | pull request | evidence bundle | policy based on evidence |
| 7. Deliver and operate | Ops | verified state | release, monitoring findings | canary metrics, automatic rollback |

Operational findings (errors, usage data) flow back into stage 1 as new ideas. That closes the loop.

## Factory roles

Roles are agent profiles with a clear responsibility. A role may not approve its own result.

| Role | Responsibility | Must not |
| --- | --- | --- |
| Product Owner (human, assisted) | decides what gets built and prioritizes | — |
| Analyst | shapes problem statement, requirement and specification | write code |
| Critic | argues against the requirement, looks for simpler alternatives | change requirements itself |
| Architect | checks feasibility, writes design notes and ADRs | approve implementation |
| Test Designer | turns the specification into executable acceptance criteria | see the implementation before the tests exist |
| Developer | implements, opens the pull request | weaken its own tests afterwards |
| Reviewer | checks the diff against specification and evidence | change the code it reviews |
| QA | runtime tests in the preview environment | — |
| Ops | delivery, monitoring, rollback | change code |

## Quality: validating requirements and verifying results

The biggest gap in today's software factories is not code generation but proof that a result is fit for purpose, and before that, that the requirement makes sense at all. Quality is therefore built in two stages.

**A. Validate requirements**

- **Problem and value:** Which problem, for whom, and how is success measured? Without a measurable success metric, the factory asks back.
- **Consistency:** Does it contradict existing requirements, ADRs or policies? Duplicates?
- **Completeness and clarity:** Are edge cases, error behavior and non-goals named? Ambiguous terms are flagged.
- **Feasibility:** Effort, risk, affected components; a small spike if needed.
- **Counter-position:** The Critic proposes simpler alternatives, including "don't build it".

If the findings remain unclear, you are asked, with the objections presented as options.

**B. Verify results**

1. **Acceptance criteria first**, written by the Test Designer, not the Developer.
2. **Deterministic checks:** build, types, linter, tests, security and license scans.
3. **Test quality:** mutation testing and property-based tests.
4. **Independent review** with a different model or harness, including a scope check of the diff against the ticket.
5. **Runtime behavior** in a short-lived preview environment with end-to-end tests.
6. **Progressive delivery** with feature flags, canary and automatic rollback.

All findings end up as evidence in the evidence bundle of the respective change. The policy uses this evidence to decide whether a human is asked.

## Autonomy levels

Autonomy is set per workflow and per stage, and only increases when the measured hit rate justifies it.

| Level | Behavior | Promotion when |
| --- | --- | --- |
| 0 – Assisted | agents propose, a human executes | — |
| 1 – Approve every change | agents implement, every change is approved | level starts here |
| 2 – Approve by risk | only risky changes are presented | hardly any overrides over a defined period |
| 3 – Exceptions | human only for hard gates and unclear findings | rollbacks and production errors stay below threshold |

Every human override is stored with its reasoning. This yields the hit rate, and policies and role profiles learn from it. Concrete thresholds are still open.

## Derived platform requirements

The factory only needs generic capabilities from the platform. None of them is factory-specific; the same capabilities serve other use cases as well.

| Factory need | Platform capability | In the platform document |
| --- | --- | --- |
| value stream with stages and loops back | declarative, durable workflows | Orchestration |
| roles with separate responsibilities | agent profiles, different harnesses and models | Agent Runtime |
| a role may not approve its own result | policy rules on author and reviewer | Human Interaction / Policies |
| artifacts between stages | typed artifacts with provenance | Artifacts, data model |
| evidence per change | evidence bundle as artifact type, standard formats | Data model (`EvidenceBundle`) |
| gates and questions | approvals, notifications, input-required | Human Interaction |
| preview environments, spikes | sandboxes with exposed ports | Sandbox |
| earning autonomy | storing overrides, metrics per workflow | Data model (`Override`) + telemetry |
| progressive delivery | integration with deploy tools via MCP or events | Integrations |
| traceability | readable run journal, audit events | Storage and formats |

**Validation result:** The platform covers all needs. The `EvidenceBundle` and `Override` objects were added to the data model.

## Reuse across projects

The factory is not copied per project but maintained as a versioned blueprint. A project includes it and adapts it only through parameters and overrides.

- **Blueprint:** the factory's workflows, role profiles, policies, skills and artifact types, published with a version.
- **Project file:** name and version of the blueprint, parameters (repo, language, budgets, autonomy level) and targeted overrides.
- **Updates:** factory improvements arrive as a version bump; a project can deliberately stay on a version.
- **Variants:** specialized factories (e.g. web app, library) inherit from a shared base.

The first factory is configured directly. The blueprint mechanism follows as soon as a second project comes along; the platform is prepared for it.

## Open questions

- [ ] Which kinds of projects should the first factory cover (e.g. web apps, libraries, internal tools)?
- [ ] Is the Product Owner always a human, or may an agent prioritize small improvements on its own?
- [ ] Which thresholds apply for promotion between autonomy levels?
- [ ] Where does the factory end: at release, or does operation at the customer belong to it?
- [ ] How are customer feedback and operational findings fed into stage 1?
