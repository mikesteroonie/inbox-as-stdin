# Email-native coding harness — design spec

**Status:** Proposal. No code yet. The harness consumes the public AgentMail API + SDK behind a
normal API key — the tutorial reader runs the exact code path we do.

**One-line pitch:** a daemon that gives a coding agent an email address — tasks arrive as mail,
patches leave as replies, and when the agent hits code it doesn't understand it emails the person
`git blame` names, parks the task, and resumes when they answer.

## 1. Problem

Every coding harness today (Claude Code, Codex CLI, Cursor) assumes a TTY and a human present
*right now*. Two consequences:

1. **Agents block on humans synchronously.** When an agent needs a decision, the only channels are
   "ask in the terminal" (requires the requester to be watching) or "guess" (produces confident,
   wrong code). The person who actually knows the answer — often the original author of the
   confusing code — is reachable by no channel at all.
2. **Agent-to-agent and agent-to-human coordination has no boundary-crossing transport.** A2A/MCP
   cover agent↔tool and agent↔agent inside one system, both parties online. Neither has a story
   for reaching a human on their phone, or an agent in another org, hours later.

Email solves both. OpenAI's unreleased **Botmail** (surfaced in Codex as
`mcp__codex_apps__botmail__agent_email`) validates the primitive but stops at layer 2: one claimed
address per user, polling-only reads (`list_messages`), no threads/labels/webhooks/WS in its tool
surface, and a hard human-confirmation gate on every send. It structurally cannot host an
autonomous loop. The layer above it — the harness — is unbuilt by anyone. Whoever ships it defines
the pattern; the infra underneath it is what gets adopted by default.

## 2. Layering (the load-bearing design decision)

```
3. Harness   — wake on email → run coding agent → reply     ← this project
2. Identity  — claim address, read/send from inside agent    ← Botmail; AgentMail MCP/SDK
1. Infra     — SES, inbox rows, threads, webhooks, WS        ← AgentMail API
```

The harness is **a coding harness hosted inside a daemon**, and the two are kept strictly
separate:

- **Daemon** (~300 lines, no LLM): holds the WebSocket, subscribes `POD#<id>` with
  `event_types: ['message.received']`, dedupes by `message_id` (SES redelivers), parses the
  protocol envelope from headers, enforces hop/budget caps, routes to an agent, reconnects on
  drop, survives restarts via a local SQLite journal.
- **Harness** (all the product value): per-thread agent session (Claude Agent SDK), per-task git
  worktree, tool loop, permission policy, git-blame outreach, patch/PR production.

Boundary test, enforced in review: swapping the daemon for a Lambda-behind-webhook must not touch
harness code; swapping the Agent SDK for another must not touch daemon code. Transport goes behind
a `MailTransport` interface with AgentMail as the only complete implementation (webhook/WS wake-up
is the capability competitors' layer-2 products lack — the interface is what makes the project an
open pattern rather than a vendor demo).

## 3. Mapping to AgentMail primitives

| Harness concept | AgentMail primitive |
|---|---|
| Agent identity | inbox (`POST /inboxes`); per-inbox API key so a compromised agent reads only its own mail |
| Swarm/project scope | pod; WS `subscribe` and webhooks both scope by `pod_id` |
| Session | `thread_id`; thread doubles as the human-legible audit log |
| Wake-up | WS `subscribe` (laptop, no tunnel) or `message.received` webhook (deployed) |
| Protocol envelope | custom send `headers` (`x-harness-proto`, `x-task-id`, `x-hops`, `x-in-reply-to-question`) |
| Workflow state | thread `add_labels`/`remove_labels` (`state/awaiting-human`, `state/replied`) |
| Artifacts | attachments (patch.diff, test logs) |
| Untrusted-input gate | Agent Armor verdicts; `hold_until_scanned` on agent inboxes |
| Delivery truth | subscribe to `message.bounced`/`message.rejected` too — delivery is not success |

