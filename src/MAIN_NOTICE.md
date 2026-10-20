# Existing-session notification adapter

Read and update this file whenever changing `main-notice.ts` or
`main-notice-bridge.ts`.

- Central CLI owns business instructions, identities and persistent notification state. This plugin only adapts exact OpenClaw session routing, native execution and result delivery.
- OpenClaw 2026.9.4+ is the source-checked native API baseline. Check runtime methods and the public harness/transcript modules before advertising capability. Older or incomplete hosts return unsupported; ordinary plugin features retain their existing compatibility.
- Gateway methods: `eigenflux.main.capabilities` and `.inspect` use `operator.read`; `.notify` uses `operator.write`. Standard Gateway authentication applies. The bridge invokes the owner's installed OpenClaw JS CLI entry with Node, shell disabled, preserving its host profile/config environment. It does not expose a new HTTP listener.
- `initialize` advertises `agentCapabilities._meta["ai.eigenflux.mainConversation"] = {version:1,host:"openclaw",existingSession:true,hiddenInput:true,resultOnly:true}` only after a positive Gateway capability response.
- `_eigenflux/main/inspect({sessionId,cwd})` returns exactly `{sessionId,host,cwd,state,existingSession,hiddenInput,resultOnly}`. `sessionId` is a canonical `agent:<agentId>:...` key. Read that existing entry only; canonicalize the existing configured workspace with realpath and require the exact bound directory. Reject missing/archived/replaced identities. Busy inspection checks the native foreground/embedded active-run projection, task records and the adapter guard. Abort only this owned run if native onLaneWait detects a check/start race; never defer it behind another run.
- `_eigenflux/main/notify({sessionId,cwd,requestId,prompt})` returns exactly `{sessionId,requestId,runId,stopReason:"end_turn",text,existingSession,hiddenInput,resultOnly}`. Only those methods and initialize are supported; no session/new, session/load, session/prompt or cancellation fallback exists.
- Pin the native entry's session ID inside `runWithWorkAdmission`, then run `agent.runEmbeddedAgent` with that `sessionTarget`, durable persistence, a new run ID and the admission AbortSignal. Keep the host's normal per-session serialization; do not put a second writer on a separate lane for the same transcript.
- Split the central prompt at `UNTRUSTED COMMISSION EVENT`. Pass rules as `runtime-instruction` and JSON as `conversation-data` runtime fragments. Use the host's fixed nonempty runtime-event carrier `prompt`, empty `transcriptPrompt` and `suppressNextUserMessagePersistence:true`; an empty prompt would be skipped by the builtin runner. The carrier is also excluded from user persistence; this is the SDK's actual hidden-context path, not ACP metadata.
- Await the owned run. Reject errors, aborts, timeouts, yielded/continuing work, tool-only stops, empty or raw echoed results. Persist only its final visible text with `appendAssistantMirrorMessageByIdentity`; the SDK deduplicates an equivalent native final. Require its positive message-ID receipt, then publish the exact transcript update. Do not report queueing or an empty refresh as delivery.
- Each request ID is bound to its exact native session, workspace and prompt hash. Claim the active-session guard and receipt synchronously after async native preflight. Replay the same completed receipt; never rerun pending or uncertain requests. Keep at most 1,024 receipts per Gateway lifetime and reject overflow. The central CLI must retain its own durable no-replay journal across host restarts.
- The owned run has a 120-second abort budget. Client disconnection/timeout does not call session cancel or cancel another user's run. Do not log prompts, Gateway configuration, tokens or raw upstream diagnostics.
- Required fixtures cover exact target, missing/archived/busy/replaced entries, native hidden-input fields, visible final receipt, uncertainty/idempotency, strict stdio methods and no prompt echo. Native UI behavior on macOS and Windows is still untested.

Source evidence (OpenClaw 2026.9.4): public `docs/plugins/sdk-runtime/agent.md`,
`runtime-embedded-agent.runtime` admission wrapper, `runtime-context-prompt` hidden
custom message (`display:false`), and `session-transcript-runtime` scoped mirror
and publication. The generic ACP server calls `chat.send` and records user
prompts; its provenance rejection can fall back to ordinary input, so it is not
used by this adapter.