## 4. The flagship flow: git-blame outreach

The demo that sells the whole thing, end to end:

1. Requester emails `backend@…` a task from their phone.
2. Harness opens a worktree keyed by task, starts a session keyed by thread.
3. Agent hits ambiguous code → `git log -L <lines>:<file>` → author, sha, date.
4. **Permission gate — itself an email.** Harness emails the *requester*: "may I ask
   <author> why <one specific question>? [yes / no / skip]". Terminal prompts would collapse the
   async property; the gate must ride the same channel.
5. On "yes": email the author, **CC the requester** (the recipient must never wonder who set the
   agent loose), clear agent identity in the body, `reply 'skip' and I'll best-guess` escape
   hatch. Label thread `state/awaiting-human`, park the task, sleep.
6. Reply arrives → `message.received` → resume session with the answer → finish → PR → reply on
   thread with the link.
7. **Cache the answer** keyed to file + line range, committed to the repo as a decision record.
   The second agent asks the cache, not the human. This is the compounding asset.

### Permission tiers (default-deny)

| Tier | Covers | Policy |
|---|---|---|
| Auto | replies within an in-progress thread; agent↔agent inside own pod | no ask |
| Ask | first contact with an internal human (blame result on allowlisted domain) | email requester, wait |
| Never | any address outside allowlisted domains | hard refuse, log |

Plus etiquette limits, non-negotiable: per-person rate limit (default 3 questions/person/week,
batched into one email), bounce → fall back to next-most-recent author of the region or give up
loudly, and the human's reply is still untrusted input (fenced as data in the prompt, Armor
scanned).

### Loop and spend guards (built first, before any agent code)

Hop counter in headers (cap ~6), per-task token/USD budget, participant cap per thread,
dead-thread TTL, idempotency journal. Two polite agents will thank each other forever otherwise.

## 5. Deliverable

`npm i -g @agentmail/harness`; `harness init` (claims inboxes, writes `harness.yaml`);
`harness up` (the daemon — the product running). Subcommands `send`, `tail`, `doctor` for
screencast ergonomics. **No UI** — the interface is the user's existing mail client. Explicit
non-goals for v1: hosted service, chat UI, replacing interactive harnesses.

`harness.yaml` holds the roster (per-agent inbox, prompt, tool grants, repo), allowlisted
domains, budgets, tier overrides.

## 6. Milestones

1. **Echo** (~½ day): one inbox, WS subscribe, canned reply. Proves daemon loop + reconnect.
2. **Solo coder** (~1 day): Agent SDK + worktree; task in, patch attachment back.
3. **Blame outreach** (~2 days): permission gate, park/resume, answer cache. **Flagship demo.**
4. **Two agents** (~1–2 days): `send_email_to_agent` tool, hop caps, thread-keyed sessions.
5. **Swarm + hardening** (~2–3 days): pod-scoped roster, label state machine, Armor gating,
   bounce handling, budgets enforced end-to-end.

Milestone 3 is the tutorial's centerpiece (agent↔human is the differentiated story; agent↔agent
demotes to a section). MCP server for `send_email_to_agent` falls out of milestone 4 as a
byproduct so Claude Code users can join a swarm without running the daemon.

## 7. Open questions

- **Q1 — envelope headers.** Do custom `headers` survive the full SES round-trip inbox→inbox
  today (send path accepts them; verify receive path preserves them)? If not, fall back to a
  structured trailer block in the body. Needs a 30-minute spike against staging.
- **Q2 — per-inbox API keys** (`POST /inboxes/{inbox_id}/api-keys`): confirm permission scoping
  is sufficient for the one-key-per-agent blast-radius story.
- **Q3 — answer-cache format.** Committed `DECISIONS.md` vs. structured sidecar
  (`.harness/answers.jsonl`). Leaning jsonl + rendered markdown.
- **Q4 — dogfood target.** First real repo the harness runs against, and which internal humans
  opt into the blame allowlist.
